// The transcript-and-pause part of the shared fallback analysis: the per-segment and per-pause
// detectors and the statistics built from their totals. The batch analysis (`fallbackAnalyze`)
// and the incremental stream (`AnalysisStream`) both run these, so the two cannot drift apart.
import type {
  AcousticEvidence,
  AnalysisReport,
  BlockerStats,
  PauseSpan,
  SpeechStats,
  StutterEvent,
  StutterKind,
  TranscriptSegment,
} from "./index";

/** A pause at least this long is reported as a block. */
export const BLOCK_PAUSE_SECONDS = 0.75;

export function event(
  kind: StutterKind,
  startSeconds: number,
  endSeconds: number,
  text: string,
  detail: string,
  confidence: number,
  source: StutterEvent["source"] = "transcript",
  acousticEvidence?: AcousticEvidence,
): StutterEvent {
  return { kind, startSeconds, endSeconds, text, detail, confidence, source, acousticEvidence };
}

export function normalize(value: string) {
  return value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

export function isFiller(value: string) {
  return ["um", "uh", "erm", "hm", "hmm", "like", "äh", "ähm", "eh"].includes(value);
}

function longestRun(value: string) {
  let previous = "";
  let current = 0;
  let longest = 0;
  for (const char of value) {
    current = char === previous ? current + 1 : 1;
    previous = char;
    longest = Math.max(longest, current);
  }
  return longest;
}

export function segmentWords(segment: TranscriptSegment) {
  return segment.text.split(/\s+/).filter(Boolean);
}

/** Words that count toward the word count: every word but fillers. */
export function countedWords(words: string[]) {
  return words.filter((word) => !isFiller(normalize(word))).length;
}

/** The transcript events of one final segment, in detector order. */
export function segmentEvents(segment: TranscriptSegment, words: string[]): StutterEvent[] {
  const events: StutterEvent[] = [];
  const step = Math.max(
    0.1,
    (segment.endSeconds - segment.startSeconds) / Math.max(1, words.length),
  );
  for (let index = 0; index < words.length; index += 1) {
    const word = normalize(words[index]);
    const next = normalize(words[index + 1] ?? "");
    const start = segment.startSeconds + step * index;
    if (word && word === next && !isFiller(word)) {
      events.push(
        event(
          "wordRepetition",
          start,
          start + step * 2,
          `${words[index]} ${words[index + 1]}`,
          "Repeated word sequence",
          0.78,
        ),
      );
    }
    // An unaligned segment has no timing to place a prolongation in; none is invented.
    if (longestRun(word) >= 4 && segment.alignment !== "unaligned") {
      events.push(
        event("prolongation", start, start + step, words[index], "Extended sound in word", 0.74),
      );
    }
    if (isFiller(word)) {
      events.push(
        event("filler", start, start + step, words[index], "Filler or restart marker", 0.58),
      );
    }
  }
  return events;
}

/** The block a pause is reported as, if it is long enough. */
export function pauseBlock(pause: PauseSpan): StutterEvent | null {
  if (pause.endSeconds - pause.startSeconds < BLOCK_PAUSE_SECONDS) return null;
  return event(
    "block",
    pause.startSeconds,
    pause.endSeconds,
    pause.afterText ?? "pause",
    `${(pause.endSeconds - pause.startSeconds).toFixed(1)}s silent pause before speech`,
    0.62,
  );
}

/** Events kept after sorting: one whose predecessor is the same detection within 0.08 s is not. */
export function isNearDuplicate(previous: StutterEvent | undefined, item: StutterEvent) {
  return Boolean(
    previous &&
    previous.kind === item.kind &&
    Math.abs(previous.startSeconds - item.startSeconds) < 0.08 &&
    previous.text === item.text,
  );
}

export function classifySeverity(
  stutterCount: number,
  stuttersPerMinute: number,
  wordCount: number,
): AnalysisReport["severity"] {
  const density = wordCount ? stutterCount / wordCount : 0;
  return stutterCount === 0
    ? "none"
    : stuttersPerMinute >= 12 || density >= 0.18
      ? "high"
      : stuttersPerMinute >= 6 || density >= 0.1
        ? "moderate"
        : "mild";
}

export function speechStatsFromTotals(
  totalDurationSeconds: number,
  speakingDurationSeconds: number,
  pauseDurationSeconds: number,
  wordCount: number,
  stutterCount: number,
  chunkCount: number,
): SpeechStats {
  const minutes = Math.max(totalDurationSeconds / 60, 1 / 60);
  const speakingMinutes = Math.max(speakingDurationSeconds / 60, 1 / 60);
  const eventDensityPer100Words = wordCount ? (stutterCount / wordCount) * 100 : 0;
  return {
    speakingDurationSeconds,
    pauseDurationSeconds,
    wordsPerMinute: wordCount / minutes,
    articulationRateWpm: wordCount / speakingMinutes,
    meanChunkWords: chunkCount ? wordCount / chunkCount : 0,
    meanChunkDurationSeconds: chunkCount ? speakingDurationSeconds / chunkCount : 0,
    eventDensityPer100Words,
    fluencyPercentage: wordCount ? Math.max(0, Math.min(100, 100 - eventDensityPer100Words)) : 100,
  };
}

/** Speaking time of a segment and silent time of a pause; reversed spans count as zero. */
export function spanSeconds(span: { startSeconds: number; endSeconds: number }) {
  return Math.max(0, span.endSeconds - span.startSeconds);
}

export function buildBlockerStats(
  events: StutterEvent[],
  totalDurationSeconds: number,
): BlockerStats {
  let blockCount = 0;
  let totalBlockSeconds = 0;
  let longestBlockSeconds = 0;
  for (const item of events) {
    if (item.kind !== "block") continue;
    const seconds = spanSeconds(item);
    blockCount += 1;
    totalBlockSeconds += seconds;
    longestBlockSeconds = Math.max(longestBlockSeconds, seconds);
  }
  const minutes = Math.max(totalDurationSeconds / 60, 1 / 60);
  return {
    blockCount,
    totalBlockSeconds,
    averageBlockSeconds: blockCount ? totalBlockSeconds / blockCount : 0,
    longestBlockSeconds,
    blocksPerMinute: blockCount / minutes,
    blockedTimePercentage: totalDurationSeconds
      ? (totalBlockSeconds / totalDurationSeconds) * 100
      : 0,
  };
}

/** An event counts toward a chunk by overlapping it or, as a block, ending at most 1 s before. */
export function eventAppliesToSegment(eventItem: StutterEvent, segment: TranscriptSegment) {
  return (
    overlaps(
      eventItem.startSeconds,
      eventItem.endSeconds,
      segment.startSeconds,
      segment.endSeconds,
    ) ||
    (eventItem.kind === "block" &&
      eventItem.endSeconds <= segment.startSeconds &&
      segment.startSeconds - eventItem.endSeconds <= 1)
  );
}

/** Silent time a pause adds to a chunk. */
export function pauseOverlapSeconds(pause: PauseSpan, segment: TranscriptSegment) {
  return Math.max(
    0,
    Math.min(pause.endSeconds, segment.endSeconds) -
      Math.max(pause.startSeconds, segment.startSeconds),
  );
}

export function chunkWordsPerMinute(wordCount: number, durationSeconds: number) {
  return wordCount / Math.max(durationSeconds / 60, 1 / 60);
}

export function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function meanFinite(values: Array<number | undefined>) {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}
