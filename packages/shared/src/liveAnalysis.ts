// Incremental transcript-and-pause analysis while recording (vox#38 on the desktop, vox#154 on
// other devices). The stream analyzes only what changed and, after Stop, compares its finalized
// report with the batch analysis of the same final transcript and pauses without audio (the
// desktop's native analysis, or the shared analysis elsewhere). The tolerance is exact equality;
// acoustic analysis is batch-only and runs once after Stop.

export const LIVE_ANALYSIS_SCHEMA_VERSION = 1;

/**
 * - `live`: every update was applied; the live report was current.
 * - `interrupted`: an update was missing or did not fit; nothing more was applied until a resync.
 * - `overloaded`: the retained input would have exceeded its bound; the live report went stale.
 * - `failed`: the stream failed (an error from the stream, e.g. non-finite times).
 * - `unavailable`: no incremental analysis on that device (records made before vox#154 off the
 *   desktop).
 */
export type LiveAnalysisStatus = "live" | "interrupted" | "overloaded" | "failed" | "unavailable";

/** Finalized live report compared with the batch report of the same final observation. */
export type LiveAnalysisParity =
  | { state: "match"; events: number; chunks: number; observations: number }
  | { state: "mismatch"; differenceCount: number; differences: string[] }
  | { state: "notComparable"; reason: string };

/** Deterministic work evidence of the stream (wall-clock time is kept apart). */
export type LiveAnalysisWork = {
  updates: number;
  noOpUpdates: number;
  duplicateUpdates: number;
  rejectedUpdates: number;
  segmentsAnalyzed: number;
  tokensAnalyzed: number;
  pausesAnalyzed: number;
  segmentsRevisited: number;
  pausesRevisited: number;
  fullRebuilds: number;
  reportsBuilt: number;
  reportEvents: number;
  reportChunks: number;
  chunkEventReads: number;
  retainedSegments: number;
  retainedPauses: number;
  retainedEvents: number;
  retainedCitedObservations: number;
};

/** The client side of the stream: at most one update in flight, later changes coalesced. */
export type LiveAnalysisQueue = {
  /** Observation changes folded into a later update while one was in flight. */
  coalescedChanges: number;
  /** Longest time an observation change waited for its update to be applied, milliseconds. */
  maxStalenessMs: number;
};

export type LiveAnalysisEvidence = {
  schemaVersion: typeof LIVE_ANALYSIS_SCHEMA_VERSION;
  /** The capture run (`RecordingDescriptor.runId`) this describes. */
  captureRunId: string;
  finishedAt: string;
  status: LiveAnalysisStatus;
  reason?: string;
  parity: LiveAnalysisParity;
  work: LiveAnalysisWork | null;
  queue: LiveAnalysisQueue;
  /** Slowest single update and the batch comparison run, milliseconds on the analyzing device. */
  maxUpdateMs: number;
  oracleMs: number;
};

const STATUSES: ReadonlySet<string> = new Set([
  "live",
  "interrupted",
  "overloaded",
  "failed",
  "unavailable",
]);

const WORK_KEYS: (keyof LiveAnalysisWork)[] = [
  "updates",
  "noOpUpdates",
  "duplicateUpdates",
  "rejectedUpdates",
  "segmentsAnalyzed",
  "tokensAnalyzed",
  "pausesAnalyzed",
  "segmentsRevisited",
  "pausesRevisited",
  "fullRebuilds",
  "reportsBuilt",
  "reportEvents",
  "reportChunks",
  "chunkEventReads",
  "retainedSegments",
  "retainedPauses",
  "retainedEvents",
  "retainedCitedObservations",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isDuration(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isParity(value: unknown): value is LiveAnalysisParity {
  if (!isRecord(value)) return false;
  switch (value.state) {
    case "match":
      return isCount(value.events) && isCount(value.chunks) && isCount(value.observations);
    case "mismatch":
      return (
        isCount(value.differenceCount) &&
        Array.isArray(value.differences) &&
        value.differences.every((item) => typeof item === "string")
      );
    case "notComparable":
      return typeof value.reason === "string";
    default:
      return false;
  }
}

export function isLiveAnalysisEvidence(value: unknown): value is LiveAnalysisEvidence {
  return (
    isRecord(value) &&
    value.schemaVersion === LIVE_ANALYSIS_SCHEMA_VERSION &&
    typeof value.captureRunId === "string" &&
    typeof value.finishedAt === "string" &&
    typeof value.status === "string" &&
    STATUSES.has(value.status) &&
    (value.reason === undefined || typeof value.reason === "string") &&
    isParity(value.parity) &&
    (value.work === null ||
      (isRecord(value.work) &&
        WORK_KEYS.every((key) => isCount((value.work as Record<string, unknown>)[key])))) &&
    isRecord(value.queue) &&
    isCount(value.queue.coalescedChanges) &&
    isDuration(value.queue.maxStalenessMs) &&
    isDuration(value.maxUpdateMs) &&
    isDuration(value.oracleMs)
  );
}
