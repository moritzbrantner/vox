// Recording descriptor, common session time base and capture-quality state.
// Platform adapters fill the descriptor with what they can actually observe; unknown stays unknown.

export type CaptureOrigin = "browser" | "mobile" | "desktop" | "import";

/**
 * - appInput: the stream the app received. On browsers with echo cancellation / noise
 *   suppression requested this is already processed and is NOT raw hardware PCM.
 * - interventionOutput: audio the app produced or altered (e.g. delayed/pitch-shifted feedback).
 */
export type CaptureStreamRole = "appInput" | "interventionOutput";

export type PreprocessingSetting = {
  requested?: boolean;
  /** What the platform reports as applied; undefined when it cannot tell. */
  applied?: boolean;
};

export type CaptureInterval = {
  /** Session-clock seconds. */
  startSeconds: number;
  endSeconds: number;
  reason: "dropout" | "interrupted" | "routeChange" | "paused";
};

export type RecordingDescriptor = {
  sessionId: string;
  runId: string;
  origin: CaptureOrigin;
  role: CaptureStreamRole;
  /** Actual stream sample rate and channel count, not the requested ones. */
  sampleRate: number;
  channelCount: number;
  /** Platform route/device label only when exposed; never guessed. */
  deviceRoute?: string;
  /** Session-clock seconds at which sample 0 of this stream was captured. */
  startOffsetSeconds: number;
  preprocessing: {
    echoCancellation: PreprocessingSetting;
    noiseSuppression: PreprocessingSetting;
    autoGainControl: PreprocessingSetting;
  };
  /** Session-clock intervals for which the stream has no samples (capture resumed afterwards). */
  discontinuities: CaptureInterval[];
  /** Mixed speakers are never attributed to the user by default. */
  speakerAssessment: "singleSpeakerDeclared" | "unknown" | "overlapDetected";
};

/**
 * True only when the capture path affirmatively attests nothing altered the stream before the
 * app saw it. Imported files can never be attested.
 */
export function isUnprocessedInput(descriptor: RecordingDescriptor) {
  if (descriptor.role !== "appInput" || descriptor.origin === "import") return false;
  return Object.values(descriptor.preprocessing).every((setting) => setting.applied === false);
}

/**
 * Assessment scores the speaker's captured speech only. Audio the app produced or altered (delayed
 * or pitch-shifted feedback) is refused rather than silently analyzed as the speaker's input.
 */
export function requireSpeakerInput(descriptor: RecordingDescriptor): RecordingDescriptor {
  if (descriptor.role !== "appInput") {
    throw new Error(
      `Capture ${descriptor.runId} is ${descriptor.role}, not the speaker's input; it cannot be assessed.`,
    );
  }
  return descriptor;
}

/** Sorted, merged gap intervals, so overlapping events are counted once. */
export function mergedDiscontinuities(descriptor: RecordingDescriptor) {
  const sorted = descriptor.discontinuities
    .filter((gap) => gap.endSeconds > gap.startSeconds)
    .map((gap) => ({ startSeconds: gap.startSeconds, endSeconds: gap.endSeconds }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: Array<{ startSeconds: number; endSeconds: number }> = [];
  for (const gap of sorted) {
    const last = merged[merged.length - 1];
    if (last && gap.startSeconds <= last.endSeconds) {
      last.endSeconds = Math.max(last.endSeconds, gap.endSeconds);
    } else {
      merged.push(gap);
    }
  }
  return merged;
}

/** Session-clock seconds of a sample index; skips the gaps that occurred before that sample. */
export function sampleIndexToSessionSeconds(descriptor: RecordingDescriptor, sampleIndex: number) {
  let seconds = descriptor.startOffsetSeconds + sampleIndex / descriptor.sampleRate;
  for (const gap of mergedDiscontinuities(descriptor)) {
    if (gap.startSeconds <= seconds) seconds += gap.endSeconds - gap.startSeconds;
  }
  return seconds;
}

/** Nearest sample index for session-clock seconds; null outside the stream or inside a gap. */
export function sessionSecondsToSampleIndex(
  descriptor: RecordingDescriptor,
  sessionSeconds: number,
  sampleCount: number,
): number | null {
  let streamSeconds = sessionSeconds - descriptor.startOffsetSeconds;
  for (const gap of mergedDiscontinuities(descriptor)) {
    if (sessionSeconds >= gap.startSeconds && sessionSeconds < gap.endSeconds) return null;
    if (gap.endSeconds <= sessionSeconds) streamSeconds -= gap.endSeconds - gap.startSeconds;
  }
  const index = Math.round(streamSeconds * descriptor.sampleRate);
  return index < 0 || index >= sampleCount ? null : index;
}

/**
 * Descriptor of the same stream after resampling with `resampleSamples`, which aligns the first
 * output sample with the first input sample; the session offset is therefore unchanged.
 */
export function resampledDescriptor(
  descriptor: RecordingDescriptor,
  targetSampleRate: number,
): RecordingDescriptor {
  return { ...descriptor, sampleRate: targetSampleRate };
}

/** Converts a time relative to the stream's samples (e.g. a transcript segment) to session time. */
export function streamSecondsToSessionSeconds(
  descriptor: RecordingDescriptor,
  streamSeconds: number,
) {
  return sampleIndexToSessionSeconds(descriptor, streamSeconds * descriptor.sampleRate);
}

/**
 * Generic PCM observations, measured by the audio-analysis capability
 * (moritzbrantner/audio-analysis#137). This package owns only their interpretation.
 */
export type CaptureMetrics = {
  durationSeconds: number;
  channelCount: number;
  clippedSampleRatio: number;
  /** Seconds of frames whose RMS is below the no-input floor. */
  silentSeconds: number;
  /** Seconds of frames above the speech-activity floor. */
  activeSeconds: number;
  /** Longest continuous run of silent frames. */
  longestSilenceSeconds: number;
};

export type CaptureQualityIssue =
  | "noChannels"
  | "tooShort"
  | "noInput"
  | "insufficientSpeech"
  | "clipping"
  | "discontinuous"
  | "speakerUnknown"
  | "speakerOverlap";

export type CaptureQuality =
  | { state: "usable"; issues: [] }
  | { state: "unknown"; issues: CaptureQualityIssue[]; explanation: string };

/**
 * Wire shape of audio-analysis `capture_metrics` / `captureMetrics` (moritzbrantner/audio-analysis#143)
 * as returned by native analysis in `AnalysisReport.captureMetrics`.
 */
export type MeasuredCaptureMetrics = {
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
  durationSeconds: number;
  clippedSampleCount: number;
  clippedSampleRatio: number;
  frameSamples: number;
  frameCount: number;
  noInputSeconds: number;
  longestNoInputSeconds: number;
  activitySeconds: number;
  config: { frameSeconds: number; clipLevel: number; noInputRms: number; activityRms: number };
};

/** Maps the capability's observations onto the quality gate's input. */
export function captureMetricsFromMeasurement(measured: MeasuredCaptureMetrics): CaptureMetrics {
  return {
    durationSeconds: measured.durationSeconds,
    channelCount: measured.channels,
    clippedSampleRatio: measured.clippedSampleRatio,
    silentSeconds: measured.noInputSeconds,
    activeSeconds: measured.activitySeconds,
    longestSilenceSeconds: measured.longestNoInputSeconds,
  };
}

/**
 * Quality of one analysis run of a capture. "unmeasured" means the processing path that analyzed
 * the audio could not measure it (for example browser-local or compute-server analysis, which do
 * not yet run the audio-analysis capture kernel); it makes no claim either way.
 */
export type RunCaptureQuality = (CaptureQuality | { state: "unmeasured"; issues: [] }) & {
  /** Which part of the capture the measurement covered; absent when nothing was measured. */
  coverage?: CaptureCoverage;
};

/**
 * Analysis measures only the audio window it was sent (the most recent part of a long capture),
 * so a quality verdict states how much of the recorded audio it is based on.
 */
export type CaptureCoverage = {
  /** Seconds of audio the measurement covered: the end of the capture. */
  measuredSeconds: number;
  /** Seconds of audio recorded for the whole capture. */
  captureSeconds: number;
};

/** Shorter differences are rounding between sample rates, not an unmeasured part. */
const COVERAGE_TOLERANCE_SECONDS = 0.5;

/**
 * Quality of the analyzed window of a capture. `captureSeconds` is the recorded audio of the
 * whole capture; when the measured window is shorter, the result says so in `coverage`.
 */
export function assessRunCaptureQuality(
  descriptor: RecordingDescriptor,
  measured: MeasuredCaptureMetrics | undefined,
  captureSeconds?: number,
): RunCaptureQuality {
  requireSpeakerInput(descriptor);
  if (measured) {
    const quality = assessCaptureQuality(descriptor, captureMetricsFromMeasurement(measured));
    const measuredSeconds = Math.max(0, measured.durationSeconds);
    const recorded =
      captureSeconds !== undefined && Number.isFinite(captureSeconds) ? captureSeconds : 0;
    return {
      ...quality,
      coverage: { measuredSeconds, captureSeconds: Math.max(measuredSeconds, recorded) },
    };
  }
  // Without measurements the descriptor alone can still rule a capture out.
  const issues = unmeasuredIssues(descriptor);
  return issues.length ? unknownQuality(issues) : { state: "unmeasured", issues: [] };
}

/** Validates a stored run quality, e.g. from a restored backup. */
export function isRunCaptureQuality(value: unknown): value is RunCaptureQuality {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.issues)) return false;
  if (record.coverage !== undefined && !isCaptureCoverage(record.coverage)) return false;
  if (record.state === "unmeasured") return record.issues.length === 0 && !record.coverage;
  if (record.state === "usable") return record.issues.length === 0;
  return (
    record.state === "unknown" &&
    record.issues.length > 0 &&
    record.issues.every((issue) => typeof issue === "string" && Object.hasOwn(ISSUE_TEXT, issue)) &&
    typeof record.explanation === "string"
  );
}

function isCaptureCoverage(value: unknown): value is CaptureCoverage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { measuredSeconds, captureSeconds } = value as Record<string, unknown>;
  return (
    typeof measuredSeconds === "number" &&
    typeof captureSeconds === "number" &&
    Number.isFinite(measuredSeconds) &&
    Number.isFinite(captureSeconds) &&
    measuredSeconds >= 0 &&
    captureSeconds >= measuredSeconds
  );
}

/** True when the quality verdict covers less than the whole recorded capture. */
export function isPartialCoverage(quality: RunCaptureQuality | undefined) {
  const coverage = quality?.coverage;
  return (
    !!coverage && coverage.captureSeconds - coverage.measuredSeconds > COVERAGE_TOLERANCE_SECONDS
  );
}

/**
 * Reader-facing statement of the window a quality verdict is based on, or null when it covers
 * the whole capture (or nothing was measured).
 */
export function captureCoverageNote(quality: RunCaptureQuality | undefined): string | null {
  if (!isPartialCoverage(quality) || !quality?.coverage) return null;
  const { measuredSeconds, captureSeconds } = quality.coverage;
  return `Capture quality was checked for the last ${formatSeconds(measuredSeconds)} of ${formatSeconds(captureSeconds)} of recorded audio; earlier audio was not checked.`;
}

function formatSeconds(seconds: number) {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

export const CAPTURE_QUALITY_LIMITS = {
  minimumDurationSeconds: 3,
  minimumActiveSeconds: 2,
  maximumClippedSampleRatio: 0.001,
  maximumDiscontinuityRatio: 0.05,
} as const;

const ISSUE_TEXT: Record<CaptureQualityIssue, string> = {
  noChannels: "the recording has no audio channels",
  tooShort: "the recording is too short",
  noInput: "the microphone delivered no input",
  insufficientSpeech: "there is too little speech",
  clipping: "the input is clipping (too loud)",
  discontinuous: "parts of the recording are missing",
  speakerUnknown: "it is not confirmed that only you are speaking",
  speakerOverlap: "other voices overlap with yours",
};

/**
 * Quality gate before scoring. Anything other than "usable" must be reported as an unknown
 * result with the explanation, never as fluent speech or a high event rate.
 */
export function assessCaptureQuality(
  descriptor: RecordingDescriptor,
  metrics: CaptureMetrics,
): CaptureQuality {
  requireSpeakerInput(descriptor);
  const limits = CAPTURE_QUALITY_LIMITS;
  const issues: CaptureQualityIssue[] = [];
  if (metrics.channelCount < 1) issues.push("noChannels");
  if (metrics.durationSeconds < limits.minimumDurationSeconds) issues.push("tooShort");
  if (metrics.durationSeconds > 0 && metrics.silentSeconds >= metrics.durationSeconds * 0.98) {
    issues.push("noInput");
  } else if (metrics.activeSeconds < limits.minimumActiveSeconds) {
    issues.push("insufficientSpeech");
  }
  if (metrics.clippedSampleRatio > limits.maximumClippedSampleRatio) issues.push("clipping");
  const missingSeconds = mergedDiscontinuities(descriptor).reduce(
    (sum, gap) => sum + Math.max(0, gap.endSeconds - gap.startSeconds),
    0,
  );
  if (
    metrics.durationSeconds > 0 &&
    missingSeconds / metrics.durationSeconds > limits.maximumDiscontinuityRatio
  ) {
    issues.push("discontinuous");
  }
  for (const issue of descriptorIssues(descriptor)) {
    if (!issues.includes(issue)) issues.push(issue);
  }

  if (!issues.length) return { state: "usable", issues: [] };
  return unknownQuality(issues);
}

/** Issues the recording descriptor establishes without any PCM measurement. */
function descriptorIssues(descriptor: RecordingDescriptor): CaptureQualityIssue[] {
  const issues: CaptureQualityIssue[] = [];
  if (descriptor.channelCount < 1) issues.push("noChannels");
  if (descriptor.speakerAssessment === "unknown") issues.push("speakerUnknown");
  if (descriptor.speakerAssessment === "overlapDetected") issues.push("speakerOverlap");
  return issues;
}

/** Without measurements nothing bounds a gap's share, so any gap rules the capture out. */
function unmeasuredIssues(descriptor: RecordingDescriptor): CaptureQualityIssue[] {
  const issues = descriptorIssues(descriptor);
  if (mergedDiscontinuities(descriptor).length) issues.push("discontinuous");
  return issues;
}

function unknownQuality(issues: CaptureQualityIssue[]): CaptureQuality {
  return {
    state: "unknown",
    issues,
    explanation: `Result unknown: ${issues.map((issue) => ISSUE_TEXT[issue]).join("; ")}.`,
  };
}
