// Real recordings through the shared incremental stream (vox#154), the same harness as the
// desktop's `real_uclass_recordings_match_the_batch_report_in_every_chunking` (vox#38): UCLASS
// release 1 monologues with an asr-eval transcript (vox#26/#143), pauses found from the audio the
// way the recorder finds them (RMS of each 2048-sample chunk above 0.025 is voice; more than
// 0.75 s between voiced chunks is a pause). Segments arrive when their transcription chunk ends,
// first partial, then final; pauses when they end. Every update is compared with the shared batch
// analysis (`fallbackAnalyze`) of exactly that input, at several arrival cadences.
//
//   VOX_UCLASS_HYPOTHESES=~/.cache/uclass/runs/nwx-turbo-cuda.json VOX_UCLASS_ROOT=~/.cache/uclass \
//     bun packages/shared/scripts/live-analysis-uclass.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AnalysisStream,
  type PauseSpan,
  type StreamUpdate,
  type TranscriptSegment,
  compareReports,
  fallbackAnalyze,
} from "../src/index";

const CADENCES = [1, 2, 3, 5, 8, 13];
const RUN = "uclass";

type Hypotheses = {
  chunkSeconds?: number;
  items: Array<{ item: string; subset?: string; segments: TranscriptSegment[] }>;
};

function readWav(path: string) {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let rate = 0;
  let channels = 1;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      rate = view.getUint32(offset + 12, true);
    } else if (id === "data") {
      const count = Math.floor(size / 2 / channels);
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        samples[index] = view.getInt16(offset + 8 + index * 2 * channels, true) / 32_768;
      }
      return { rate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`no data in ${path}`);
}

/** The recorder's pauses, in f32 like the desktop harness. */
function recorderPauses(samples: Float32Array, rate: number, segments: TranscriptSegment[]) {
  const pauses: PauseSpan[] = [];
  let lastVoice = 0;
  for (let start = 0; start < samples.length; start += 2_048) {
    const chunk = samples.subarray(start, start + 2_048);
    let energy = 0;
    for (const sample of chunk) energy = Math.fround(energy + Math.fround(sample * sample));
    const rms = Math.fround(
      Math.sqrt(Math.fround(energy / Math.fround(Math.max(1, chunk.length)))),
    );
    const now = (start + chunk.length) / rate;
    if (rms > Math.fround(0.025)) {
      if (lastVoice > 0 && now - lastVoice > 0.75) {
        const after = segments.findLast((segment) => segment.endSeconds <= lastVoice);
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

/** Sends what changed since the last update and compares the report with the batch. */
class Client {
  stream = new AnalysisStream({ runId: RUN });
  seq = 0;
  sent: { segments: TranscriptSegment[]; pauses: PauseSpan[] } = { segments: [], pauses: [] };
  mismatches = 0;
  /** Time of the changing updates, and of a batch run of the same inputs (without audio). */
  streamMs = 0;
  batchMs = 0;
  checked = 0;

  sync(segments: TranscriptSegment[], pauses: PauseSpan[]): StreamUpdate {
    const prefix = <T>(held: T[], next: T[]) => {
      let index = 0;
      while (
        index < held.length &&
        index < next.length &&
        JSON.stringify(held[index]) === JSON.stringify(next[index])
      )
        index += 1;
      return index;
    };
    const segmentsFrom = prefix(this.sent.segments, segments);
    const pausesFrom = prefix(this.sent.pauses, pauses);
    const update = this.stream.push({
      runId: RUN,
      seq: this.seq++,
      segmentsFrom,
      segments: segments.slice(segmentsFrom),
      pausesFrom,
      pauses: pauses.slice(pausesFrom),
    });
    this.sent = { segments, pauses };
    if (update.status !== "live") throw new Error(`stream ${update.status}: ${update.reason}`);
    if (update.report) {
      this.checked += 1;
      this.streamMs += update.processingMs;
      const started = performance.now();
      const oracle = fallbackAnalyze({ segments, pauses });
      this.batchMs += performance.now() - started;
      const parity = compareReports(update.report, oracle);
      if (parity.state !== "match") {
        this.mismatches += 1;
        console.error(parity);
      }
    }
    return update;
  }
}

const hypotheses = JSON.parse(
  readFileSync(process.env.VOX_UCLASS_HYPOTHESES!, "utf8"),
) as Hypotheses;
const root = process.env.VOX_UCLASS_ROOT!;
const chunkSeconds = hypotheses.chunkSeconds ?? 8;
const totals = {
  items: 0,
  audioSeconds: 0,
  segments: 0,
  pauses: 0,
  events: 0,
  tokens: 0,
  analyzed: 0,
  runs: 0,
  matching: 0,
  reportsChecked: 0,
  streamMs: 0,
  batchMs: 0,
  maxUpdateMs: 0,
};
console.log(
  `| Recording | Audio s | Segments | Pauses | Events | Chunks | Tokens (analyzed) | Updates at cadence ${CADENCES.join(" / ")} | Positions revisited | Slowest update ms | Parity, all cadences |`,
);
console.log(`|${"---|".repeat(11)}`);
for (const item of hypotheses.items) {
  const id = item.subset?.includes("noise") ? `${item.item} (noise transcript)` : item.item;
  const segments: TranscriptSegment[] = item.segments.map((segment) => ({
    text: segment.text,
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    isFinal: true,
  }));
  let wav: ReturnType<typeof readWav>;
  try {
    wav = readWav(join(root, "audio16k", `${item.item}.wav`));
  } catch {
    console.log(`| ${id} | missing audio |${" |".repeat(9)}`);
    continue;
  }
  const audioSeconds = wav.samples.length / wav.rate;
  const pauses = recorderPauses(wav.samples, wav.rate, segments);
  // Arrival times: a segment when its transcription chunk is done, a pause when it ends.
  const arrivals = [
    ...segments.map((segment, index) => ({
      at: (Math.floor(segment.endSeconds / chunkSeconds) + 1) * chunkSeconds,
      isSegment: true,
      index,
    })),
    ...pauses.map((pause, index) => ({ at: pause.endSeconds, isSegment: false, index })),
  ].sort((left, right) => left.at - right.at);
  const batch = fallbackAnalyze({ segments, pauses });
  const tokens = segments.reduce(
    (sum, segment) => sum + segment.text.split(/\s+/).filter(Boolean).length,
    0,
  );
  const updates: number[] = [];
  let revisited = 0;
  let analyzed = 0;
  let slowest = 0;
  let allMatch = true;
  for (const cadence of CADENCES) {
    const client = new Client();
    let shownSegments = 0;
    let shownPauses = 0;
    for (let from = 0; from < arrivals.length; from += cadence) {
      const arrivedFrom = shownSegments;
      for (const arrival of arrivals.slice(from, from + cadence)) {
        if (arrival.isSegment) shownSegments = Math.max(shownSegments, arrival.index + 1);
        else shownPauses = Math.max(shownPauses, arrival.index + 1);
      }
      // Newly arrived segments are partial first, then final.
      const partial = segments
        .slice(0, shownSegments)
        .map((segment, index) => (index >= arrivedFrom ? { ...segment, isFinal: false } : segment));
      client.sync(partial, pauses.slice(0, shownPauses));
      client.sync(segments.slice(0, shownSegments), pauses.slice(0, shownPauses));
    }
    client.sync(segments, pauses);
    const finished = client.stream.finish({ runId: RUN, segments, pauses });
    const match = finished.parity.state === "match" && client.mismatches === 0;
    if (finished.work.tokensAnalyzed !== tokens) {
      throw new Error(`${id}: ${finished.work.tokensAnalyzed} tokens analyzed of ${tokens}`);
    }
    allMatch &&= match;
    totals.runs += 1;
    totals.matching += match ? 1 : 0;
    totals.reportsChecked += client.checked;
    totals.streamMs += client.streamMs;
    totals.batchMs += client.batchMs;
    updates.push(finished.work.updates);
    if (cadence === 1) {
      revisited = finished.work.segmentsRevisited;
      analyzed = finished.work.tokensAnalyzed;
    }
    slowest = Math.max(slowest, finished.maxUpdateMs);
  }
  totals.items += 1;
  totals.audioSeconds += audioSeconds;
  totals.segments += segments.length;
  totals.pauses += pauses.length;
  totals.events += batch.events.length;
  totals.tokens += tokens;
  totals.analyzed += analyzed;
  totals.maxUpdateMs = Math.max(totals.maxUpdateMs, slowest);
  console.log(
    `| ${id} | ${audioSeconds.toFixed(1)} | ${segments.length} | ${pauses.length} | ${batch.events.length} | ${batch.chunks.length} | ${tokens} (${analyzed}) | ${updates.join(" / ")} | ${revisited} | ${slowest.toFixed(3)} | ${allMatch ? "match" : "MISMATCH"} |`,
  );
}
console.log(
  `\nTotals: ${totals.items} items, ${(totals.audioSeconds / 60).toFixed(1)} audio min, ${totals.segments} segments, ${totals.pauses} pauses, ${totals.events} events, ${totals.tokens} tokens (${totals.analyzed} analyzed), ${totals.matching} / ${totals.runs} runs matching, ${totals.reportsChecked} intermediate reports compared, slowest update ${totals.maxUpdateMs.toFixed(3)} ms, all changing updates ${totals.streamMs.toFixed(1)} ms in the stream vs ${totals.batchMs.toFixed(1)} ms as batch runs without audio`,
);
if (totals.matching !== totals.runs) process.exit(1);
