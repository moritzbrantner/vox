import { describe, expect, test } from "bun:test";

import type { RecordingDescriptor } from "./capture";
import {
  type VoiceActivityEvidence,
  type VoiceActivityProvider,
  compareLiveWithFinite,
  isVoiceActivityEvidence,
  latestVoiceActivity,
  voiceActivityEvidence,
} from "./voiceActivity";

const provider: VoiceActivityProvider = {
  id: "silero-vad",
  model: "silero_vad.onnx",
  modelSha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
  threshold: 0.5,
  minSpeechMs: 250,
  minSilenceMs: 100,
  speechPadMs: 30,
  maxSpeechSeconds: 30,
  sampleRate: 16_000,
  resampling: "linear",
};

function descriptor(discontinuities: RecordingDescriptor["discontinuities"] = []) {
  return {
    sessionId: "s",
    runId: "run-1",
    origin: "desktop",
    role: "appInput",
    sampleRate: 48_000,
    channelCount: 1,
    startOffsetSeconds: 0,
    discontinuities,
    speakerAssessment: "singleSpeakerDeclared",
  } as unknown as RecordingDescriptor;
}

const spans = [
  { startSeconds: 0.802, endSeconds: 2.334, score: 0.99 },
  { startSeconds: 4.674, endSeconds: 5.598, score: 0.97 },
];

describe("voice activity evidence", () => {
  test("puts detector spans on the session clock and marks capture gaps unknown", () => {
    // 1 s of audio was lost at 3 s of session time: stream time after it is shifted by 1 s.
    const evidence = voiceActivityEvidence({
      descriptor: descriptor([{ startSeconds: 3, endSeconds: 4, reason: "gap" } as never]),
      analyzedAt: "2026-10-31T12:00:00.000Z",
      status: "detected",
      provider,
      spans,
      streamOffsetSeconds: 0,
      analyzedSeconds: 6,
      captureSeconds: 6,
      processingMs: 12,
      live: null,
    });
    expect(evidence.speech).toEqual([
      { startSeconds: 0.802, endSeconds: 2.334, maxSpeechProbability: 0.99 },
      { startSeconds: 5.674, endSeconds: 6.598, maxSpeechProbability: 0.97 },
    ]);
    expect(evidence.unknown).toEqual([{ startSeconds: 3, endSeconds: 4, reason: "captureGap" }]);
    expect(evidence.coverage).toEqual({ startSeconds: 0, endSeconds: 7 });
    expect(evidence.attribution).toBe("unattributed");
    expect(isVoiceActivityEvidence(evidence)).toBe(true);
  });

  test("an unanalyzed start of the capture is unknown, not silence", () => {
    const evidence = voiceActivityEvidence({
      descriptor: descriptor(),
      analyzedAt: "2026-10-31T12:00:00.000Z",
      status: "detected",
      provider,
      spans,
      streamOffsetSeconds: 10,
      analyzedSeconds: 90,
      captureSeconds: 100,
      processingMs: 12,
      live: null,
    });
    expect(evidence.unknown).toEqual([{ startSeconds: 0, endSeconds: 10, reason: "notAnalyzed" }]);
    expect(evidence.speech[0].startSeconds).toBeCloseTo(10.802, 9);
  });

  test("an unavailable detector stores no speech and validates only without spans", () => {
    const evidence = voiceActivityEvidence({
      descriptor: descriptor(),
      analyzedAt: "2026-10-31T12:00:00.000Z",
      status: "unavailable",
      provider: null,
      reason: "no model",
      spans,
      streamOffsetSeconds: 5,
      analyzedSeconds: 0,
      captureSeconds: 5,
      processingMs: 0,
      live: null,
    });
    expect(evidence.speech).toEqual([]);
    expect(evidence.unknown).toEqual([{ startSeconds: 0, endSeconds: 5, reason: "notAnalyzed" }]);
    expect(isVoiceActivityEvidence(evidence)).toBe(true);
    expect(
      isVoiceActivityEvidence({
        ...evidence,
        speech: [{ startSeconds: 0, endSeconds: 1, maxSpeechProbability: 1 }],
      }),
    ).toBe(false);
  });

  test("rejects mismatched schemas and malformed intervals whole", () => {
    const evidence = voiceActivityEvidence({
      descriptor: descriptor(),
      analyzedAt: "2026-10-31T12:00:00.000Z",
      status: "detected",
      provider,
      spans,
      streamOffsetSeconds: 0,
      analyzedSeconds: 6,
      captureSeconds: 6,
      processingMs: 1,
      live: {
        status: "detected",
        revisions: 70,
        finalizedSpans: 2,
        maxUpdateMs: 0.6,
        parity: compareLiveWithFinite(spans, spans),
      },
    });
    expect(isVoiceActivityEvidence(evidence)).toBe(true);
    expect(isVoiceActivityEvidence({ ...evidence, schemaVersion: 2 })).toBe(false);
    expect(isVoiceActivityEvidence({ ...evidence, provider: null })).toBe(false);
    expect(isVoiceActivityEvidence({ ...evidence, attribution: "user" })).toBe(false);
    expect(
      isVoiceActivityEvidence({
        ...evidence,
        speech: [{ startSeconds: 2, endSeconds: 1, maxSpeechProbability: 1 }],
      }),
    ).toBe(false);
    expect(isVoiceActivityEvidence({ ...evidence, live: { status: "detected" } })).toBe(false);
  });
});

describe("live and finite parity", () => {
  test("same spans match exactly; any difference is a mismatch with its size", () => {
    expect(compareLiveWithFinite(spans, spans)).toEqual({ state: "match", spans: 2 });
    const moved = [spans[0], { ...spans[1], endSeconds: 5.63 }];
    const parity = compareLiveWithFinite(moved, spans);
    expect(parity.state).toBe("mismatch");
    if (parity.state === "mismatch") {
      expect(parity.maxBoundaryDeltaSeconds).toBeCloseTo(0.032, 9);
    }
    expect(compareLiveWithFinite(spans.slice(0, 1), spans)).toMatchObject({
      state: "mismatch",
      liveSpans: 1,
      finiteSpans: 2,
    });
  });
});

describe("latest voice activity", () => {
  const evidence = { captureRunId: "run-1" } as VoiceActivityEvidence;
  const run = (id: string, voiceActivity?: VoiceActivityEvidence) => ({
    id,
    report: voiceActivity ? { voiceActivity } : {},
  });

  test("a newer run without acoustic VAD keeps the earlier run's evidence", () => {
    const record = {
      analysis: { id: "transcript-only" },
      report: {},
      priorAnalyses: [
        run("first", { ...evidence, analyzedAt: "a" }),
        run("second", evidence),
        run("third"),
      ],
    } as never;
    expect(latestVoiceActivity(record)).toEqual({ runId: "second", evidence });
  });

  test("the current run wins when it has evidence, and legacy records have none", () => {
    expect(
      latestVoiceActivity({
        analysis: { id: "current" },
        report: { voiceActivity: evidence },
        priorAnalyses: [run("old", { ...evidence, analyzedAt: "a" })],
      } as never),
    ).toEqual({ runId: "current", evidence });
    expect(
      latestVoiceActivity({ analysis: { id: "legacy" }, report: {}, priorAnalyses: [] } as never),
    ).toBeNull();
  });
});
