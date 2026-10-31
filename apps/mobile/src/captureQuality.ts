import {
  type AnalysisReport,
  assessRunCaptureQuality,
  captureCoverageNote,
  type OtherParticipantsConfirmation,
  type PreprocessingSetting,
  type RecordingDescriptor,
  type TranscribeAudioResult,
} from "@stutter-tracker/shared";

type Preprocessing = RecordingDescriptor["preprocessing"];

export type MobileRecordingInput = {
  sessionId: string;
  runId: string;
  /** Actual format of the recorded audio, not the requested preset. */
  sampleRate: number;
  channelCount: number;
  /** The user's "Only I speak" declaration for this recording. */
  soloSpeaker: boolean;
  /** This session's confirmation that everyone else recorded agreed; null when no one else was. */
  otherParticipants?: OtherParticipantsConfirmation | null;
  /** Only what the platform reports as applied; anything left out stays unknown. */
  preprocessing?: Partial<Record<keyof Preprocessing, PreprocessingSetting>>;
};

/** Recording descriptor of one mobile recording; unknown platform facts stay unknown. */
export function mobileRecordingDescriptor(input: MobileRecordingInput): RecordingDescriptor {
  const reported = input.preprocessing ?? {};
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    origin: "mobile",
    role: "appInput",
    sampleRate: input.sampleRate,
    channelCount: input.channelCount,
    startOffsetSeconds: 0,
    preprocessing: {
      echoCancellation: { ...reported.echoCancellation },
      noiseSuppression: { ...reported.noiseSuppression },
      autoGainControl: { ...reported.autoGainControl },
    },
    discontinuities: [],
    speakerAssessment: input.soloSpeaker ? "singleSpeakerDeclared" : "unknown",
    ...(input.otherParticipants ? { otherParticipants: input.otherParticipants } : {}),
  };
}

/**
 * Attaches the server's measurement of the uploaded recording (returned with the
 * `/transcriptions/file` result) to the transcript's analysis report and applies the shared
 * capture-quality gate. `captureSeconds` is the recorded duration of the whole capture.
 */
export function withMobileCaptureQuality(
  report: AnalysisReport,
  transcription: TranscribeAudioResult,
  descriptor: RecordingDescriptor,
  captureSeconds?: number,
): AnalysisReport {
  // The transcript-only analysis measured no audio; only the upload's measurement applies.
  const { captureMetrics: _unused, ...transcriptReport } = report;
  const measured = transcription.captureMetrics;
  return {
    ...transcriptReport,
    ...(measured ? { captureMetrics: measured } : {}),
    captureQuality: assessRunCaptureQuality(descriptor, measured, captureSeconds),
  };
}

/** True when the report's numbers must be shown as unknown instead of as a score. */
export function isScoreWithheld(report: AnalysisReport) {
  return report.captureQuality?.state === "unknown";
}

/** The Metrics panel rows; fluency scores read "Unknown" when the gate withholds them. */
export function mobileMetricRows(report: AnalysisReport): Array<{ label: string; value: string }> {
  const withheld = isScoreWithheld(report);
  const score = (value: string) => (withheld ? "Unknown" : value);
  return [
    { label: "Events", value: score(String(report.stutterCount)) },
    { label: "Rate", value: score(`${report.stuttersPerMinute.toFixed(1)}/min`) },
    { label: "Words", value: String(report.wordCount) },
    { label: "Severity", value: score(titleCase(report.severity)) },
  ];
}

/** The capture-quality text shown with the metrics, as on the web; null when there is none. */
export function captureQualityMessage(report: AnalysisReport): string | null {
  const quality = report.captureQuality;
  const coverageNote = captureCoverageNote(quality);
  if (quality?.state === "unknown") {
    return coverageNote ? `${quality.explanation} ${coverageNote}` : quality.explanation;
  }
  if (quality?.state === "unmeasured") {
    return "Capture quality was not checked on this processing path.";
  }
  return coverageNote;
}

function titleCase(value: string) {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
