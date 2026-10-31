// Transcription calls, chunk bookkeeping and the stored engine settings.
import {
  type TranscriptCompute,
  type TranscriptPreprocessing,
  resampleSamples as sharedResampleSamples,
} from "@stutter-tracker/shared";
import { invoke } from "@tauri-apps/api/core";
import {
  type TranscriptSegment,
  type TranscriptionChunkRecord,
  type TranscriptionChunkStats,
  type TranscriptionChunkSummary,
  type TranscriptionEngineId,
  type TranscriptionModelStatus,
  type TranscriptionSettings,
} from "../types";
import {
  TRANSCRIPTION_CHUNK_SECONDS,
  TRANSCRIPTION_ENGINES,
  TRANSCRIPTION_KEY,
  TRANSCRIPTION_TARGET_SAMPLE_RATE,
  computeClient,
  getTranscriptionEngine,
  isDesktopApp,
} from "./config";

export async function loadTranscriptionModels(
  engine: TranscriptionEngineId,
): Promise<TranscriptionModelStatus[]> {
  if (!isDesktopApp()) {
    return computeClient.transcriptionModels(engine);
  }
  const result = await invoke<{ models: TranscriptionModelStatus[] }>("transcription_models", {
    request: { provider: engine },
  });
  return result.models;
}

export async function transcribeAudio(
  samples: number[],
  sampleRate: number,
  settings: TranscriptionSettings,
  language: string,
): Promise<{
  segments: TranscriptSegment[];
  provider?: TranscriptionEngineId;
  model?: string;
  language?: string | null;
  compute?: TranscriptCompute;
}> {
  if (!isDesktopApp()) {
    return computeClient.transcribeAudio({
      samples,
      sampleRate,
      provider: settings.engine,
      model: settings.model,
      language,
      device: settings.device,
    });
  }
  return invoke<{
    segments: TranscriptSegment[];
    provider?: TranscriptionEngineId;
    model?: string;
    language?: string | null;
    compute?: TranscriptCompute;
  }>("transcribe_audio", {
    request: {
      samples,
      sampleRate,
      provider: settings.engine,
      model: settings.model,
      language,
      device: settings.device,
    },
  });
}

export async function downloadTranscriptionModel(engine: TranscriptionEngineId, model: string) {
  if (!isDesktopApp()) {
    return computeClient.downloadTranscriptionModel(engine, model);
  }
  return invoke<TranscriptionModelStatus>("download_transcription_model", {
    request: {
      provider: engine,
      model,
    },
  });
}

export const resampleSamples = sharedResampleSamples;

export function offsetTranscriptSegments(
  segments: TranscriptSegment[],
  offsetSeconds: number,
): TranscriptSegment[] {
  return segments.map((segment) => ({
    ...segment,
    startSeconds: segment.startSeconds + offsetSeconds,
    endSeconds: segment.endSeconds + offsetSeconds,
  }));
}

export function updateTranscriptionChunk(
  chunks: TranscriptionChunkRecord[],
  id: number,
  patch: Partial<TranscriptionChunkRecord>,
) {
  return chunks.map((chunk) => (chunk.id === id ? { ...chunk, ...patch } : chunk));
}

export function summarizeTranscriptionChunks(
  chunks: Pick<TranscriptionChunkRecord, "status">[],
): TranscriptionChunkSummary {
  return chunks.reduce<TranscriptionChunkSummary>(
    (summary, chunk) => {
      summary.total += 1;
      summary[chunk.status] += 1;
      return summary;
    },
    {
      total: 0,
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    },
  );
}

export function emptyChunkStats(): TranscriptionChunkStats {
  return {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    lastMessage: "No chunks yet",
  };
}

export function loadTranscriptionSettings(): TranscriptionSettings {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TRANSCRIPTION_KEY) ?? "null",
    ) as Partial<TranscriptionSettings> | null;
    const fallback = defaultTranscriptionSettings();
    const engine =
      TRANSCRIPTION_ENGINES.find((item) => item.id === parsed?.engine) ??
      getTranscriptionEngine(fallback.engine);
    const model = engine.models.includes(parsed?.model ?? "")
      ? (parsed?.model ?? engine.models[0])
      : engine.models.includes(fallback.model)
        ? fallback.model
        : engine.models[0];
    return { engine: engine.id, model, device: parsed?.device === "cpu" ? "cpu" : "auto" };
  } catch {
    return defaultTranscriptionSettings();
  }
}

function defaultTranscriptionSettings(): TranscriptionSettings {
  return isDesktopApp()
    ? { engine: "whisperCpp", model: "base.en", device: "auto" }
    : { engine: "browser", model: "default", device: "auto" };
}

export function staticModelStatuses(engine: TranscriptionEngineId): TranscriptionModelStatus[] {
  return getTranscriptionEngine(engine).models.map((model) => ({
    id: model,
    label: model,
    cached: engine === "browser",
    downloadable: false,
  }));
}

/** What the provisional transcription did to the captured audio before the model saw it. */
export function provisionalPreprocessing(
  engine: TranscriptionEngineId,
  captureSampleRate: number,
): TranscriptPreprocessing {
  return engine === "browser"
    ? { captureSampleRate: null, modelSampleRate: null, chunkSeconds: null }
    : {
        captureSampleRate,
        modelSampleRate: TRANSCRIPTION_TARGET_SAMPLE_RATE,
        chunkSeconds: TRANSCRIPTION_CHUNK_SECONDS,
      };
}
