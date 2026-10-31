// Checkpoints of captures in the workspace that have not been saved yet, so a closed tab, crash or
// reload does not lose their observation. Audio is not checkpointed (sessions never store it), so a
// recovered capture is the observation only: nothing is invented for the missing audio.
//
// Each capture has its own key, so captures in different windows never overwrite each other. A
// window holds a Web Lock named after the capture while it owns it; a checkpoint whose lock is held
// belongs to a live window and is not offered for recovery elsewhere. Closing or crashing the window
// releases the lock.
import type {
  AnalysisRunIdentity,
  RecordingDescriptor,
  TranscriptionModelIdentity,
} from "@stutter-tracker/shared";
import type { AnalysisReport, PauseSpan, TranscriptSegment } from "../types";
import {
  isAnalysisReport,
  isAnalysisRunIdentity,
  isPauseSpan,
  isRecordingDescriptor,
  isTranscriptionModelIdentity,
  isTranscriptSegment,
  isValidDateString,
} from "./sessionBackup";
import { appStorage } from "./protectedStorage";

export const CAPTURE_CHECKPOINT_PREFIX = "stutter-tracker:capture-checkpoint:";
export const CAPTURE_CHECKPOINT_VERSION = 1;
const CAPTURE_LOCK_PREFIX = "stutter-tracker:capture:";

export type CaptureCheckpoint = {
  version: typeof CAPTURE_CHECKPOINT_VERSION;
  /** Id the capture is saved under, so a capture saved before the checkpoint was cleared is not recovered twice. */
  id: string;
  startedAt: string;
  updatedAt: string;
  /** Language tag selected when the capture started; null when unknown. */
  language: string | null;
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  /**
   * The finished analysis of exactly this observation (including its audio), when there was one.
   * It cannot be recomputed after recovery because the audio is gone.
   */
  analysis: { report: AnalysisReport; run: AnalysisRunIdentity } | null;
  /** How the capture was recorded (no audio); null when unknown, e.g. in older checkpoints. */
  recording: RecordingDescriptor | null;
  /**
   * The transcription engine and model that produced `segments`; null when unknown, e.g. in older
   * checkpoints. Kept so a recovered transcript's later analysis still names its model.
   */
  transcription?: TranscriptionModelIdentity | null;
};

/** A stored checkpoint offered for recovery, identified by its storage key. */
export type InterruptedCapture =
  | { key: string; kind: "checkpoint"; checkpoint: CaptureCheckpoint }
  /** Present but not readable by this build; kept until the user discards it. */
  | { key: string; kind: "unreadable" };

export function captureCheckpointKey(id: string) {
  return `${CAPTURE_CHECKPOINT_PREFIX}${id}`;
}

/** Every stored checkpoint, oldest first. Storage that cannot be read yields none. */
export function listCaptureCheckpoints(storage: Storage = appStorage()): InterruptedCapture[] {
  const found: InterruptedCapture[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(CAPTURE_CHECKPOINT_PREFIX)) {
        continue;
      }
      const raw = storage.getItem(key);
      if (raw === null) {
        continue;
      }
      const checkpoint = parseRawCheckpoint(raw);
      found.push(
        checkpoint && captureCheckpointKey(checkpoint.id) === key
          ? { key, kind: "checkpoint", checkpoint }
          : { key, kind: "unreadable" },
      );
    }
  } catch {
    // Storage unavailable: nothing can be recovered, and nothing is overwritten either.
    return [];
  }
  return found.sort((left, right) => startedAtOf(left) - startedAtOf(right));
}

/** The checkpoint stored under `key` now; null when there is none. */
export function readCaptureCheckpoint(
  key: string,
  storage: Storage = appStorage(),
): InterruptedCapture | null | "unavailable" {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return "unavailable";
  }
  if (raw === null) {
    return null;
  }
  const checkpoint = parseRawCheckpoint(raw);
  return checkpoint && captureCheckpointKey(checkpoint.id) === key
    ? { key, kind: "checkpoint", checkpoint }
    : { key, kind: "unreadable" };
}

function startedAtOf(capture: InterruptedCapture) {
  return capture.kind === "checkpoint" ? Date.parse(capture.checkpoint.startedAt) : 0;
}

function parseRawCheckpoint(raw: string) {
  try {
    return parseCaptureCheckpoint(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseCaptureCheckpoint(value: unknown): CaptureCheckpoint | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== CAPTURE_CHECKPOINT_VERSION
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id.trim() ||
    !isValidDateString(record.startedAt) ||
    !isValidDateString(record.updatedAt) ||
    !(record.language === null || typeof record.language === "string") ||
    !Array.isArray(record.segments) ||
    !record.segments.every(isTranscriptSegment) ||
    !Array.isArray(record.pauses) ||
    !record.pauses.every(isPauseSpan) ||
    !(record.analysis === null || isCheckpointAnalysis(record.analysis)) ||
    !(
      record.recording === undefined ||
      record.recording === null ||
      (isRecordingDescriptor(record.recording) &&
        (record.recording as RecordingDescriptor).sessionId === record.id)
    ) ||
    !(
      record.transcription === undefined ||
      record.transcription === null ||
      isTranscriptionModelIdentity(record.transcription)
    )
  ) {
    return null;
  }
  return {
    version: CAPTURE_CHECKPOINT_VERSION,
    id: record.id,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    language: record.language,
    segments: record.segments as TranscriptSegment[],
    pauses: record.pauses as PauseSpan[],
    analysis: record.analysis as CaptureCheckpoint["analysis"],
    recording: (record.recording as RecordingDescriptor | undefined) ?? null,
    // Absent in older checkpoints (unknown); kept absent so they read back unchanged.
    ...(record.transcription === undefined
      ? {}
      : { transcription: record.transcription as TranscriptionModelIdentity | null }),
  };
}

function isCheckpointAnalysis(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "report" in value &&
    "run" in value &&
    isAnalysisReport(value.report) &&
    isAnalysisRunIdentity(value.run)
  );
}

/** True when the checkpoint holds any observation worth recovering. */
export function hasCheckpointedObservation(
  checkpoint: Pick<CaptureCheckpoint, "segments" | "pauses" | "analysis">,
) {
  return (
    checkpoint.segments.length > 0 ||
    checkpoint.pauses.length > 0 ||
    (checkpoint.analysis?.report.events.length ?? 0) > 0
  );
}

/**
 * Writes the checkpoint as one value, so a reader sees either the previous or the new state.
 * Throws when storage is full or unavailable; the caller must make that visible.
 */
export function writeCaptureCheckpoint(
  checkpoint: CaptureCheckpoint,
  storage: Storage = appStorage(),
) {
  storage.setItem(captureCheckpointKey(checkpoint.id), JSON.stringify(checkpoint));
}

/** Removes one stored checkpoint by key. Returns false when storage refused the removal. */
export function removeCaptureCheckpoint(key: string, storage: Storage = appStorage()) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claims capture `id` for this window until the returned release runs. Resolves to null when
 * another window holds it or the lock request fails. Without Web Locks every claim succeeds, as
 * there is no way to tell.
 */
export async function claimCapture(id: string): Promise<(() => void) | null> {
  const locks = webLocks();
  if (!locks) {
    return () => {};
  }
  return new Promise((resolve) => {
    void locks
      .request(CAPTURE_LOCK_PREFIX + id, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        return new Promise<void>((release) => resolve(() => release()));
      })
      // Ownership could not be established, so act as if another window holds it.
      .catch(() => resolve(null));
  });
}

/** Ids of captures that a live window currently owns. */
export async function heldCaptureIds(): Promise<Set<string>> {
  const locks = webLocks();
  if (!locks) {
    return new Set();
  }
  try {
    const { held = [] } = await locks.query();
    return new Set(
      held
        .map((lock) => lock.name)
        .filter((name): name is string => !!name?.startsWith(CAPTURE_LOCK_PREFIX))
        .map((name) => name.slice(CAPTURE_LOCK_PREFIX.length)),
    );
  } catch {
    return new Set();
  }
}

function webLocks(): LockManager | null {
  return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null;
}
