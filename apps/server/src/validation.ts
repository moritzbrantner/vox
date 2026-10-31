import {
  type AnalyzeSpeechRequest,
  type MeasuredCaptureMetrics,
  type SpeakerProfile,
  type TranscribeAudioRequest,
  type TranscriptionEngineId,
} from "@stutter-tracker/shared";
import { HttpError } from "./http";
import type { ServerFormData } from "./http";

const PROVIDERS = new Set<TranscriptionEngineId>([
  "browser",
  "whisperCpp",
  "whisperCli",
  "fasterWhisper",
]);

type UnknownRecord = Record<string, unknown>;

export function validateAnalyzeSpeechRequest(value: unknown): AnalyzeSpeechRequest {
  const body = object(value);
  const segments = array(body.segments, "segments").map(validateSegment);
  const pauses = array(body.pauses, "pauses").map(validatePause);
  const hasSamples = body.samples !== undefined;
  const hasSampleRate = body.sampleRate !== undefined;
  if (hasSamples !== hasSampleRate) {
    throw invalid("samples and sampleRate must be provided together");
  }
  const request: AnalyzeSpeechRequest = {
    segments,
    pauses,
    sessionStartedAt:
      typeof body.sessionStartedAt === "string" ? body.sessionStartedAt.trim() : undefined,
  };
  if (hasSamples) {
    request.samples = finiteNumberArray(body.samples, "samples");
    request.sampleRate = positiveInteger(body.sampleRate, "sampleRate");
  }
  return request;
}

const CAPTURE_METRIC_FIELDS = [
  "sampleRate",
  "channels",
  "samplesPerChannel",
  "durationSeconds",
  "clippedSampleCount",
  "clippedSampleRatio",
  "frameSamples",
  "frameCount",
  "noInputSeconds",
  "longestNoInputSeconds",
  "activitySeconds",
] as const;
const CAPTURE_CONFIG_FIELDS = ["frameSeconds", "clipLevel", "noInputRms", "activityRms"] as const;

/** The native worker's capture observations, or null when they are not well-formed. */
export function validateMeasuredCaptureMetrics(value: unknown): MeasuredCaptureMetrics | null {
  const finiteFields = (record: unknown, fields: readonly string[]) =>
    typeof record === "object" &&
    record !== null &&
    !Array.isArray(record) &&
    fields.every((field) => {
      const entry = (record as UnknownRecord)[field];
      return typeof entry === "number" && Number.isFinite(entry) && entry >= 0;
    });
  if (!finiteFields(value, CAPTURE_METRIC_FIELDS)) return null;
  const config = (value as UnknownRecord).config;
  if (!finiteFields(config, CAPTURE_CONFIG_FIELDS)) return null;
  const metrics: Record<string, unknown> = {};
  for (const field of CAPTURE_METRIC_FIELDS) metrics[field] = (value as UnknownRecord)[field];
  metrics.config = Object.fromEntries(
    CAPTURE_CONFIG_FIELDS.map((field) => [field, (config as UnknownRecord)[field]]),
  );
  return metrics as MeasuredCaptureMetrics;
}

export function validateSpeakerProfilesBody(value: unknown): SpeakerProfile[] {
  const body = object(value);
  return array(body.speakers ?? [], "speakers")
    .map(validateSpeakerProfile)
    .filter((speaker): speaker is SpeakerProfile => speaker !== null);
}

export function validateSpeakerProfile(value: unknown): SpeakerProfile | null {
  const body = object(value);
  const id = normalizeSpeakerProfileId(body.id);
  const label = optionalTrimmedString(body.label, "label") ?? "";
  if (!id || !label) {
    return null;
  }
  const embeddings = array(body.embeddings, "embeddings")
    .filter(Array.isArray)
    .map((embedding) => finiteNumberArray(embedding, "embedding"))
    .filter((embedding) => embedding.length > 0);
  if (!embeddings.length) {
    return null;
  }
  return {
    id,
    label: limitString(label, 120),
    embeddings,
    sampleRate: positiveInteger(body.sampleRate, "sampleRate"),
    sampleCount: positiveInteger(body.sampleCount, "sampleCount"),
  };
}

export function normalizeSpeakerProfileId(value: unknown): string {
  return optionalTrimmedString(value, "id") ?? "";
}

export function validateCreateSpeakerProfileRequest(value: unknown) {
  const body = object(value);
  return {
    id: optionalTrimmedString(body.id, "id"),
    label: limitString(requiredTrimmedString(body.label, "label") || "Speaker", 120),
    samples: finiteNumberArray(body.samples, "samples"),
    sampleRate: positiveInteger(body.sampleRate, "sampleRate"),
  };
}

export function validateIdentifySpeakerRequest(value: unknown) {
  const body = object(value);
  return {
    samples: finiteNumberArray(body.samples, "samples"),
    sampleRate: positiveInteger(body.sampleRate, "sampleRate"),
    speakers: array(body.speakers, "speakers")
      .map(validateSpeakerProfile)
      .filter((speaker): speaker is SpeakerProfile => speaker !== null),
    threshold: optionalFiniteNumber(body.threshold, "threshold"),
    maxResults: clampInteger(body.maxResults, "maxResults", 1, 10, 3),
  };
}

export function validateTranscriptionModelsRequest(value: unknown) {
  const body = object(value);
  return { provider: provider(body.provider) };
}

export function validateDownloadModelRequest(value: unknown) {
  const body = object(value);
  const selectedProvider = provider(body.provider);
  if (selectedProvider === "browser") {
    throw invalid("browser transcription models are not downloaded by the compute server");
  }
  return {
    provider: selectedProvider,
    model: requiredTrimmedString(body.model, "model"),
  };
}

export function validateTranscribeAudioRequest(
  value: unknown,
  maxSampleCount: number,
): TranscribeAudioRequest {
  const body = object(value);
  const selectedProvider = provider(body.provider);
  if (selectedProvider === "browser") {
    throw invalid("browser transcription runs in the client");
  }
  const samples = finiteNumberArray(body.samples, "samples");
  if (samples.length > maxSampleCount) {
    throw new HttpError("request_too_large", "too many audio samples", 413);
  }
  return {
    samples,
    sampleRate: positiveInteger(body.sampleRate, "sampleRate"),
    provider: selectedProvider,
    model: requiredTrimmedString(body.model, "model"),
    language: optionalTrimmedString(body.language, "language"),
    device: devicePreference(body.device),
  };
}

function devicePreference(value: unknown): "auto" | "cpu" {
  if (value === undefined || value === "auto") return "auto";
  if (value === "cpu") return "cpu";
  throw invalid("device must be auto or cpu");
}

export function validateTranscribeAudioFileForm(formData: ServerFormData) {
  const audio = formData.get("audio");
  if (!(audio instanceof File)) {
    throw invalid("audio file is required");
  }
  const selectedProvider = provider(formData.get("provider"));
  if (selectedProvider === "browser") {
    throw invalid("browser transcription runs in the client");
  }
  return {
    audio,
    provider: selectedProvider as Exclude<TranscriptionEngineId, "browser">,
    model: requiredTrimmedString(formData.get("model"), "model"),
    language: optionalTrimmedString(formData.get("language"), "language"),
  };
}

function validateSegment(value: unknown) {
  const body = object(value);
  return {
    text: typeof body.text === "string" ? body.text : "",
    startSeconds: finiteNumber(body.startSeconds, "startSeconds"),
    endSeconds: finiteNumber(body.endSeconds, "endSeconds"),
    confidence: optionalFiniteNumber(body.confidence, "confidence"),
    speakerId: optionalTrimmedString(body.speakerId, "speakerId"),
    speakerLabel: optionalTrimmedString(body.speakerLabel, "speakerLabel"),
    speakerScore: optionalFiniteNumber(body.speakerScore, "speakerScore"),
    isFinal: body.isFinal === true,
    ...(body.alignment === "unaligned" ? { alignment: "unaligned" as const } : {}),
  };
}

function validatePause(value: unknown) {
  const body = object(value);
  return {
    startSeconds: finiteNumber(body.startSeconds, "startSeconds"),
    endSeconds: finiteNumber(body.endSeconds, "endSeconds"),
    afterText: optionalTrimmedString(body.afterText, "afterText"),
  };
}

function object(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("request body must be an object");
  }
  return value as UnknownRecord;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(`${field} must be an array`);
  }
  return value;
}

function finiteNumberArray(value: unknown, field: string): number[] {
  return array(value, field).map((item, index) => finiteNumber(item, `${field}[${index}]`));
}

function provider(value: unknown): TranscriptionEngineId {
  if (typeof value !== "string" || !PROVIDERS.has(value as TranscriptionEngineId)) {
    throw invalid("provider is unsupported");
  }
  return value as TranscriptionEngineId;
}

function positiveInteger(value: unknown, field: string) {
  const number = finiteNumber(value, field);
  if (number <= 0) {
    throw invalid(`${field} must be greater than zero`);
  }
  return Math.round(number);
}

function finiteNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${field} must be a finite number`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, field: string) {
  return value === undefined ? undefined : finiteNumber(value, field);
}

function requiredTrimmedString(value: unknown, field: string) {
  if (typeof value !== "string") {
    throw invalid(`${field} must be a string`);
  }
  return limitString(value.trim(), 120);
}

function optionalTrimmedString(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredTrimmedString(value, field);
}

function clampInteger(value: unknown, field: string, min: number, max: number, fallback: number) {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(max, Math.max(min, positiveInteger(value, field)));
}

function limitString(value: string, maxLength: number) {
  return value.slice(0, maxLength);
}

function invalid(message: string): HttpError {
  return new HttpError("invalid_request", message, 400);
}
