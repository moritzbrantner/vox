import {
  type DetectorSpan,
  type LiveVoiceActivitySummary,
  type MeasuredCaptureMetrics,
  type RecordingDescriptor,
  type VoiceActivityEvidence,
  type VoiceActivityProvider,
  type VoiceActivityStatus,
  compareLiveWithFinite,
  voiceActivityEvidence,
} from "@stutter-tracker/shared";
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { isDesktopApp } from "../config";

/** Speech detection runs in the desktop app; elsewhere it is unavailable, never "no speech". */
export const VAD_UNAVAILABLE_OFF_DESKTOP =
  "Speech detection (Silero VAD) runs only in the desktop app.";

/** Chunks waiting for the detector beyond this are dropped, which interrupts live detection. */
const MAX_PENDING_CHUNKS = 32;

type LiveStarted = {
  runId: string;
  status: VoiceActivityStatus;
  provider?: VoiceActivityProvider;
  reason?: string;
};

type LiveUpdate = {
  runId: string;
  seq: number;
  status: VoiceActivityStatus;
  revision: number;
  receivedSeconds: number;
  analyzedSeconds: number;
  stableUntilSeconds: number;
  finalized: Array<DetectorSpan & { index: number }>;
  provisional: DetectorSpan[];
  captureMetrics: MeasuredCaptureMetrics;
  finished: boolean;
  reason?: string;
  processingMs: number;
};

type FiniteResult = {
  status: VoiceActivityStatus;
  provider?: VoiceActivityProvider;
  reason?: string;
  analyzedSeconds: number;
  segments: DetectorSpan[];
  captureMetrics?: MeasuredCaptureMetrics;
  processingMs: number;
};

/** The live view of one capture, in stream seconds of the recorded samples. */
export type LiveVoiceActivity = {
  runId: string;
  status: VoiceActivityStatus | "starting";
  provider: VoiceActivityProvider | null;
  reason?: string;
  finalized: DetectorSpan[];
  provisional: DetectorSpan[];
  stableUntilSeconds: number;
  receivedSeconds: number;
  revision: number;
  captureMetrics: MeasuredCaptureMetrics | null;
  /** `performance.now()` of the last applied update. */
  updatedAt: number;
  finished: boolean;
};

export type VoiceActivityApi = {
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  isDesktop: () => boolean;
  now: () => number;
};

const defaultApi: VoiceActivityApi = {
  invoke: (command, args) => invoke(command, args),
  isDesktop: isDesktopApp,
  now: () => performance.now(),
};

/**
 * Live Silero VAD while recording and the finite run after Stop, for one capture at a time.
 * Updates of an older capture never reach a newer one: every update carries its run id.
 */
export function useVoiceActivity(api: VoiceActivityApi = defaultApi) {
  const [live, setLive] = useState<LiveVoiceActivity | null>(null);
  const liveRef = useRef<LiveVoiceActivity | null>(null);
  const evidenceRef = useRef<VoiceActivityEvidence | null>(null);
  const [evidence, setEvidenceState] = useState<VoiceActivityEvidence | null>(null);
  function setEvidence(next: VoiceActivityEvidence | null) {
    evidenceRef.current = next;
    setEvidenceState(next);
  }
  const runRef = useRef<{
    runId: string;
    seq: number;
    pending: number;
    chain: Promise<void>;
    finalized: DetectorSpan[];
    revisions: number;
    maxUpdateMs: number;
    status: VoiceActivityStatus | "starting";
    sealed: boolean;
    reason?: string;
  } | null>(null);

  function apply(next: LiveVoiceActivity | null) {
    liveRef.current = next;
    setLive(next);
  }

  function start(runId: string, sampleRate: number) {
    setEvidence(null);
    const base: LiveVoiceActivity = {
      runId,
      status: "starting",
      provider: null,
      finalized: [],
      provisional: [],
      stableUntilSeconds: 0,
      receivedSeconds: 0,
      revision: 0,
      captureMetrics: null,
      updatedAt: api.now(),
      finished: false,
    };
    if (!api.isDesktop()) {
      runRef.current = null;
      apply({ ...base, status: "unavailable", reason: VAD_UNAVAILABLE_OFF_DESKTOP });
      return;
    }
    const run = {
      runId,
      seq: 0,
      pending: 0,
      chain: Promise.resolve(),
      finalized: [] as DetectorSpan[],
      revisions: 0,
      maxUpdateMs: 0,
      status: "starting" as VoiceActivityStatus | "starting",
      sealed: false,
      reason: undefined as string | undefined,
    };
    runRef.current = run;
    apply(base);
    run.chain = api
      .invoke<LiveStarted>("voice_activity_start", { request: { runId, sampleRate } })
      .then((started) => {
        if (runRef.current !== run) return;
        run.status = started.status;
        run.reason = started.reason;
        apply({
          ...(liveRef.current ?? base),
          status: started.status,
          provider: started.provider ?? null,
          reason: started.reason,
          updatedAt: api.now(),
        });
      })
      .catch((error: unknown) => {
        if (runRef.current !== run) return;
        run.status = "failed";
        run.reason = String(error);
        apply({ ...base, status: "failed", reason: String(error) });
      });
  }

  function applyUpdate(update: LiveUpdate) {
    const run = runRef.current;
    const current = liveRef.current;
    if (!run || !current || update.runId !== run.runId || current.runId !== update.runId) return;
    run.revisions += update.revision > 0 ? 1 : 0;
    run.maxUpdateMs = Math.max(run.maxUpdateMs, update.processingMs);
    run.status = update.status;
    run.reason = update.reason;
    const finalized = update.finalized.map(({ startSeconds, endSeconds, score }) => ({
      startSeconds,
      endSeconds,
      score,
    }));
    run.finalized.push(...finalized);
    apply({
      ...current,
      status: update.status,
      reason: update.reason,
      finalized: [...current.finalized, ...finalized],
      provisional: update.status === "detected" ? update.provisional : [],
      stableUntilSeconds: update.stableUntilSeconds,
      receivedSeconds: update.receivedSeconds,
      revision: update.revision,
      captureMetrics: update.captureMetrics,
      updatedAt: api.now(),
      finished: update.finished,
    });
  }

  /** Feeds one recorder chunk; chunks are sent in order, one detector call at a time. */
  function push(chunk: Float32Array) {
    const run = runRef.current;
    if (!run || run.sealed) return;
    const seq = run.seq;
    run.seq += 1;
    if (run.pending >= MAX_PENDING_CHUNKS) {
      // Dropped: the detector sees a sequence gap and stops instead of guessing.
      return;
    }
    run.pending += 1;
    const samples = Array.from(chunk);
    run.chain = run.chain
      .then(() =>
        api.invoke<LiveUpdate>("voice_activity_push", {
          request: { runId: run.runId, seq, samples },
        }),
      )
      .then((update) => {
        if (runRef.current === run) applyUpdate(update);
      })
      .catch(() => undefined)
      .finally(() => {
        run.pending -= 1;
      });
  }

  /**
   * Stops live detection and runs the finite detector over the capture's samples. `samples` are
   * the end of the recorded stream; `capturedSampleCount` is the whole stream's length.
   */
  async function finish(input: {
    descriptor: RecordingDescriptor;
    samples: number[];
    sampleRate: number;
    capturedSampleCount: number;
  }): Promise<VoiceActivityEvidence | null> {
    const run = runRef.current;
    const { descriptor, samples, sampleRate } = input;
    const captureSeconds = sampleRate > 0 ? input.capturedSampleCount / sampleRate : 0;
    if (!run || run.runId !== descriptor.runId) {
      if (liveRef.current?.runId === descriptor.runId && liveRef.current.status === "unavailable") {
        // Off the desktop: the saved evidence states that nothing was detected, not "no speech".
        const evidence = voiceActivityEvidence({
          descriptor,
          analyzedAt: new Date().toISOString(),
          status: "unavailable",
          provider: null,
          reason: liveRef.current.reason,
          spans: [],
          streamOffsetSeconds: captureSeconds,
          analyzedSeconds: 0,
          captureSeconds,
          processingMs: 0,
          live: null,
        });
        setEvidence(evidence);
        apply({ ...liveRef.current, finished: true });
        return evidence;
      }
      return null;
    }
    await run.chain;
    let liveFinal: LiveUpdate | null = null;
    try {
      liveFinal = await api.invoke<LiveUpdate>("voice_activity_finish", {
        request: { runId: run.runId },
      });
      if (runRef.current === run) applyUpdate(liveFinal);
    } catch (error) {
      run.status = "failed";
      run.reason = String(error);
    }
    if (runRef.current !== run) return null;
    let finite: FiniteResult;
    try {
      finite = await api.invoke<FiniteResult>("analyze_voice_activity", {
        request: { samples, sampleRate },
      });
    } catch (error) {
      finite = {
        status: "failed",
        reason: String(error),
        analyzedSeconds: 0,
        segments: [],
        processingMs: 0,
      };
    }
    if (runRef.current !== run) return null;
    const streamOffsetSeconds = Math.max(0, captureSeconds - samples.length / sampleRate);
    const liveStatus = run.status === "starting" ? "failed" : run.status;
    const summary: LiveVoiceActivitySummary = {
      status: liveStatus,
      revisions: run.revisions,
      finalizedSpans: run.finalized.length,
      maxUpdateMs: run.maxUpdateMs,
      ...(run.reason ? { reason: run.reason } : {}),
      parity: liveParity(
        liveStatus,
        finite.status,
        streamOffsetSeconds,
        run.finalized,
        finite.segments,
      ),
    };
    const evidence = voiceActivityEvidence({
      descriptor,
      analyzedAt: new Date().toISOString(),
      status: finite.status,
      provider: finite.provider ?? null,
      reason: finite.reason,
      spans: finite.segments,
      streamOffsetSeconds,
      analyzedSeconds: finite.analyzedSeconds,
      captureSeconds,
      processingMs: finite.processingMs,
      live: summary,
    });
    setEvidence(evidence);
    runRef.current = null;
    return evidence;
  }

  /** Stops accepting chunks: the capture ends here, before the recorder has fully stopped. */
  function seal() {
    if (runRef.current) runRef.current.sealed = true;
  }

  /** Forgets the current capture's live state (a loaded session or a new start replaces it). */
  function reset() {
    runRef.current = null;
    setEvidence(null);
    apply(null);
  }

  return { live, evidence, evidenceRef, start, push, seal, finish, reset };
}

function liveParity(
  liveStatus: VoiceActivityStatus,
  finiteStatus: VoiceActivityStatus,
  streamOffsetSeconds: number,
  live: DetectorSpan[],
  finite: DetectorSpan[],
) {
  if (liveStatus !== "detected") {
    return { state: "notComparable" as const, reason: `live detection ${liveStatus}` };
  }
  if (finiteStatus !== "detected") {
    return { state: "notComparable" as const, reason: `finite detection ${finiteStatus}` };
  }
  if (streamOffsetSeconds > 0) {
    return {
      state: "notComparable" as const,
      reason: "the finite run covered only the end of the capture",
    };
  }
  return compareLiveWithFinite(live, finite);
}
