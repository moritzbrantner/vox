// Interrupted captures: detection and comparison of stored checkpoints.
import { observationFingerprint } from "@stutter-tracker/shared";
import {
  CAPTURE_CHECKPOINT_PREFIX,
  type CaptureCheckpoint,
  type InterruptedCapture,
  hasCheckpointedObservation,
  heldCaptureIds,
  listCaptureCheckpoints,
  removeCaptureCheckpoint,
} from "../storage/captureCheckpoint";
import { type SavedSession } from "../types";

/**
 * Checkpoints of captures that were never saved and that no live window owns. A checkpoint of a
 * session that was saved (the app stopped before removing it) or one without any observation is
 * removed instead.
 */
export async function detectInterruptedCaptures(
  sessions: SavedSession[],
): Promise<InterruptedCapture[]> {
  const held = await heldCaptureIds();
  return listCaptureCheckpoints().filter((capture) => {
    if (held.has(capture.key.slice(CAPTURE_CHECKPOINT_PREFIX.length))) {
      return false;
    }
    if (
      capture.kind === "checkpoint" &&
      (sessions.some((session) => session.id === capture.checkpoint.id) ||
        !hasCheckpointedObservation(capture.checkpoint))
    ) {
      removeCaptureCheckpoint(capture.key);
      return false;
    }
    return true;
  });
}

export function mergeInterruptedCaptures(
  current: InterruptedCapture[],
  added: InterruptedCapture[],
) {
  const keys = new Set(current.map((item) => item.key));
  return [...current, ...added.filter((item) => !keys.has(item.key))];
}

// What a checkpoint holds, ignoring its write time.
export function checkpointState(checkpoint: CaptureCheckpoint) {
  return JSON.stringify([
    checkpoint.id,
    observationFingerprint(checkpoint.segments, checkpoint.pauses),
    checkpoint.analysis?.run.id ?? null,
    checkpoint.transcription ?? null,
  ]);
}
