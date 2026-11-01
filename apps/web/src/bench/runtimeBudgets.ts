// Runtime budgets of the browser's speaking workflows (vox#43; docs/benchmarks/runtime-budgets.md).
//
// The same workflows as the desktop's `workflow_bench`, through the web app's own code:
//
// - record: the transcript and the recorder's pauses through the on-device incremental analysis
//   stream as they arrive (each segment partial first, then final); Stop (the stream's finish
//   with its batch oracle, then the batch analysis with the last 90 s of audio that becomes the
//   saved report); Save (the session list into localStorage, the kept audio into IndexedDB, the
//   local corpus analysis). Speech detection is unavailable off the desktop.
// - review: loading and validating every saved session, the corpus analysis, then each session's
//   kept audio.
// - import: an encrypted backup of every session decrypted, validated and restored.
//
// Deterministic work counters (`counters`) are kept apart from wall-clock times (`timings`):
// counters must stay proportional and are compared with a committed baseline; times are advisory.
import {
  AnalysisStream,
  type PauseSpan,
  type TranscriptSegment,
  createSessionRecord,
  observationFingerprint,
} from "@stutter-tracker/shared";
import type { LiveAnalysisWork } from "@stutter-tracker/shared";
import { analysisAudioPayload, analyzeWithFallback } from "../app/analysis";
import { analyzeLocalCorpus } from "../app/speechCorpus";
import { decryptBackup, encryptBackup } from "../storage/encryptedBackup";
import {
  loadSessionsFromStorage,
  replaceStoredSessions,
  saveSessionsToStorage,
} from "../storage/localStorage";
import { createSessionBackup, parseSessionBackup } from "../storage/sessionBackup";
import { getSessionAudio, putSessionAudio, retainSessionAudio } from "../storage/sessionAudio";
import type { SavedSession } from "../types";

export const MAX_SAVED_SESSIONS = 50;
export const RECORDER_CHUNK = 2_048;
export const ACOUSTIC_WINDOW_SECONDS = 90;
/** Events read per chunk row, beyond twice the event density; more means a rescan of history. */
export const MAX_CHUNK_EVENT_READS = 12;

export type BenchRecording = {
  id: string;
  sampleRate: number;
  samples: Float32Array;
  segments: Array<{ text: string; startSeconds: number; endSeconds: number }>;
};

export type Latency = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
};

export type RecordCounters = {
  sampleRate: number;
  audioSamples: number;
  segments: number;
  tokens: number;
  pauses: number;
  voiceActivity: string;
  stream: LiveAnalysisWork;
  streamParity: string;
  reportEvents: number;
  /** Samples handed to the batch analysis (the last 90 s, resampled to 16 kHz). */
  acousticSamples: number;
  /** UTF-16 code units of the whole session list written to localStorage on Save. */
  savedSessionListChars: number;
  savedSessionsInList: number;
  savedAudioSamples: number;
  corpusSessions: number;
};

export type RecordTimings = {
  streamUpdate: Latency;
  stopMs: number;
  stopStreamFinishMs: number;
  stopBatchMs: number;
  saveMs: number;
  saveListMs: number;
  saveAudioMs: number;
  saveCorpusMs: number;
};

export type ReviewCounters = {
  sessionsLoaded: number;
  sessionListChars: number;
  corpusSessions: number;
  audioOpened: number;
  audioSamplesRead: number;
};

export type ImportCounters = {
  sessions: number;
  backupChars: number;
  envelopeChars: number;
  kdfIterations: number;
};

export type BrowserReport = {
  schemaVersion: 1;
  platform: "browser";
  recordings: Array<{
    id: string;
    audioSeconds: number;
    counters: RecordCounters;
    timings: RecordTimings;
  }>;
  review: [ReviewCounters, { appOpenMs: number; corpusMs: number; audioOpen: Latency }];
  import: [
    ImportCounters,
    { exportMs: number; decryptMs: number; validateMs: number; restoreMs: number },
  ];
  violations: string[];
};

export type BenchOptions = {
  chunkSeconds: number;
  /** Called at each workflow boundary (`record:start`, `record:end`, ...), e.g. for CPU metrics. */
  mark?: (name: string) => Promise<void> | void;
  /** PBKDF2 iterations of the backup; the app's default unless a test lowers it. */
  backupIterations?: number;
  storage?: Storage;
};

export function latency(values: number[]): Latency {
  if (!values.length) return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, totalMs: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (q: number) =>
    sorted[Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * q))) - 1];
  return {
    count: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted[sorted.length - 1],
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
  };
}

/** The recorder's pauses, in f32 like the desktop: RMS above 0.025 is voice, > 0.75 s a pause. */
export function recorderPauses(
  samples: Float32Array,
  rate: number,
  segments: TranscriptSegment[],
): PauseSpan[] {
  const pauses: PauseSpan[] = [];
  let lastVoice = 0;
  for (let start = 0; start < samples.length; start += RECORDER_CHUNK) {
    const chunk = samples.subarray(start, start + RECORDER_CHUNK);
    let energy = 0;
    for (const sample of chunk) energy = Math.fround(energy + Math.fround(sample * sample));
    const rms = Math.fround(
      Math.sqrt(Math.fround(energy / Math.fround(Math.max(1, chunk.length)))),
    );
    const now = (start + chunk.length) / rate;
    if (rms > Math.fround(0.025)) {
      if (lastVoice > 0 && now - lastVoice > 0.75) {
        const after = [...segments].reverse().find((segment) => segment.endSeconds <= lastVoice);
        pauses.push({
          startSeconds: lastVoice,
          endSeconds: now,
          ...(after ? { afterText: after.text } : {}),
        });
      }
      lastVoice = now;
    }
  }
  return pauses;
}

const sameSegment = (left: TranscriptSegment, right: TranscriptSegment) =>
  left.text === right.text &&
  Object.is(left.startSeconds, right.startSeconds) &&
  Object.is(left.endSeconds, right.endSeconds) &&
  left.isFinal === right.isFinal;
const samePause = (left: PauseSpan, right: PauseSpan) =>
  Object.is(left.startSeconds, right.startSeconds) &&
  Object.is(left.endSeconds, right.endSeconds) &&
  left.afterText === right.afterText;

function commonPrefix<T>(left: T[], right: T[], same: (a: T, b: T) => boolean) {
  let index = 0;
  while (index < left.length && index < right.length && same(left[index], right[index])) index += 1;
  return index;
}

/** Sends what changed, like `useAnalysisStream`: unchanged input sends nothing. */
class StreamClient {
  seq = 0;
  sentSegments: TranscriptSegment[] = [];
  sentPauses: PauseSpan[] = [];
  updateMs: number[] = [];

  constructor(
    readonly stream: AnalysisStream,
    readonly runId: string,
  ) {}

  sync(segments: TranscriptSegment[], pauses: PauseSpan[]) {
    const segmentsFrom = commonPrefix(this.sentSegments, segments, sameSegment);
    const pausesFrom = commonPrefix(this.sentPauses, pauses, samePause);
    if (
      segmentsFrom === segments.length &&
      segmentsFrom === this.sentSegments.length &&
      pausesFrom === pauses.length &&
      pausesFrom === this.sentPauses.length
    ) {
      return;
    }
    const update = this.stream.push({
      runId: this.runId,
      seq: this.seq++,
      segmentsFrom,
      segments: segments.slice(segmentsFrom),
      pausesFrom,
      pauses: pauses.slice(pausesFrom),
    });
    if (update.status !== "live") throw new Error(`stream ${update.status}: ${update.reason}`);
    this.sentSegments = segments;
    this.sentPauses = pauses;
    if (update.changed) this.updateMs.push(update.processingMs);
  }
}

function tokenCount(segments: TranscriptSegment[]) {
  return segments.reduce(
    (sum, segment) => sum + segment.text.split(/\s+/).filter(Boolean).length,
    0,
  );
}

function startedAt(index: number) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `2026-01-01T00:${pad(Math.floor(index / 60))}:${pad(index % 60)}.000Z`;
}

async function record(
  recording: BenchRecording,
  index: number,
  sessions: SavedSession[],
  options: BenchOptions,
) {
  const storage = options.storage ?? localStorage;
  const runId = `bench-${index}`;
  const segments: TranscriptSegment[] = recording.segments.map((segment) => ({
    text: segment.text,
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    isFinal: true,
  }));
  const pauses = recorderPauses(recording.samples, recording.sampleRate, segments);

  const client = new StreamClient(new AnalysisStream({ runId }), runId);
  const arrivals = [
    ...segments.map((segment, position) => ({
      at: (Math.floor(segment.endSeconds / options.chunkSeconds) + 1) * options.chunkSeconds,
      isSegment: true,
      position,
    })),
    ...pauses.map((pause, position) => ({ at: pause.endSeconds, isSegment: false, position })),
  ].sort((left, right) => left.at - right.at);
  let shownSegments = 0;
  let shownPauses = 0;
  for (const arrival of arrivals) {
    const arrivedFrom = shownSegments;
    if (arrival.isSegment) shownSegments = Math.max(shownSegments, arrival.position + 1);
    else shownPauses = Math.max(shownPauses, arrival.position + 1);
    const partial = segments
      .slice(0, shownSegments)
      .map((segment, position) =>
        position >= arrivedFrom ? { ...segment, isFinal: false } : segment,
      );
    client.sync(partial, pauses.slice(0, shownPauses));
    client.sync(segments.slice(0, shownSegments), pauses.slice(0, shownPauses));
  }
  client.sync(segments, pauses);

  // Stop.
  const stopStarted = performance.now();
  const finished = client.stream.finish({ runId, segments, pauses });
  const stopStreamFinishMs = performance.now() - stopStarted;
  const batchStarted = performance.now();
  const audio = analysisAudioPayload(Array.from(recording.samples), recording.sampleRate);
  const analyzed = await analyzeWithFallback({ segments, pauses, ...audio });
  const stopBatchMs = performance.now() - batchStarted;
  const stopMs = performance.now() - stopStarted;

  // Save.
  const saveStarted = performance.now();
  const session = createSessionRecord({
    id: `uclass-${String(index).padStart(3, "0")}-${recording.id}`,
    startedAt: startedAt(index),
    segments,
    pauses,
    report: analyzed.report,
    run: {
      id: `run-${index}`,
      createdAt: startedAt(index),
      analyzer: analyzed.analyzer,
      usedAudio: analyzed.usedAudio,
      audioId: analyzed.audioId,
      inputId: observationFingerprint(segments, pauses),
    },
  }) as SavedSession;
  sessions.unshift(session);
  sessions.splice(MAX_SAVED_SESSIONS);
  const listStarted = performance.now();
  saveSessionsToStorage(sessions, storage);
  const saveListMs = performance.now() - listStarted;
  const savedSessionListChars = storage.getItem("stutter-tracker:sessions")?.length ?? 0;
  const audioStarted = performance.now();
  await putSessionAudio({
    sessionId: session.id,
    sampleRate: recording.sampleRate,
    samples: recording.samples,
    startOffsetSeconds: 0,
    discontinuities: [],
    droppedSeconds: 0,
    audioId: analyzed.audioId ?? "",
    keptAt: startedAt(index),
  });
  await retainSessionAudio(sessions.map((candidate) => candidate.id));
  const saveAudioMs = performance.now() - audioStarted;
  const corpusStarted = performance.now();
  const corpus = analyzeLocalCorpus(sessions);
  const saveCorpusMs = performance.now() - corpusStarted;
  const saveMs = performance.now() - saveStarted;

  const counters: RecordCounters = {
    sampleRate: recording.sampleRate,
    audioSamples: recording.samples.length,
    segments: segments.length,
    tokens: tokenCount(segments),
    pauses: pauses.length,
    voiceActivity: "unavailable: speech detection runs in the desktop app",
    stream: finished.work,
    streamParity: finished.parity.state,
    reportEvents: analyzed.report.events.length,
    acousticSamples: audio.samples?.length ?? 0,
    savedSessionListChars,
    savedSessionsInList: sessions.length,
    savedAudioSamples: recording.samples.length,
    corpusSessions: corpus.stats.sessions,
  };
  return {
    id: recording.id,
    audioSeconds: recording.samples.length / recording.sampleRate,
    counters,
    timings: {
      streamUpdate: latency(client.updateMs),
      stopMs,
      stopStreamFinishMs,
      stopBatchMs,
      saveMs,
      saveListMs,
      saveAudioMs,
      saveCorpusMs,
    },
  };
}

/** Same proportionality rules as the desktop's `record_violations`. */
export function recordViolations(id: string, counters: RecordCounters): string[] {
  const violations: string[] = [];
  const work = counters.stream;
  const check = (ok: boolean, message: string) => {
    if (!ok) violations.push(`${id}: ${message}`);
  };
  check(
    work.tokensAnalyzed === counters.tokens,
    `${work.tokensAnalyzed} tokens analyzed of ${counters.tokens}`,
  );
  check(
    work.segmentsAnalyzed === counters.segments,
    `${work.segmentsAnalyzed} final segments analyzed of ${counters.segments}`,
  );
  check(
    work.pausesAnalyzed === counters.pauses,
    `${work.pausesAnalyzed} pauses analyzed of ${counters.pauses}`,
  );
  check(
    work.segmentsRevisited === counters.segments && work.pausesRevisited === 0,
    `${work.segmentsRevisited} segment and ${work.pausesRevisited} pause positions revisited; only each segment's partial-to-final correction may revisit`,
  );
  check(work.fullRebuilds <= 1, `${work.fullRebuilds} full rebuilds`);
  if (work.reportChunks > 0) {
    const reads = work.chunkEventReads / work.reportChunks;
    const density = work.retainedEvents / Math.max(1, work.retainedSegments);
    check(
      reads < MAX_CHUNK_EVENT_READS + 2 * density,
      `${reads.toFixed(2)} event reads per chunk row at ${density.toFixed(2)} events per segment`,
    );
  }
  check(
    work.reportsBuilt === work.updates + 1,
    `${work.reportsBuilt} reports for ${work.updates} changing updates and the finish`,
  );
  check(counters.streamParity === "match", `live analysis parity ${counters.streamParity}`);
  check(
    counters.acousticSamples <= ACOUSTIC_WINDOW_SECONDS * 16_000,
    `batch analysis was sent ${counters.acousticSamples} samples`,
  );
  check(
    counters.savedSessionsInList <= MAX_SAVED_SESSIONS,
    `${counters.savedSessionsInList} sessions in the saved list`,
  );
  return violations;
}

/** Runs every workflow over the recordings, loaded one at a time, into empty storage. */
export async function runBrowserWorkflows(
  count: number,
  load: (index: number) => Promise<BenchRecording>,
  options: BenchOptions,
): Promise<BrowserReport> {
  const storage = options.storage ?? localStorage;
  storage.clear();
  await retainSessionAudio([]);
  const sessions: SavedSession[] = [];
  const recordings: BrowserReport["recordings"] = [];

  await options.mark?.("record:start");
  for (let index = 0; index < count; index += 1) {
    recordings.push(await record(await load(index), index, sessions, options));
  }
  await options.mark?.("record:end");

  await options.mark?.("review:start");
  const openStarted = performance.now();
  const loaded = loadSessionsFromStorage(storage);
  const corpusStarted = performance.now();
  const corpus = analyzeLocalCorpus(loaded);
  const corpusMs = performance.now() - corpusStarted;
  const appOpenMs = performance.now() - openStarted;
  const audioMs: number[] = [];
  let audioOpened = 0;
  let audioSamplesRead = 0;
  for (const session of loaded) {
    const started = performance.now();
    const audio = await getSessionAudio(session.id);
    audioMs.push(performance.now() - started);
    if (audio) {
      audioOpened += 1;
      audioSamplesRead += audio.samples.length;
    }
  }
  await options.mark?.("review:end");
  const review: BrowserReport["review"] = [
    {
      sessionsLoaded: loaded.length,
      sessionListChars: storage.getItem("stutter-tracker:sessions")?.length ?? 0,
      corpusSessions: corpus.stats.sessions,
      audioOpened,
      audioSamplesRead,
    },
    { appOpenMs, corpusMs, audioOpen: latency(audioMs) },
  ];

  // The backup is written first (export), then imported.
  const passphrase = "runtime budgets passphrase";
  const exportStarted = performance.now();
  const backupText = JSON.stringify(createSessionBackup(loaded, new Date(startedAt(0))));
  const envelope = await encryptBackup(
    backupText,
    passphrase,
    options.backupIterations ? { iterations: options.backupIterations } : {},
  );
  const exportMs = performance.now() - exportStarted;
  await options.mark?.("import:start");
  const decryptStarted = performance.now();
  const plaintext = await decryptBackup(JSON.parse(envelope), passphrase);
  const decryptMs = performance.now() - decryptStarted;
  const validateStarted = performance.now();
  const restored = parseSessionBackup(JSON.parse(plaintext));
  const validateMs = performance.now() - validateStarted;
  const restoreStarted = performance.now();
  replaceStoredSessions(restored, storage);
  await retainSessionAudio(restored.map((session) => session.id));
  const restoreMs = performance.now() - restoreStarted;
  await options.mark?.("import:end");

  const violations = recordings.flatMap((item) => recordViolations(item.id, item.counters));
  if (audioOpened !== loaded.length) {
    violations.push(`review opened ${audioOpened} kept captures of ${loaded.length}`);
  }
  if (restored.length !== loaded.length) {
    violations.push(`import restored ${restored.length} sessions of ${loaded.length}`);
  }
  return {
    schemaVersion: 1,
    platform: "browser",
    recordings,
    review,
    import: [
      {
        sessions: restored.length,
        backupChars: backupText.length,
        envelopeChars: envelope.length,
        kdfIterations: (JSON.parse(envelope) as { kdf: { iterations: number } }).kdf.iterations,
      },
      { exportMs, decryptMs, validateMs, restoreMs },
    ],
    violations,
  };
}
