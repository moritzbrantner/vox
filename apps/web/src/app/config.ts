// Fixed settings of the tracker: storage keys, transcription engines and the compute client.
import { createComputeClient, processingPolicyForServerUrl } from "@stutter-tracker/compute-client";
import { isTauri } from "@tauri-apps/api/core";
import { loadRemoteConsent } from "../storage/localStorage";
import { type TranscriptionEngine, type TranscriptionEngineId } from "../types";

export const STORE_KEY = "stutter-tracker:sessions";
export const VOICE_KEY = "stutter-tracker:voiceprint";
export const SPEAKERS_KEY = "stutter-tracker:speakers";
/** How long speaker removal waits for the startup load before it is enabled anyway. */
export const SPEAKER_LOAD_GRACE_MS = 5_000;
export const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
export const LANGUAGES = ["en-US", "de-DE", "en-GB"];
const COMPUTE_SERVER_URL = import.meta.env.VITE_STUTTER_SERVER_URL ?? "http://127.0.0.1:8787";
export const TRANSCRIPTION_CHUNK_SECONDS = 8;
/** Upper bound for browser recognition to deliver its final results after Stop. */
export const RECOGNITION_END_TIMEOUT_MS = 3_000;
export const TRANSCRIPTION_TARGET_SAMPLE_RATE = 16_000;
/** whisper's own window: a post-session reference transcript is sent in chunks of this length. */
export const REFERENCE_CHUNK_SECONDS = 30;
export const TRANSCRIPTION_ENGINES: TranscriptionEngine[] = [
  {
    id: "browser",
    label: "Browser Speech",
    mode: "Live",
    nativeOnly: false,
    models: ["default"],
  },
  {
    id: "whisperCpp",
    label: "whisper.cpp",
    mode: "Chunked",
    nativeOnly: true,
    models: [
      "tiny.en",
      "tiny",
      "base.en",
      "base",
      "small.en",
      "small",
      "medium.en",
      "medium",
      "large-v3",
      "large-v3-turbo",
    ],
  },
  {
    id: "whisperCli",
    label: "Whisper CLI",
    mode: "Chunked",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large", "turbo"],
  },
  {
    id: "fasterWhisper",
    label: "Faster-Whisper",
    mode: "Chunked",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large-v3", "distil-large-v3"],
  },
];
const COMPUTE_API_TOKEN = import.meta.env.VITE_STUTTER_API_TOKEN ?? "";
export const CONSENT_SERVER_URL = COMPUTE_SERVER_URL.trim().replace(/\/+$/, "");
// The destination is fixed for the page lifetime; consent changes reload the page so an
// in-flight run can never switch destinations.
export const computeClient = createComputeClient({
  processingPolicy: processingPolicyForServerUrl(
    COMPUTE_SERVER_URL,
    loadRemoteConsent(CONSENT_SERVER_URL),
  ),
  apiToken: COMPUTE_API_TOKEN,
});

export function isDesktopApp() {
  return isTauri() || "__TAURI_INTERNALS__" in window;
}

export function getTranscriptionEngine(id: TranscriptionEngineId) {
  return TRANSCRIPTION_ENGINES.find((engine) => engine.id === id) ?? TRANSCRIPTION_ENGINES[0];
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    __TAURI_INTERNALS__?: unknown;
  }
}
