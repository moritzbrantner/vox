import type { RecordingDescriptor, VoiceActivityEvidence } from "@stutter-tracker/shared";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  type LiveVoiceActivity,
  type VoiceActivityApi,
  VAD_UNAVAILABLE_OFF_DESKTOP,
  useVoiceActivity,
} from "./app/hooks/useVoiceActivity";
import { STALE_AFTER_MS, VoiceActivityTimeline } from "./components/VoiceActivityTimeline";
import { isAnalysisReport } from "./storage/sessionBackup";

const provider = {
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

const metrics = {
  sampleRate: 16_000,
  channels: 1,
  samplesPerChannel: 16_000,
  durationSeconds: 1,
  clippedSampleCount: 0,
  clippedSampleRatio: 0,
  frameSamples: 320,
  frameCount: 50,
  noInputSeconds: 0,
  longestNoInputSeconds: 0,
  activitySeconds: 1,
  config: { frameSeconds: 0.02, clipLevel: 0.999, noInputRms: 0.0001, activityRms: 0.01 },
};

const speech = { startSeconds: 0.2, endSeconds: 0.9, score: 0.98 };

function descriptor(runId: string): RecordingDescriptor {
  return {
    sessionId: "capture",
    runId,
    origin: "desktop",
    role: "appInput",
    sampleRate: 16_000,
    channelCount: 1,
    startOffsetSeconds: 0,
    discontinuities: [],
    speakerAssessment: "singleSpeakerDeclared",
  } as unknown as RecordingDescriptor;
}

/**
 * The desktop commands as the Rust side answers them: chunk 0 leaves a provisional span, chunk 1
 * finalizes it; the finite run returns `finite` (the same span unless a test says otherwise).
 */
function fakeDesktop(
  options: { finite?: (typeof speech)[]; delays?: Record<string, number> } = {},
) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let clock = 0;
  const api: VoiceActivityApi = {
    isDesktop: () => true,
    now: () => clock,
    async invoke<T>(command: string, args: Record<string, unknown>) {
      calls.push({ command, args });
      const request = args.request as { runId: string; seq?: number };
      const delay = options.delays?.[`${command}:${request.runId}`];
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const update = (
        seq: number,
        finalized: unknown[],
        provisional: unknown[],
        finished = false,
      ) => ({
        runId: request.runId,
        seq,
        status: "detected",
        revision: seq + 1,
        receivedSeconds: (seq + 1) * 0.5,
        analyzedSeconds: (seq + 1) * 0.5,
        stableUntilSeconds: finalized.length ? 1 : 0.1,
        finalized,
        provisional,
        captureMetrics: metrics,
        finished,
        processingMs: 0.4,
      });
      switch (command) {
        case "voice_activity_start":
          return { runId: request.runId, status: "detected", provider } as T;
        case "voice_activity_push":
          return (
            request.seq === 0
              ? update(0, [], [{ startSeconds: 0.2, endSeconds: 0.5, score: 0.9 }])
              : update(request.seq ?? 1, [{ ...speech, index: 0 }], [])
          ) as T;
        case "voice_activity_finish":
          return update(2, [], [], true) as T;
        case "analyze_voice_activity":
          return {
            status: "detected",
            provider,
            analyzedSeconds: 1,
            segments: options.finite ?? [speech],
            captureMetrics: metrics,
            processingMs: 3,
          } as T;
      }
      throw new Error(`unexpected ${command}`);
    },
  };
  return { api, calls, tick: (ms: number) => (clock += ms) };
}

const samples = Array.from({ length: 16_000 }, () => 0.2);

describe("voice activity in the recording workflow (audio-analysis#151)", () => {
  it("shows provisional then final speech live, and saves finite evidence with exact parity", async () => {
    const desktop = fakeDesktop();
    const { result } = renderHook(() => useVoiceActivity(desktop.api));
    act(() => result.current.start("run-1", 16_000));
    act(() => result.current.push(new Float32Array(8_000)));
    await waitFor(() => expect(result.current.live?.provisional).toHaveLength(1));
    expect(result.current.live?.finalized).toHaveLength(0);
    act(() => result.current.push(new Float32Array(8_000)));
    await waitFor(() => expect(result.current.live?.finalized).toEqual([speech]));
    expect(result.current.live?.provisional).toEqual([]);

    let evidence: VoiceActivityEvidence | null = null;
    await act(async () => {
      result.current.seal();
      evidence = await result.current.finish({
        descriptor: descriptor("run-1"),
        samples,
        sampleRate: 16_000,
        capturedSampleCount: samples.length,
      });
    });
    expect(evidence).toMatchObject({
      captureRunId: "run-1",
      status: "detected",
      provider,
      speech: [{ startSeconds: 0.2, endSeconds: 0.9, maxSpeechProbability: 0.98 }],
      attribution: "unattributed",
      live: { status: "detected", finalizedSpans: 1, parity: { state: "match", spans: 1 } },
    });
    // The saved report with this evidence passes backup validation.
    expect(
      isAnalysisReport({
        totalDurationSeconds: 1,
        wordCount: 0,
        stutterCount: 0,
        stuttersPerMinute: 0,
        severity: "none",
        events: [],
        byKind: {},
        voiceActivity: evidence,
      }),
    ).toBe(true);
    // Pushes are sequenced and the finite run sees exactly the kept samples.
    const pushes = desktop.calls.filter((call) => call.command === "voice_activity_push");
    expect(pushes.map((call) => (call.args.request as { seq: number }).seq)).toEqual([0, 1]);
    const finite = desktop.calls.find((call) => call.command === "analyze_voice_activity");
    expect((finite!.args.request as { samples: number[] }).samples).toHaveLength(16_000);
  });

  it("records a live/finite difference as a mismatch instead of hiding it", async () => {
    const desktop = fakeDesktop({ finite: [{ ...speech, endSeconds: 0.932 }] });
    const { result } = renderHook(() => useVoiceActivity(desktop.api));
    act(() => result.current.start("run-1", 16_000));
    act(() => result.current.push(new Float32Array(8_000)));
    act(() => result.current.push(new Float32Array(8_000)));
    let evidence: VoiceActivityEvidence | null = null;
    await act(async () => {
      evidence = await result.current.finish({
        descriptor: descriptor("run-1"),
        samples,
        sampleRate: 16_000,
        capturedSampleCount: samples.length,
      });
    });
    expect(evidence!.live?.parity).toMatchObject({
      state: "mismatch",
      liveSpans: 1,
      finiteSpans: 1,
    });
  });

  it("a partial finite window is not comparable and its start stays unknown", async () => {
    const desktop = fakeDesktop();
    const { result } = renderHook(() => useVoiceActivity(desktop.api));
    act(() => result.current.start("run-1", 16_000));
    let evidence: VoiceActivityEvidence | null = null;
    await act(async () => {
      evidence = await result.current.finish({
        descriptor: descriptor("run-1"),
        samples,
        sampleRate: 16_000,
        capturedSampleCount: samples.length * 3,
      });
    });
    expect(evidence!.live?.parity.state).toBe("notComparable");
    expect(evidence!.unknown).toEqual([{ startSeconds: 0, endSeconds: 2, reason: "notAnalyzed" }]);
  });

  it("a stale run's late update never reaches the newer capture", async () => {
    const desktop = fakeDesktop({ delays: { "voice_activity_push:run-old": 20 } });
    const { result } = renderHook(() => useVoiceActivity(desktop.api));
    act(() => result.current.start("run-old", 16_000));
    act(() => result.current.push(new Float32Array(8_000)));
    act(() => result.current.start("run-new", 16_000));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(result.current.live?.runId).toBe("run-new");
    expect(result.current.live?.provisional).toEqual([]);
    expect(result.current.live?.finalized).toEqual([]);
  });

  it("is unavailable off the desktop and saves that, never silence", async () => {
    const { result } = renderHook(() =>
      useVoiceActivity({
        isDesktop: () => false,
        now: () => 0,
        invoke: async () => {
          throw new Error("no desktop");
        },
      }),
    );
    act(() => result.current.start("run-1", 48_000));
    expect(result.current.live).toMatchObject({
      status: "unavailable",
      reason: VAD_UNAVAILABLE_OFF_DESKTOP,
    });
    let evidence: VoiceActivityEvidence | null = null;
    await act(async () => {
      evidence = await result.current.finish({
        descriptor: descriptor("run-1"),
        samples: Array.from({ length: 48_000 }, () => 0.3),
        sampleRate: 48_000,
        capturedSampleCount: 48_000,
      });
    });
    expect(evidence).toMatchObject({ status: "unavailable", speech: [], provider: null });
    expect(evidence!.unknown).toEqual([{ startSeconds: 0, endSeconds: 1, reason: "notAnalyzed" }]);
  });
});

describe("speech detection timeline", () => {
  const live = (overrides: Partial<LiveVoiceActivity>): LiveVoiceActivity => ({
    runId: "run-1",
    status: "detected",
    provider,
    finalized: [speech],
    provisional: [{ startSeconds: 1.2, endSeconds: 1.5, score: 0.8 }],
    stableUntilSeconds: 1,
    receivedSeconds: 1.6,
    revision: 3,
    captureMetrics: metrics,
    updatedAt: 0,
    finished: false,
    ...overrides,
  });

  async function show(props: Partial<Parameters<typeof VoiceActivityTimeline>[0]>) {
    render(
      <VoiceActivityTimeline
        live={null}
        liveDescriptor={descriptor("run-1")}
        evidence={null}
        reviewWithoutEvidence={false}
        isRecording
        now={0}
        {...props}
      />,
    );
    // Opt-in: nothing is drawn until the user asks for it.
    expect(document.querySelector("[data-vad-state]")).toBeNull();
    await userEvent.click(screen.getByLabelText("Show speech detection timeline"));
  }

  it("draws final and provisional speech distinctly, with capture health apart", async () => {
    await show({ live: live({}) });
    expect(document.querySelector('[data-vad-state="detected"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-vad-span="final"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-vad-span="provisional"]')).toHaveLength(1);
    expect(
      screen.getByText(/Unattributed speech \(provisional\) 1\.20–1\.50 s/),
    ).toBeInTheDocument();
    expect(screen.getByText(/level only, not speech/)).toBeInTheDocument();
    expect(screen.getByText(/silero-vad · silero_vad\.onnx/)).toBeInTheDocument();
  });

  it("shows a stale live timeline as stale", async () => {
    await show({ live: live({}), now: STALE_AFTER_MS + 1 });
    expect(document.querySelector('[data-vad-state="stale"]')).not.toBeNull();
    expect(screen.getByText(/timeline is stale/)).toBeInTheDocument();
  });

  it("draws an unavailable detector as unknown, not silence", async () => {
    await show({
      live: live({
        status: "unavailable",
        provider: null,
        finalized: [],
        provisional: [],
        reason: VAD_UNAVAILABLE_OFF_DESKTOP,
      }),
    });
    expect(screen.getByText(/speech and silence are unknown/)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-vad-span="unknown"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-vad-span="final"]')).toHaveLength(0);
  });

  it("reviews saved evidence with its provider and parity, and legacy sessions as unknown", async () => {
    const evidence = {
      schemaVersion: 1,
      captureRunId: "run-1",
      analyzedAt: "2026-10-31T12:00:00.000Z",
      status: "detected",
      provider,
      coverage: { startSeconds: 0, endSeconds: 2 },
      speech: [{ startSeconds: 0.2, endSeconds: 0.9, maxSpeechProbability: 0.98 }],
      unknown: [{ startSeconds: 1.2, endSeconds: 1.4, reason: "captureGap" }],
      attribution: "unattributed",
      processingMs: 3,
      live: {
        status: "detected",
        revisions: 3,
        finalizedSpans: 1,
        maxUpdateMs: 0.4,
        parity: { state: "match", spans: 1 },
      },
    } satisfies VoiceActivityEvidence;
    await show({ evidence, isRecording: false });
    expect(screen.getByText(/1 unattributed speech interval, 0\.7 s/)).toBeInTheDocument();
    expect(document.querySelector('[data-vad-parity="match"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-vad-span="unknown"]')).toHaveLength(1);
  });

  it("a reviewed session without VAD says so", async () => {
    await show({ reviewWithoutEvidence: true, isRecording: false });
    expect(screen.getByText(/No speech detection for this recording/)).toBeInTheDocument();
  });
});
