// Speech/non-speech evidence of a capture (audio-analysis#151): Silero VAD from audio-analysis,
// live during recording and finite after Stop. Sound activity (RMS) is capture health, never
// speech; a missing detector is "unavailable", never "no speech"; detected speech is unattributed.
import {
  type RecordingDescriptor,
  mergedDiscontinuities,
  streamSecondsToSessionSeconds,
} from "./capture";
import type { SessionRecord } from "./sessions";

export const VOICE_ACTIVITY_SCHEMA_VERSION = 1;

/** The provider, model and configuration that produced the evidence (reported by the desktop). */
export type VoiceActivityProvider = {
  id: string;
  model: string;
  modelSha256: string;
  threshold: number;
  minSpeechMs: number;
  minSilenceMs: number;
  speechPadMs: number;
  maxSpeechSeconds: number;
  sampleRate: number;
  resampling: string;
};

/**
 * - `detected`: the provider analyzed the audio; spans are its speech, the rest its non-speech.
 * - `unavailable`: no provider on this device (no model, runtime or desktop app): nothing known.
 * - `failed`: the provider failed; nothing known.
 * - `interrupted` (live only): chunks were missing or out of order, so live detection stopped.
 */
export type VoiceActivityStatus = "detected" | "unavailable" | "failed" | "interrupted";

/** A provider speech span on the session clock. Speech of someone, never of a known speaker. */
export type SpeechInterval = {
  startSeconds: number;
  endSeconds: number;
  /** Silero's highest speech probability within the span (the provider's own score). */
  maxSpeechProbability: number;
};

/** A part of the session the evidence says nothing about, and why. */
export type UnknownInterval = {
  startSeconds: number;
  endSeconds: number;
  reason: "captureGap" | "notAnalyzed";
};

/**
 * Same-input comparison of the finalized live spans with the finite spans. Both run the same
 * provider and settings over the same resampled samples, so the declared tolerance is exact
 * equality; any difference is a mismatch, not drift.
 */
export type LiveFiniteParity =
  | { state: "match"; spans: number }
  | { state: "mismatch"; liveSpans: number; finiteSpans: number; maxBoundaryDeltaSeconds: number }
  | { state: "notComparable"; reason: string };

export type LiveVoiceActivitySummary = {
  status: VoiceActivityStatus;
  /** Updates received from the live detector. */
  revisions: number;
  finalizedSpans: number;
  parity: LiveFiniteParity;
  /** Slowest single live update, milliseconds of detector time. */
  maxUpdateMs: number;
  reason?: string;
};

/** Finalized voice activity of one capture, as saved with the analysis run. */
export type VoiceActivityEvidence = {
  schemaVersion: typeof VOICE_ACTIVITY_SCHEMA_VERSION;
  /** The capture run (`RecordingDescriptor.runId`) this describes. */
  captureRunId: string;
  analyzedAt: string;
  status: VoiceActivityStatus;
  provider: VoiceActivityProvider | null;
  reason?: string;
  /** Session seconds the finite analysis covered. */
  coverage: { startSeconds: number; endSeconds: number };
  speech: SpeechInterval[];
  unknown: UnknownInterval[];
  /** Always unattributed: VAD says someone spoke, not who. */
  attribution: "unattributed";
  /** Finite detector time, milliseconds. */
  processingMs: number;
  live: LiveVoiceActivitySummary | null;
};

/** A span as the desktop reports it: seconds of 16 kHz detector input. */
export type DetectorSpan = { startSeconds: number; endSeconds: number; score: number };

export function compareLiveWithFinite(
  live: DetectorSpan[],
  finite: DetectorSpan[],
): LiveFiniteParity {
  if (live.length === finite.length && live.every((span, i) => sameSpan(span, finite[i]))) {
    return { state: "match", spans: live.length };
  }
  let maxBoundaryDeltaSeconds = 0;
  for (let i = 0; i < Math.min(live.length, finite.length); i += 1) {
    maxBoundaryDeltaSeconds = Math.max(
      maxBoundaryDeltaSeconds,
      Math.abs(live[i].startSeconds - finite[i].startSeconds),
      Math.abs(live[i].endSeconds - finite[i].endSeconds),
    );
  }
  return {
    state: "mismatch",
    liveSpans: live.length,
    finiteSpans: finite.length,
    maxBoundaryDeltaSeconds,
  };
}

function sameSpan(a: DetectorSpan, b: DetectorSpan) {
  return a.startSeconds === b.startSeconds && a.endSeconds === b.endSeconds && a.score === b.score;
}

/**
 * Builds the saved evidence from the finite result over the capture's samples. `streamOffsetSeconds`
 * is where the analyzed samples start in the recorded stream (0 for the whole capture).
 */
export function voiceActivityEvidence(input: {
  descriptor: RecordingDescriptor;
  analyzedAt: string;
  status: VoiceActivityStatus;
  provider: VoiceActivityProvider | null;
  reason?: string;
  spans: DetectorSpan[];
  streamOffsetSeconds: number;
  analyzedSeconds: number;
  captureSeconds: number;
  processingMs: number;
  live: LiveVoiceActivitySummary | null;
}): VoiceActivityEvidence {
  const { descriptor } = input;
  const toSession = (seconds: number) => streamSecondsToSessionSeconds(descriptor, seconds);
  const coverage = {
    startSeconds: toSession(input.streamOffsetSeconds),
    endSeconds: toSession(input.streamOffsetSeconds + input.analyzedSeconds),
  };
  const unknown: UnknownInterval[] = mergedDiscontinuities(descriptor).map((gap) => ({
    ...gap,
    reason: "captureGap" as const,
  }));
  if (input.streamOffsetSeconds > 0) {
    unknown.push({
      startSeconds: toSession(0),
      endSeconds: coverage.startSeconds,
      reason: "notAnalyzed",
    });
  }
  const captureEnd = toSession(input.captureSeconds);
  if (captureEnd > coverage.endSeconds) {
    unknown.push({
      startSeconds: coverage.endSeconds,
      endSeconds: captureEnd,
      reason: "notAnalyzed",
    });
  }
  unknown.sort((a, b) => a.startSeconds - b.startSeconds);
  return {
    schemaVersion: VOICE_ACTIVITY_SCHEMA_VERSION,
    captureRunId: descriptor.runId,
    analyzedAt: input.analyzedAt,
    status: input.status,
    provider: input.provider,
    ...(input.reason ? { reason: input.reason } : {}),
    coverage,
    speech:
      input.status === "detected"
        ? input.spans.map((span) => ({
            startSeconds: toSession(input.streamOffsetSeconds + span.startSeconds),
            endSeconds: toSession(input.streamOffsetSeconds + span.endSeconds),
            maxSpeechProbability: span.score,
          }))
        : [],
    unknown,
    attribution: "unattributed",
    processingMs: input.processingMs,
    live: input.live,
  };
}

/**
 * The newest completed run that carries voice activity: the current report, else the newest prior
 * run. A newer run without acoustic VAD (e.g. transcript-only reanalysis) never hides it.
 */
export function latestVoiceActivity(
  record: Pick<SessionRecord, "analysis" | "report" | "priorAnalyses">,
): { runId: string; evidence: VoiceActivityEvidence } | null {
  if (record.report.voiceActivity) {
    return { runId: record.analysis.id, evidence: record.report.voiceActivity };
  }
  for (let i = record.priorAnalyses.length - 1; i >= 0; i -= 1) {
    const prior = record.priorAnalyses[i];
    if (prior.report.voiceActivity)
      return { runId: prior.id, evidence: prior.report.voiceActivity };
  }
  return null;
}

const STATUSES: readonly string[] = ["detected", "unavailable", "failed", "interrupted"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInterval(value: unknown): value is { startSeconds: number; endSeconds: number } {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds
  );
}

function isProvider(value: unknown): value is VoiceActivityProvider {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.model === "string" &&
    typeof value.modelSha256 === "string" &&
    ["threshold", "minSpeechMs", "minSilenceMs", "speechPadMs", "maxSpeechSeconds", "sampleRate"]
      .map((key) => value[key])
      .every(isFiniteNumber) &&
    typeof value.resampling === "string"
  );
}

function isParity(value: unknown): value is LiveFiniteParity {
  if (!isRecord(value)) return false;
  if (value.state === "match") return isFiniteNumber(value.spans);
  if (value.state === "notComparable") return typeof value.reason === "string";
  return (
    value.state === "mismatch" &&
    isFiniteNumber(value.liveSpans) &&
    isFiniteNumber(value.finiteSpans) &&
    isFiniteNumber(value.maxBoundaryDeltaSeconds)
  );
}

function isLiveSummary(value: unknown): value is LiveVoiceActivitySummary {
  return (
    isRecord(value) &&
    STATUSES.includes(value.status as string) &&
    isFiniteNumber(value.revisions) &&
    isFiniteNumber(value.finalizedSpans) &&
    isFiniteNumber(value.maxUpdateMs) &&
    isParity(value.parity) &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

/** Validates saved or imported evidence; a mismatched schema is rejected whole. */
export function isVoiceActivityEvidence(value: unknown): value is VoiceActivityEvidence {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== VOICE_ACTIVITY_SCHEMA_VERSION) return false;
  if (typeof value.captureRunId !== "string" || typeof value.analyzedAt !== "string") return false;
  if (!STATUSES.includes(value.status as string) || value.status === "interrupted") return false;
  if (value.provider !== null && !isProvider(value.provider)) return false;
  if (value.status === "detected" && value.provider === null) return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (!isInterval(value.coverage)) return false;
  if (
    !Array.isArray(value.speech) ||
    !value.speech.every(
      (span) => isInterval(span) && isFiniteNumber((span as SpeechInterval).maxSpeechProbability),
    )
  ) {
    return false;
  }
  if (value.status !== "detected" && value.speech.length > 0) return false;
  if (
    !Array.isArray(value.unknown) ||
    !value.unknown.every(
      (gap) =>
        isInterval(gap) &&
        ((gap as UnknownInterval).reason === "captureGap" ||
          (gap as UnknownInterval).reason === "notAnalyzed"),
    )
  ) {
    return false;
  }
  return (
    value.attribution === "unattributed" &&
    isFiniteNumber(value.processingMs) &&
    (value.live === null || isLiveSummary(value.live))
  );
}
