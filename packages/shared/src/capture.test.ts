import { describe, expect, test } from "bun:test";

import {
  assessCaptureQuality,
  assessRunCaptureQuality,
  captureCoverageNote,
  captureMetricsFromMeasurement,
  isPartialCoverage,
  isRunCaptureQuality,
  type MeasuredCaptureMetrics,
  isUnprocessedInput,
  type CaptureMetrics,
  type RecordingDescriptor,
  resampledDescriptor,
  sampleIndexToSessionSeconds,
  sessionSecondsToSampleIndex,
  streamSecondsToSessionSeconds,
} from "./capture";
import { resampleSamples } from "./index";

function descriptor(overrides: Partial<RecordingDescriptor> = {}): RecordingDescriptor {
  return {
    sessionId: "session-1",
    runId: "run-1",
    origin: "browser",
    role: "appInput",
    sampleRate: 48_000,
    channelCount: 1,
    startOffsetSeconds: 0.25,
    preprocessing: {
      echoCancellation: { requested: true },
      noiseSuppression: { requested: true },
      autoGainControl: { requested: false },
    },
    discontinuities: [],
    speakerAssessment: "singleSpeakerDeclared",
    ...overrides,
  };
}

/** Metrics of six seconds of clean single-speaker speech. */
function metrics(overrides: Partial<CaptureMetrics> = {}): CaptureMetrics {
  return {
    durationSeconds: 6,
    channelCount: 1,
    clippedSampleRatio: 0,
    silentSeconds: 0.5,
    activeSeconds: 4.5,
    longestSilenceSeconds: 0.3,
    ...overrides,
  };
}

describe("common session time base", () => {
  test("an impulse keeps its session time through 48 kHz -> 16 kHz resampling", () => {
    const source = descriptor();
    const samples = Array.from({ length: 48_000 * 2 }, () => 0);
    const impulseIndex = 48_000 + 12_345;
    samples[impulseIndex] = 1;
    const impulseSeconds = sampleIndexToSessionSeconds(source, impulseIndex);

    const resampled = resampleSamples(samples, 48_000, 16_000);
    const target = resampledDescriptor(source, 16_000);
    const peakIndex = resampled.reduce(
      (best, value, index) => (value > resampled[best] ? index : best),
      0,
    );

    // Tolerance: one output sample period.
    expect(
      Math.abs(sampleIndexToSessionSeconds(target, peakIndex) - impulseSeconds),
    ).toBeLessThanOrEqual(1 / 16_000);
    expect(resampled.length / 16_000).toBeCloseTo(samples.length / 48_000, 6);
  });

  test("samples after a dropout map past the gap, consistently in both directions", () => {
    const source = descriptor({
      discontinuities: [{ startSeconds: 1.25, endSeconds: 1.5, reason: "dropout" }],
    });

    // Sample 48_000 is the first sample captured after the gap at 1.25 s.
    expect(sampleIndexToSessionSeconds(source, 47_999)).toBeLessThan(1.25);
    expect(sampleIndexToSessionSeconds(source, 48_000)).toBeCloseTo(1.5, 9);
    expect(streamSecondsToSessionSeconds(source, 1.5)).toBeCloseTo(2, 9);
    expect(sessionSecondsToSampleIndex(source, 1.0, 96_000)).toBe(36_000);
    expect(sessionSecondsToSampleIndex(source, 1.3, 96_000)).toBeNull();
    expect(sessionSecondsToSampleIndex(source, 2, 96_000)).toBe(72_000);
    expect(sessionSecondsToSampleIndex(source, 0.1, 96_000)).toBeNull();
    expect(sessionSecondsToSampleIndex(source, 99, 96_000)).toBeNull();
  });

  test("overlapping gaps are counted once", () => {
    const source = descriptor({
      startOffsetSeconds: 0,
      discontinuities: [
        { startSeconds: 1, endSeconds: 3, reason: "paused" },
        { startSeconds: 2, endSeconds: 4, reason: "routeChange" },
      ],
    });

    expect(sampleIndexToSessionSeconds(source, 48_000)).toBeCloseTo(4, 9);
    expect(sessionSecondsToSampleIndex(source, 4, 96_000)).toBe(48_000);
  });
});

describe("provenance", () => {
  test("browser input with requested echo cancellation is not labelled unprocessed", () => {
    expect(isUnprocessedInput(descriptor())).toBe(false);
    const unobserved = { requested: false };
    expect(
      isUnprocessedInput(
        descriptor({
          preprocessing: {
            echoCancellation: unobserved,
            noiseSuppression: unobserved,
            autoGainControl: unobserved,
          },
        }),
      ),
    ).toBe(false);
  });

  test("input with all preprocessing reported off is unprocessed; intervention output never is", () => {
    const off = { requested: false, applied: false };
    const preprocessing = { echoCancellation: off, noiseSuppression: off, autoGainControl: off };
    expect(isUnprocessedInput(descriptor({ preprocessing }))).toBe(true);
    expect(isUnprocessedInput(descriptor({ preprocessing, role: "interventionOutput" }))).toBe(
      false,
    );
  });
});

describe("assessCaptureQuality", () => {
  const ok = descriptor({ sampleRate: 16_000 });

  test("refuses intervention output offered for assessment as the speaker's input", () => {
    const playback = descriptor({ role: "interventionOutput" });
    expect(() => assessCaptureQuality(playback, metrics())).toThrow(/not the speaker's input/);
    expect(() => assessRunCaptureQuality(playback, undefined)).toThrow(/not the speaker's input/);
  });

  test("clean single-speaker speech is usable", () => {
    expect(assessCaptureQuality(ok, metrics())).toEqual({ state: "usable", issues: [] });
  });

  const fixtures: Array<[string, RecordingDescriptor, CaptureMetrics, string]> = [
    [
      "silence",
      ok,
      metrics({ silentSeconds: 6, activeSeconds: 0, longestSilenceSeconds: 6 }),
      "noInput",
    ],
    ["clipping", ok, metrics({ clippedSampleRatio: 0.02 }), "clipping"],
    ["truncated recording", ok, metrics({ durationSeconds: 1, activeSeconds: 0.8 }), "tooShort"],
    [
      "missing channels",
      descriptor({ channelCount: 0 }),
      metrics({ channelCount: 0 }),
      "noChannels",
    ],
    [
      "background speech",
      descriptor({ speakerAssessment: "overlapDetected" }),
      metrics(),
      "speakerOverlap",
    ],
    ["unknown speaker", descriptor({ speakerAssessment: "unknown" }), metrics(), "speakerUnknown"],
    [
      "large dropout",
      descriptor({ discontinuities: [{ startSeconds: 1, endSeconds: 2, reason: "dropout" }] }),
      metrics(),
      "discontinuous",
    ],
    [
      "near-silent hum",
      ok,
      metrics({ silentSeconds: 0, activeSeconds: 0.4 }),
      "insufficientSpeech",
    ],
  ];

  for (const [name, desc, measured, issue] of fixtures) {
    test(`${name} is an unknown result with an explanation, not a score`, () => {
      const quality = assessCaptureQuality(desc, measured);
      expect(quality.state).toBe("unknown");
      expect(quality.issues).toContain(issue as never);
      expect(quality.state === "unknown" && quality.explanation).toMatch(/^Result unknown: /);
    });
  }
});

/** Shape returned by audio-analysis `capture_metrics` for six seconds at 16 kHz. */
function measured(overrides: Partial<MeasuredCaptureMetrics> = {}): MeasuredCaptureMetrics {
  return {
    sampleRate: 16_000,
    channels: 1,
    samplesPerChannel: 96_000,
    durationSeconds: 6,
    clippedSampleCount: 0,
    clippedSampleRatio: 0,
    frameSamples: 320,
    frameCount: 300,
    noInputSeconds: 0.5,
    longestNoInputSeconds: 0.3,
    activitySeconds: 4.5,
    config: { frameSeconds: 0.02, clipLevel: 0.999, noInputRms: 1e-4, activityRms: 0.01 },
    ...overrides,
  };
}

describe("audio-analysis capture metrics", () => {
  test("map onto the quality gate's input", () => {
    expect(captureMetricsFromMeasurement(measured())).toEqual(metrics());
  });

  test("a run without measurements is unmeasured, not usable", () => {
    expect(assessRunCaptureQuality(descriptor(), undefined)).toEqual({
      state: "unmeasured",
      issues: [],
    });
    expect(assessRunCaptureQuality(descriptor(), measured()).state).toBe("usable");
    // The descriptor alone still withholds a score from unconfirmed or mixed speakers.
    expect(
      assessRunCaptureQuality(descriptor({ speakerAssessment: "unknown" }), undefined),
    ).toMatchObject({ state: "unknown", issues: ["speakerUnknown"] });
    expect(
      assessRunCaptureQuality(descriptor({ speakerAssessment: "overlapDetected" }), undefined),
    ).toMatchObject({ state: "unknown", issues: ["speakerOverlap"] });
    const gap = { startSeconds: 0, endSeconds: 4, reason: "dropout" as const };
    expect(
      assessRunCaptureQuality(descriptor({ discontinuities: [gap] }), undefined),
    ).toMatchObject({
      state: "unknown",
      issues: ["discontinuous"],
    });
    const silent = measured({ noInputSeconds: 6, activitySeconds: 0 });
    expect(assessRunCaptureQuality(descriptor(), silent)).toMatchObject({
      state: "unknown",
      issues: ["noInput"],
    });
  });

  test("a verdict on a shorter analyzed window states the part it covers", () => {
    const long = assessRunCaptureQuality(descriptor(), measured(), 720);
    expect(long).toMatchObject({
      state: "usable",
      coverage: { measuredSeconds: 6, captureSeconds: 720 },
    });
    expect(isPartialCoverage(long)).toBe(true);
    expect(captureCoverageNote(long)).toBe(
      "Capture quality was checked for the last 6 s of 12 min of recorded audio; earlier audio was not checked.",
    );
    // Rounding between sample rates is not an unchecked part.
    const whole = assessRunCaptureQuality(descriptor(), measured(), 6.2);
    expect(isPartialCoverage(whole)).toBe(false);
    expect(captureCoverageNote(whole)).toBeNull();
    // The covered window never exceeds the capture, and unknown recorded length means whole.
    expect(assessRunCaptureQuality(descriptor(), measured()).coverage).toEqual({
      measuredSeconds: 6,
      captureSeconds: 6,
    });
    expect(assessRunCaptureQuality(descriptor(), undefined, 720)).toEqual({
      state: "unmeasured",
      issues: [],
    });
    expect(isRunCaptureQuality(long)).toBe(true);
  });

  test("stored run qualities are validated", () => {
    expect(isRunCaptureQuality({ state: "usable", issues: [] })).toBe(true);
    expect(isRunCaptureQuality({ state: "unmeasured", issues: [] })).toBe(true);
    expect(
      isRunCaptureQuality({ state: "unknown", issues: ["clipping"], explanation: "too loud" }),
    ).toBe(true);
    for (const invalid of [
      null,
      [],
      { state: "usable", issues: ["clipping"] },
      { state: "unknown", issues: [], explanation: "x" },
      { state: "unknown", issues: ["toString"], explanation: "x" },
      { state: "unknown", issues: ["clipping"] },
      { state: "great", issues: [] },
      { state: "usable", issues: [], coverage: { measuredSeconds: 90 } },
      { state: "usable", issues: [], coverage: { measuredSeconds: 90, captureSeconds: 30 } },
      { state: "unmeasured", issues: [], coverage: { measuredSeconds: 1, captureSeconds: 1 } },
    ]) {
      expect(isRunCaptureQuality(invalid)).toBe(false);
    }
  });
});
