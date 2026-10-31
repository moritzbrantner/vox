import type { TranscribeAudioResult } from "@stutter-tracker/shared";

export function recordingFileInfo(uri: string) {
  const cleanUri = uri.split("?")[0] ?? uri;
  const extension = cleanUri.split(".").pop()?.toLowerCase() || "m4a";
  const mimeType =
    extension === "wav"
      ? "audio/wav"
      : extension === "mp3"
        ? "audio/mpeg"
        : extension === "aac"
          ? "audio/aac"
          : "audio/mp4";
  return {
    filename: `recording.${extension}`,
    mimeType,
  };
}

export function transcriptionToAnalysisRequest(result: TranscribeAudioResult) {
  return {
    segments: result.segments,
    pauses: [],
  };
}

export function mobileErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("unauthorized")) {
    return "Compute server rejected the API token";
  }
  if (message.includes("native_worker_unavailable")) {
    return "Compute server has no native transcription worker configured";
  }
  if (message.includes("server_busy")) {
    return "Compute server is busy; try again shortly";
  }
  if (message.includes("Network request failed") || message.includes("Failed to fetch")) {
    return "Compute server is unreachable";
  }
  return message;
}

/**
 * Removes a recording from the app's cache once it was uploaded or cancelled, so raw speech does
 * not stay on the device (vox#85). The mobile app keeps no other local copy of a session.
 */
export function discardRecordingFile(
  uri: string | null | undefined,
  remove: (uri: string) => void,
) {
  if (!uri) return false;
  try {
    remove(uri);
    return true;
  } catch {
    // Already gone, or the OS clears the cache directory later.
    return false;
  }
}
