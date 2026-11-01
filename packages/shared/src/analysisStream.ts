// Incremental transcript-and-pause analysis while recording, off the desktop (vox#154).
//
// The same stream as the desktop's (`apps/desktop/src-tauri/src/analysis_stream.rs`, vox#38), over
// the analysis this device runs: the shared fallback (`fallbackAnalyze`) is the oracle. Each
// update replaces the transcript segments from one position on and the pauses from one position
// on (an append replaces the empty tail). The stream analyzes only the new positions and keeps,
// per position, its events and running totals, so its report is the batch report of the same
// segments and pauses *without audio*, value for value:
//
// - every event, in the batch order (stable by start time, then segment events before pause
//   blocks, then position, then detector order) and with the batch's duplicate removal;
// - word count, durations, rates, severity, counts per kind, pause statistics and chunk rows.
//
// The tolerance is exact equality. Sums are kept as running folds in the batch's own order (a
// revision rewinds to the fold before the first replaced position), so no number is summed in a
// different order. `finish` checks this against the oracle on the final observation.
//
// Acoustic analysis is not part of the stream: its thresholds are medians over the whole
// analyzed window. It runs once after Stop in the batch report, which is the report saved.
import { ANALYSIS_CAPABILITIES } from "./analysisCapabilities";
import {
  buildBlockerStats,
  chunkWordsPerMinute,
  classifySeverity,
  countedWords,
  eventAppliesToSegment,
  isNearDuplicate,
  meanFinite,
  pauseBlock,
  pauseOverlapSeconds,
  segmentEvents,
  segmentWords,
  spanSeconds,
  speechStatsFromTotals,
} from "./fallbackDetectors";
import {
  type AnalysisReport,
  type ChunkAnalysis,
  type PauseSpan,
  type StutterEvent,
  type StutterKind,
  type TranscriptSegment,
  fallbackAnalyze,
} from "./index";
import type { LiveAnalysisParity, LiveAnalysisWork } from "./liveAnalysis";

/** Retained segments beyond this are refused: the stream reports itself overloaded. */
export const MAX_STREAM_SEGMENTS = 20_000;
/** Retained pauses beyond this are refused the same way. */
export const MAX_STREAM_PAUSES = 50_000;
/** Differences listed in a mismatch; the count covers all of them. */
const LISTED_DIFFERENCES = 8;

export type StreamStartRequest = { runId: string; sessionStartedAt?: string };

/**
 * One update: segments from `segmentsFrom` on are replaced by `segments`, pauses from
 * `pausesFrom` on by `pauses`. Updates are numbered from 0 per run.
 */
export type StreamPushRequest = {
  runId: string;
  seq: number;
  segmentsFrom: number;
  segments: TranscriptSegment[];
  pausesFrom: number;
  pauses: PauseSpan[];
};

/** The final observation of the capture, which the oracle analyzes. */
export type StreamFinishRequest = {
  runId: string;
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
};

/**
 * - `live`: every update so far was applied; the report is current.
 * - `interrupted`: an update is missing or does not fit the retained input; nothing more is
 *   applied until a full resynchronization (an update from position 0 of both lists).
 * - `overloaded`: the retained input would exceed its bound; the report is stale.
 */
export type StreamStatus = "live" | "interrupted" | "overloaded";

export type StreamUpdate = {
  runId: string;
  seq: number;
  status: StreamStatus;
  reason?: string;
  /** False when the update changed nothing; `report` is then absent. */
  changed: boolean;
  report?: AnalysisReport & { analyzerVersion?: string };
  work: LiveAnalysisWork;
  processingMs: number;
};

export type StreamFinished = {
  runId: string;
  status: StreamStatus;
  reason?: string;
  parity: LiveAnalysisParity;
  work: LiveAnalysisWork;
  /** Slowest single update and the batch oracle run, milliseconds. */
  maxUpdateMs: number;
  oracleMs: number;
};

/** Batch event order; see `compareKeys`. */
type EventKey = { start: number; group: 0 | 1; position: number; order: number };
const SEGMENT_EVENTS = 0;
const PAUSE_BLOCKS = 1;

type Keyed = { key: EventKey; event: StutterEvent };

/**
 * The batch sorts the collected events stably by `left.startSeconds - right.startSeconds` (times
 * are finite, so that is the order of the start times, with 0 and -0 equal), and collects segment
 * events before pause blocks, each in position order, each segment's in detector order.
 */
function compareKeys(left: EventKey, right: EventKey) {
  return (
    left.start - right.start ||
    left.group - right.group ||
    left.position - right.position ||
    left.order - right.order
  );
}

type SegmentTotals = { speakingSeconds: number; endSeconds: number; words: number; finals: number };
const NO_SEGMENTS: SegmentTotals = { speakingSeconds: 0, endSeconds: 0, words: 0, finals: 0 };

type PauseTotals = { pauseSeconds: number; endSeconds: number };
const NO_PAUSES: PauseTotals = { pauseSeconds: 0, endSeconds: 0 };

type SegmentEntry = {
  segment: TranscriptSegment;
  eventKeys: EventKey[];
  wordCount: number;
  totals: SegmentTotals;
};

type PauseEntry = {
  pause: PauseSpan;
  position: number;
  block: EventKey | null;
  totals: PauseTotals;
};

function emptyWork(): LiveAnalysisWork {
  return {
    updates: 0,
    noOpUpdates: 0,
    duplicateUpdates: 0,
    rejectedUpdates: 0,
    segmentsAnalyzed: 0,
    tokensAnalyzed: 0,
    pausesAnalyzed: 0,
    segmentsRevisited: 0,
    pausesRevisited: 0,
    fullRebuilds: 0,
    reportsBuilt: 0,
    reportEvents: 0,
    reportChunks: 0,
    chunkEventReads: 0,
    retainedSegments: 0,
    retainedPauses: 0,
    retainedEvents: 0,
    // The shared analysis cites no observations.
    retainedCitedObservations: 0,
  };
}

/** First index in `items` (sorted by `value`) whose value is not below `bound`. */
function lowerBound<T>(items: T[], bound: number, value: (item: T) => number) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (value(items[middle]) < bound) low = middle + 1;
    else high = middle;
  }
  return low;
}

function findKey(events: Keyed[], key: EventKey) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareKeys(events[middle].key, key) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

const now = () => globalThis.performance.now();

/** The incremental analysis of one capture run. */
export class AnalysisStream {
  readonly runId: string;
  private readonly sessionStartedAt: string | undefined;
  private nextSeq = 0;
  private status: StreamStatus = "live";
  private reason: string | undefined;
  private segments: SegmentEntry[] = [];
  private pauses: PauseEntry[] = [];
  /** Retained events in batch order (before duplicate removal). */
  private events: Keyed[] = [];
  /** Pause positions by start, for the silent time of a chunk. */
  private pauseStarts: Array<{ start: number; position: number }> = [];
  /** Upper bounds on event and pause length; they only grow, which keeps lookups correct. */
  private longestEventSeconds = 0;
  private longestPauseSeconds = 0;
  readonly work: LiveAnalysisWork = emptyWork();
  private maxUpdateMs = 0;

  constructor(request: StreamStartRequest) {
    this.runId = request.runId;
    this.sessionStartedAt = request.sessionStartedAt;
  }

  push(request: StreamPushRequest): StreamUpdate {
    const started = now();
    const changed = this.apply(request);
    const report = changed ? this.report() : undefined;
    const processingMs = now() - started;
    this.maxUpdateMs = Math.max(this.maxUpdateMs, processingMs);
    return {
      runId: this.runId,
      seq: request.seq,
      status: this.status,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      changed,
      ...(report ? { report } : {}),
      work: { ...this.work },
      processingMs,
    };
  }

  /** Ends the run and compares its report with the batch report of the final observation. */
  finish(request: StreamFinishRequest): StreamFinished {
    const live = this.report();
    const started = now();
    const oracle = fallbackAnalyze({
      segments: request.segments,
      pauses: request.pauses,
      sessionStartedAt: request.sessionStartedAt,
    });
    const oracleMs = now() - started;
    const parity: LiveAnalysisParity =
      this.status === "live"
        ? compareReports(live, oracle)
        : { state: "notComparable", reason: `live analysis ${this.status}: ${this.reason ?? ""}` };
    return {
      runId: this.runId,
      status: this.status,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      parity,
      work: { ...this.work },
      maxUpdateMs: this.maxUpdateMs,
      oracleMs,
    };
  }

  /** Applies an update; true when it changed the input. */
  private apply(request: StreamPushRequest): boolean {
    if (request.seq < this.nextSeq) {
      this.work.duplicateUpdates += 1;
      return false;
    }
    const resync = request.segmentsFrom === 0 && request.pausesFrom === 0;
    if (request.seq > this.nextSeq && !resync) {
      this.interrupt(`update ${request.seq} arrived while ${this.nextSeq} was expected`);
    }
    this.nextSeq = request.seq + 1;
    if (this.status !== "live" && !resync) {
      this.work.rejectedUpdates += 1;
      return false;
    }
    if (request.segmentsFrom > this.segments.length || request.pausesFrom > this.pauses.length) {
      this.work.rejectedUpdates += 1;
      this.interrupt(
        `update ${request.seq} replaces from segment ${request.segmentsFrom} and pause ${request.pausesFrom}, beyond the ${this.segments.length} segments and ${this.pauses.length} pauses held`,
      );
      return false;
    }
    if (
      request.segmentsFrom + request.segments.length > MAX_STREAM_SEGMENTS ||
      request.pausesFrom + request.pauses.length > MAX_STREAM_PAUSES
    ) {
      this.work.rejectedUpdates += 1;
      this.status = "overloaded";
      this.reason = `more than ${MAX_STREAM_SEGMENTS} segments or ${MAX_STREAM_PAUSES} pauses`;
      return false;
    }
    if (
      request.segments.some(
        (segment) =>
          segment.isFinal &&
          (!Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds)),
      ) ||
      request.pauses.some(
        (pause) => !Number.isFinite(pause.startSeconds) || !Number.isFinite(pause.endSeconds),
      )
    ) {
      // Event order is a comparison of start times, which non-finite times do not have.
      throw new Error("segment and pause times must be finite");
    }
    if (
      request.segmentsFrom === this.segments.length &&
      request.segments.length === 0 &&
      request.pausesFrom === this.pauses.length &&
      request.pauses.length === 0
    ) {
      this.work.noOpUpdates += 1;
      return false;
    }
    if (resync && (this.segments.length > 0 || this.pauses.length > 0)) {
      this.work.fullRebuilds += 1;
    }
    this.status = "live";
    this.reason = undefined;
    this.work.updates += 1;
    this.truncateSegments(request.segmentsFrom);
    this.truncatePauses(request.pausesFrom);
    for (const segment of request.segments) this.pushSegment(segment);
    for (const pause of request.pauses) this.pushPause(pause);
    this.work.retainedSegments = this.segments.length;
    this.work.retainedPauses = this.pauses.length;
    this.work.retainedEvents = this.events.length;
    return true;
  }

  private interrupt(reason: string) {
    this.status = "interrupted";
    this.reason = reason;
  }

  private removeEvent(key: EventKey) {
    const index = findKey(this.events, key);
    this.events.splice(index, 1);
  }

  private insertEvent(key: EventKey, item: StutterEvent) {
    const length = item.endSeconds - item.startSeconds;
    this.longestEventSeconds = Math.max(this.longestEventSeconds, length);
    this.events.splice(findKey(this.events, key), 0, { key, event: item });
  }

  private truncateSegments(from: number) {
    for (const entry of this.segments.splice(from)) {
      this.work.segmentsRevisited += 1;
      for (const key of entry.eventKeys) this.removeEvent(key);
    }
  }

  private truncatePauses(from: number) {
    for (const entry of this.pauses.splice(from)) {
      this.work.pausesRevisited += 1;
      let at = lowerBound(this.pauseStarts, entry.pause.startSeconds, (item) => item.start);
      while (this.pauseStarts[at].position !== entry.position) at += 1;
      this.pauseStarts.splice(at, 1);
      if (entry.block) this.removeEvent(entry.block);
    }
  }

  private pushSegment(segment: TranscriptSegment) {
    const position = this.segments.length;
    const previous = this.segments.at(-1)?.totals ?? NO_SEGMENTS;
    if (!segment.isFinal) {
      // Partial results are provisional: the batch analyzes final segments only.
      this.segments.push({ segment, eventKeys: [], wordCount: 0, totals: previous });
      return;
    }
    this.work.segmentsAnalyzed += 1;
    const words = segmentWords(segment);
    this.work.tokensAnalyzed += words.length;
    const wordCount = countedWords(words);
    const eventKeys = segmentEvents(segment, words).map((item, order) => {
      const key: EventKey = { start: item.startSeconds, group: SEGMENT_EVENTS, position, order };
      this.insertEvent(key, item);
      return key;
    });
    this.segments.push({
      segment,
      eventKeys,
      wordCount,
      totals: {
        speakingSeconds: previous.speakingSeconds + spanSeconds(segment),
        endSeconds: Math.max(previous.endSeconds, segment.endSeconds),
        words: previous.words + wordCount,
        finals: previous.finals + 1,
      },
    });
  }

  private pushPause(pause: PauseSpan) {
    const position = this.pauses.length;
    this.work.pausesAnalyzed += 1;
    const previous = this.pauses.at(-1)?.totals ?? NO_PAUSES;
    this.longestPauseSeconds = Math.max(
      this.longestPauseSeconds,
      pause.endSeconds - pause.startSeconds,
    );
    // After every pause of the same start: positions stay in order among equal starts.
    const at = lowerBound(this.pauseStarts, pause.startSeconds, (item) => item.start);
    let index = at;
    while (index < this.pauseStarts.length && this.pauseStarts[index].start === pause.startSeconds)
      index += 1;
    this.pauseStarts.splice(index, 0, { start: pause.startSeconds, position });
    const block = pauseBlock(pause);
    let key: EventKey | null = null;
    if (block) {
      key = { start: block.startSeconds, group: PAUSE_BLOCKS, position, order: 0 };
      this.insertEvent(key, block);
    }
    this.pauses.push({
      pause,
      position,
      block: key,
      totals: {
        pauseSeconds: previous.pauseSeconds + spanSeconds(pause),
        endSeconds: Math.max(previous.endSeconds, pause.endSeconds),
      },
    });
  }

  /** The report of the input so far, equal to the batch report of it without audio. */
  private report(): AnalysisReport {
    const segmentTotals = this.segments.at(-1)?.totals ?? NO_SEGMENTS;
    const pauseTotals = this.pauses.at(-1)?.totals ?? NO_PAUSES;

    const events: StutterEvent[] = [];
    let previous: StutterEvent | undefined;
    for (const { event: item } of this.events) {
      // The batch compares each event with its predecessor in the sorted list, kept or not.
      if (!isNearDuplicate(previous, item)) events.push({ ...item });
      previous = item;
    }

    const wordCount = segmentTotals.words;
    const totalDurationSeconds = Math.max(segmentTotals.endSeconds, pauseTotals.endSeconds);
    const minutes = Math.max(totalDurationSeconds / 60, 1 / 60);
    const stuttersPerMinute = events.length / minutes;
    const chunks = this.chunks(events);
    this.work.reportsBuilt += 1;
    this.work.reportEvents += events.length;
    this.work.reportChunks += chunks.length;
    return {
      sessionStartedAt: this.sessionStartedAt,
      totalDurationSeconds,
      wordCount,
      stutterCount: events.length,
      stuttersPerMinute,
      severity: classifySeverity(events.length, stuttersPerMinute, wordCount),
      speechStats: speechStatsFromTotals(
        totalDurationSeconds,
        segmentTotals.speakingSeconds,
        pauseTotals.pauseSeconds,
        wordCount,
        events.length,
        segmentTotals.finals,
      ),
      blockerStats: buildBlockerStats(events, totalDurationSeconds),
      chunks,
      events,
      byKind: events.reduce<Partial<Record<StutterKind, number>>>((acc, item) => {
        acc[item.kind] = (acc[item.kind] ?? 0) + 1;
        return acc;
      }, {}),
      acousticStats: undefined,
      capabilities: ANALYSIS_CAPABILITIES.onDevice,
    };
  }

  /** One row per final segment; a chunk reads only the events and pauses that can reach it. */
  private chunks(events: StutterEvent[]): ChunkAnalysis[] {
    const chunks: ChunkAnalysis[] = [];
    for (const entry of this.segments) {
      const segment = entry.segment;
      if (!segment.isFinal) continue;
      const start = segment.startSeconds;
      const end = segment.endSeconds;
      // An event reaches a chunk by overlapping it or, as a block, ending at most 1 s before it
      // starts; either way it starts after `lower` and before `upper`.
      const lower = Math.min(start, end) - this.longestEventSeconds - 2;
      const upper = Math.max(start, end);
      let stutterCount = 0;
      let blockCount = 0;
      let fillerCount = 0;
      for (
        let index = lowerBound(events, lower, (item) => item.startSeconds);
        index < events.length && events[index].startSeconds < upper;
        index += 1
      ) {
        this.work.chunkEventReads += 1;
        const item = events[index];
        if (eventAppliesToSegment(item, segment)) {
          stutterCount += 1;
          if (item.kind === "block") blockCount += 1;
          if (item.kind === "filler") fillerCount += 1;
        }
      }

      // The batch sums every pause's overlap in pause order from 0; a pause that cannot overlap
      // adds an exact +0, so summing only the overlapping ones in order is the same sum.
      const overlapping: Array<{ position: number; seconds: number }> = [];
      for (
        let index = lowerBound(
          this.pauseStarts,
          start - this.longestPauseSeconds - 2,
          (item) => item.start,
        );
        index < this.pauseStarts.length && this.pauseStarts[index].start < end;
        index += 1
      ) {
        const { position } = this.pauseStarts[index];
        const seconds = pauseOverlapSeconds(this.pauses[position].pause, segment);
        if (seconds !== 0) overlapping.push({ position, seconds });
      }
      overlapping.sort((left, right) => left.position - right.position);
      let silentPauseSeconds = 0;
      for (const { seconds } of overlapping) silentPauseSeconds += seconds;

      const durationSeconds = spanSeconds(segment);
      chunks.push({
        index: chunks.length,
        startSeconds: start,
        endSeconds: end,
        durationSeconds,
        text: segment.text,
        wordCount: entry.wordCount,
        stutterCount,
        blockCount,
        fillerCount,
        wordsPerMinute: chunkWordsPerMinute(entry.wordCount, durationSeconds),
        silentPauseSeconds,
        averageConfidence: meanFinite([segment.confidence, segment.speakerScore]),
      });
    }
    return chunks;
  }
}

/**
 * Exact comparison of two reports as they are saved: every value equal (numbers by `Object.is`,
 * so -0 and 0 differ too), an absent field the same as an undefined one. No tolerance.
 */
export function compareReports(live: AnalysisReport, oracle: AnalysisReport): LiveAnalysisParity {
  const differences: string[] = [];
  exactDifferences("report", oracle, live, differences);
  if (differences.length === 0) {
    return {
      state: "match",
      events: live.events.length,
      chunks: live.chunks.length,
      observations: live.observations?.length ?? 0,
    };
  }
  return {
    state: "mismatch",
    differenceCount: differences.length,
    differences: differences.slice(0, LISTED_DIFFERENCES),
  };
}

function shown(value: unknown) {
  const text = value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value));
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function exactDifferences(path: string, expected: unknown, actual: unknown, out: string[]) {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isObject(expected) && isObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) exactDifferences(`${path}.${key}`, expected[key], actual[key], out);
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length) {
    expected.forEach((item, index) =>
      exactDifferences(`${path}[${index}]`, item, actual[index], out),
    );
    return;
  }
  if (!Object.is(expected, actual)) {
    out.push(`${path}: batch ${shown(expected)}, live ${shown(actual)}`);
  }
}

/**
 * The device's stream, with the desktop's command semantics: starting a run replaces the previous
 * one, so an older run's updates and finish are refused instead of changing the active run.
 */
export class AnalysisStreamHost {
  private active: AnalysisStream | null = null;

  start(request: StreamStartRequest) {
    this.active = new AnalysisStream(request);
  }

  push(request: StreamPushRequest): StreamUpdate {
    if (this.active?.runId !== request.runId) {
      throw new Error(`no analysis stream run ${request.runId}`);
    }
    return this.active.push(request);
  }

  finish(request: StreamFinishRequest): StreamFinished {
    const stream = this.active;
    if (stream?.runId !== request.runId) {
      throw new Error(`no analysis stream run ${request.runId}`);
    }
    this.active = null;
    return stream.finish(request);
  }
}
