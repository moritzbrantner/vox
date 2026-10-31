// User-facing wording for errors of the compute server and the recorder.
import { BrowserRecorderError } from "../audio/browserRecorder";

export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("native_worker_unavailable")) {
    return "Compute server has no native transcription worker configured.";
  }
  if (message.includes("server_busy")) {
    return "Compute server is busy; try again shortly.";
  }
  if (message.includes("unauthorized")) {
    return "Compute server rejected the API token.";
  }
  return message;
}

export function recordingErrorMessage(error: unknown) {
  if (error instanceof BrowserRecorderError) {
    if (error.code === "denied") {
      return "Microphone permission was denied";
    }
    if (error.code === "unavailable") {
      return "Microphone recording is unavailable in this browser";
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Recording failed: ${message}`;
}
