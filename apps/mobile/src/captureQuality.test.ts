// Acceptance tests for #94 (capture-quality gate on the mobile capture path).
//
// Seam contract (new module `./captureQuality`):
// - `mobileRecordingDescriptor(input)` builds the shared `RecordingDescriptor` of one mobile
//   recording from what the platform reports. `input` is
//   `{ sessionId, runId, sampleRate, channelCount, soloSpeaker, preprocessing? }`; preprocessing
//   settings stay unknown (`applied` undefined) unless the platform reports them.
// - `withMobileCaptureQuality(report, transcription, descriptor, captureSeconds?)` attaches the
//   `captureMetrics` the server returned with the `/transcriptions/file` result to the analysis
//   report and gates it with the shared `assessRunCaptureQuality`.
// - `mobileMetricRows(report)` returns the rows the Metrics panel renders
//   (`{ label, value }` for Events, Rate, Words, Severity); Events/Rate/Severity read "Unknown"
//   when the gate withholds the score, as on the web.
// - `captureQualityMessage(report)` returns the capture-quality text shown with the metrics: the
//   unknown result's explanation, the "not checked" note for an unmeasured run, or null.
import { createComputeClient, processingPolicyForServerUrl } from "@stutter-tracker/compute-client";
import {
  type AnalysisReport,
  isUnprocessedInput,
  type MeasuredCaptureMetrics,
  type RecordingDescriptor,
  type TranscribeAudioResult,
} from "@stutter-tracker/shared";
import { describe, expect, it } from "vitest";
import {
  captureQualityMessage,
  mobileMetricRows,
  mobileRecordingDescriptor,
  withMobileCaptureQuality,
} from "./captureQuality";
import { recordingFileInfo, transcriptionToAnalysisRequest } from "./recording";

const SOURCE_RATE = 44_100;

function measured(overrides: Partial<MeasuredCaptureMetrics> = {}): MeasuredCaptureMetrics {
  const durationSeconds = overrides.durationSeconds ?? 6;
  return {
    sampleRate: SOURCE_RATE,
    channels: 1,
    samplesPerChannel: Math.round(durationSeconds * SOURCE_RATE),
    durationSeconds,
    clippedSampleCount: 0,
    clippedSampleRatio: 0,
    frameSamples: 882,
    frameCount: Math.round(durationSeconds / 0.02),
    noInputSeconds: 0.4,
    longestNoInputSeconds: 0.2,
    activitySeconds: 5,
    config: { frameSeconds: 0.02, clipLevel: 0.999, noInputRms: 1e-4, activityRms: 0.01 },
    ...overrides,
  };
}

/** Decoded upload with no microphone input at all. */
const silent = measured({ noInputSeconds: 6, longestNoInputSeconds: 6, activitySeconds: 0 });
/** Decoded upload that hits full scale far beyond the clipping limit. */
const clipping = measured({
  clippedSampleCount: 26_460,
  clippedSampleRatio: 0.1,
  noInputSeconds: 0,
  longestNoInputSeconds: 0,
  activitySeconds: 6,
});
/** Decoded upload of clean speech. */
const clean = measured();

function report(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    totalDurationSeconds: 6,
    wordCount: 12,
    stutterCount: 3,
    stuttersPerMinute: 30,
    severity: "moderate",
    speechStats: {
      speakingDurationSeconds: 5,
      pauseDurationSeconds: 1,
      wordsPerMinute: 120,
      articulationRateWpm: 144,
      meanChunkWords: 6,
      meanChunkDurationSeconds: 2.5,
      eventDensityPer100Words: 25,
      fluencyPercentage: 75,
    },
    blockerStats: {
      blockCount: 1,
      totalBlockSeconds: 0.5,
      averageBlockSeconds: 0.5,
      longestBlockSeconds: 0.5,
      blocksPerMinute: 10,
      blockedTimePercentage: 8,
    },
    chunks: [],
    events: [],
    byKind: { wordRepetition: 3 },
    ...overrides,
  };
}

// The shared transcription result carries the worker's measurement of the decoded upload.
type TranscriptionCaptureMetrics = TranscribeAudioResult["captureMetrics"];

function transcription(captureMetrics?: TranscriptionCaptureMetrics): TranscribeAudioResult {
  return {
    text: "hello hello hello world",
    language: "en",
    provider: "whisperCpp",
    model: "base.en",
    segments: [{ text: "hello hello hello world", startSeconds: 0, endSeconds: 2, isFinal: true }],
    ...(captureMetrics ? { captureMetrics } : {}),
  };
}

function descriptor(soloSpeaker = true): RecordingDescriptor {
  return mobileRecordingDescriptor({
    sessionId: "capture-1",
    runId: "run-1",
    sampleRate: SOURCE_RATE,
    channelCount: 1,
    soloSpeaker,
  });
}

function row(rows: Array<{ label: string; value: string }>, label: string) {
  const found = rows.find((item) => item.label === label);
  expect(found, `metric row ${label}`).toBeDefined();
  return found!.value;
}

describe("mobile recording descriptor", () => {
  it("describes a mobile app-input stream with the reported format and the solo declaration", () => {
    const solo = descriptor(true);
    expect(solo).toMatchObject({
      sessionId: "capture-1",
      runId: "run-1",
      origin: "mobile",
      role: "appInput",
      sampleRate: SOURCE_RATE,
      channelCount: 1,
      startOffsetSeconds: 0,
      discontinuities: [],
      speakerAssessment: "singleSpeakerDeclared",
    });
    expect(descriptor(false).speakerAssessment).toBe("unknown");
  });

  it("keeps preprocessing unknown unless the platform reports it", () => {
    const unreported = descriptor();
    for (const setting of Object.values(unreported.preprocessing)) {
      expect(setting.applied).toBeUndefined();
    }
    expect(isUnprocessedInput(unreported)).toBe(false);

    const reported = mobileRecordingDescriptor({
      sessionId: "capture-2",
      runId: "run-2",
      sampleRate: 48_000,
      channelCount: 2,
      soloSpeaker: true,
      preprocessing: { echoCancellation: { applied: true } },
    });
    expect(reported.sampleRate).toBe(48_000);
    expect(reported.channelCount).toBe(2);
    expect(reported.preprocessing.echoCancellation.applied).toBe(true);
    expect(reported.preprocessing.noiseSuppression.applied).toBeUndefined();
    expect(reported.preprocessing.autoGainControl.applied).toBeUndefined();
  });
});

describe("mobile capture-quality gate", () => {
  it.each([
    ["silent", silent, "the microphone delivered no input"],
    ["clipping", clipping, "the input is clipping (too loud)"],
  ])(
    "reports a %s recording as unknown with an explanation and withholds the score",
    (_name, metrics, reason) => {
      const gated = withMobileCaptureQuality(report(), transcription(metrics), descriptor(), 6);

      expect(gated.captureMetrics).toEqual(metrics);
      expect(gated.captureQuality?.state).toBe("unknown");
      const message = captureQualityMessage(gated);
      expect(message).toContain("Result unknown");
      expect(message).toContain(reason);

      const rows = mobileMetricRows(gated);
      expect(row(rows, "Events")).toBe("Unknown");
      expect(row(rows, "Rate")).toBe("Unknown");
      expect(row(rows, "Severity")).toBe("Unknown");
      // Word count is not a fluency score and stays visible, like pace on the web.
      expect(row(rows, "Words")).toBe("12");
    },
  );

  it("scores a clean recording from a solo speaker", () => {
    const gated = withMobileCaptureQuality(report(), transcription(clean), descriptor(), 6);

    expect(gated.captureQuality?.state).toBe("usable");
    expect(captureQualityMessage(gated)).toBeNull();
    const rows = mobileMetricRows(gated);
    expect(row(rows, "Events")).toBe("3");
    expect(row(rows, "Rate")).toBe("30.0/min");
    expect(row(rows, "Severity")).not.toBe("Unknown");
  });

  it("keeps a clean recording unknown without the solo-speaker declaration", () => {
    const gated = withMobileCaptureQuality(report(), transcription(clean), descriptor(false), 6);

    expect(gated.captureQuality).toMatchObject({ state: "unknown", issues: ["speakerUnknown"] });
    expect(captureQualityMessage(gated)).toContain("not confirmed that only you are speaking");
    expect(row(mobileMetricRows(gated), "Events")).toBe("Unknown");
  });

  it("says the capture was not checked when the server returned no measurement", () => {
    const gated = withMobileCaptureQuality(report(), transcription(undefined), descriptor(), 6);

    expect(gated).not.toHaveProperty("captureMetrics");
    expect(gated.captureQuality?.state).toBe("unmeasured");
    expect(captureQualityMessage(gated)).toContain("not checked");
    expect(row(mobileMetricRows(gated), "Events")).toBe("3");
  });

  it("records how much of the recording the measurement covered", () => {
    const gated = withMobileCaptureQuality(report(), transcription(silent), descriptor(), 8);

    expect(gated.captureQuality?.coverage).toEqual({ measuredSeconds: 6, captureSeconds: 8 });
  });
});

describe("mobile capture path end to end", () => {
  it("turns a silent upload into an unknown result with an explanation", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path === "/transcriptions/file") {
        return Response.json(transcription(silent));
      }
      if (path === "/analysis") {
        // The shared analyzer scores the transcript; the server has no audio to measure here.
        return Response.json(report());
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = createComputeClient({
      processingPolicy: processingPolicyForServerUrl("http://127.0.0.1:8787", false),
      fetchImpl,
    });

    const uri = "file:///cache/recording-1.m4a";
    const { filename, mimeType } = recordingFileInfo(uri);
    const result = await client.transcribeAudioFile({
      file: new Blob([new Uint8Array(16)], { type: mimeType }),
      filename,
      mimeType,
      provider: "whisperCpp",
      model: "base.en",
      language: "en-US",
    });
    const analyzed = await client.analyzeSpeechSession(transcriptionToAnalysisRequest(result));
    const gated = withMobileCaptureQuality(analyzed, result, descriptor(), 6);

    expect(requests).toEqual(["/transcriptions/file", "/analysis"]);
    expect(gated.captureQuality?.state).toBe("unknown");
    expect(captureQualityMessage(gated)).toContain("the microphone delivered no input");
    expect(row(mobileMetricRows(gated), "Severity")).toBe("Unknown");
  });
});

describe("mobile recordings of other people", () => {
  it("stores each participant's confirmation with the recording only when given", () => {
    const confirmation = [
      {
        label: "Robin",
        confirmedAt: "2026-10-31T10:00:00.000Z",
        statement: "Robin has agreed to be recorded.",
      },
      {
        label: "Sam",
        confirmedAt: "2026-10-31T10:01:00.000Z",
        statement: "Sam has agreed to be recorded.",
      },
    ];
    const input = { sessionId: "c", runId: "r", sampleRate: SOURCE_RATE, channelCount: 1 };
    expect(
      mobileRecordingDescriptor({ ...input, soloSpeaker: false, otherParticipants: confirmation })
        .otherParticipants,
    ).toEqual(confirmation);
    expect(mobileRecordingDescriptor({ ...input, soloSpeaker: true })).not.toHaveProperty(
      "otherParticipants",
    );
  });
});
