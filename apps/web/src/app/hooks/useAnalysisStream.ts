import {
  type AnalyzerIdentity,
  AnalysisStreamHost,
  LIVE_ANALYSIS_SCHEMA_VERSION,
  type LiveAnalysisEvidence,
  type LiveAnalysisStatus,
  SHARED_ANALYSIS_VERSION,
  type StreamFinished,
  type StreamUpdate,
} from "@stutter-tracker/shared";
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import type { AnalysisReport, PauseSpan, TranscriptSegment } from "../../types";
import { isDesktopApp } from "../config";

type StreamReport = AnalysisReport & { analyzerVersion?: string };

type Observation = { segments: TranscriptSegment[]; pauses: PauseSpan[] };

type Run = {
  runId: string;
  sessionStartedAt: string;
  seq: number;
  /** What the desktop holds: the observation of the last applied update. */
  sent: Observation;
  /** Changes waiting while an update is in flight; only the newest is kept. */
  pending: (Observation & { since: number }) | null;
  busy: boolean;
  chain: Promise<void>;
  status: LiveAnalysisStatus;
  reason?: string;
  finished: boolean;
  coalescedChanges: number;
  maxStalenessMs: number;
  onReport: (report: StreamReport, analyzer: AnalyzerIdentity) => void;
};

/**
 * Where the stream runs: the desktop app's Rust stream (vox#38) behind its commands, or this
 * device's shared stream (vox#154) behind the same commands. Both are exact against their batch.
 */
export type AnalysisStreamApi = {
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  /** Who produced a stream report. */
  analyzer: (report: StreamReport) => AnalyzerIdentity;
  now: () => number;
};

const desktopApi: AnalysisStreamApi = {
  invoke: (command, args) => invoke(command, args),
  analyzer: (report) => ({
    producer: "desktopNative",
    algorithm: "analysis_stream",
    version: report.analyzerVersion ?? null,
  }),
  now: () => performance.now(),
};

/** The shared stream in this page, answering the desktop's stream commands. */
export function onDeviceStreamApi(): AnalysisStreamApi {
  const host = new AnalysisStreamHost();
  return {
    async invoke<T>(command: string, args: Record<string, unknown>) {
      const request = args.request as never;
      switch (command) {
        case "analysis_stream_start":
          return host.start(request) as T;
        case "analysis_stream_push":
          return host.push(request) as T;
        case "analysis_stream_finish":
          return host.finish(request) as T;
        default:
          throw new Error(`unknown analysis stream command ${command}`);
      }
    },
    analyzer: () => ({
      producer: "onDevice",
      algorithm: "analysis_stream",
      version: SHARED_ANALYSIS_VERSION,
    }),
    now: () => performance.now(),
  };
}

const defaultApi = () => (isDesktopApp() ? desktopApi : onDeviceStreamApi());

/** Length of the common prefix; observations are immutable, so identity means unchanged. */
function unchangedPrefix<T>(held: T[], next: T[]) {
  const limit = Math.min(held.length, next.length);
  let index = 0;
  while (index < limit && held[index] === next[index]) index += 1;
  return index;
}

/**
 * Incremental analysis of one capture at a time (vox#38, vox#154): while recording, only what
 * changed in the transcript and pauses is sent to the stream (the desktop's, or this device's
 * elsewhere), one update in flight and later changes coalesced into the next. After Stop,
 * `finish` compares the stream's report with the batch analysis of the final observation and
 * returns the evidence saved with the session. Updates of an older capture never reach a newer
 * one.
 */
export function useAnalysisStream(apiOverride?: AnalysisStreamApi) {
  // One stream host for the life of the page: its active run is the session being recorded.
  const apiRef = useRef<AnalysisStreamApi | null>(null);
  apiRef.current ??= apiOverride ?? defaultApi();
  const api = apiRef.current;
  const runRef = useRef<Run | null>(null);
  const evidenceRef = useRef<LiveAnalysisEvidence | null>(null);
  // Whether the live report comes from the stream; the batch analysis waits until it does not.
  const [live, setLive] = useState(false);

  function setStatus(run: Run, status: LiveAnalysisStatus, reason?: string) {
    run.status = status;
    run.reason = reason;
    if (runRef.current === run) setLive(status === "live" && !run.finished);
  }

  function start(
    runId: string,
    sessionStartedAt: string,
    onReport: (report: StreamReport, analyzer: AnalyzerIdentity) => void,
  ) {
    evidenceRef.current = null;
    const run: Run = {
      runId,
      sessionStartedAt,
      seq: 0,
      sent: { segments: [], pauses: [] },
      pending: null,
      busy: true,
      chain: Promise.resolve(),
      status: "live",
      finished: false,
      coalescedChanges: 0,
      maxStalenessMs: 0,
      onReport,
    };
    runRef.current = run;
    setLive(true);
    run.chain = api
      .invoke<void>("analysis_stream_start", { request: { runId, sessionStartedAt } })
      .then(() => pump(run, null))
      .catch((error: unknown) => {
        run.busy = false;
        setStatus(run, "failed", String(error));
      });
  }

  async function pump(run: Run, first: (Observation & { since: number }) | null) {
    let next = first ?? takePending(run);
    while (next && runRef.current === run && run.status !== "failed") {
      await push(run, next);
      next = takePending(run);
    }
    run.busy = false;
  }

  function takePending(run: Run) {
    const pending = run.pending;
    run.pending = null;
    return pending;
  }

  async function push(run: Run, next: Observation & { since: number }) {
    const segmentsFrom = unchangedPrefix(run.sent.segments, next.segments);
    const pausesFrom = unchangedPrefix(run.sent.pauses, next.pauses);
    if (
      segmentsFrom === next.segments.length &&
      segmentsFrom === run.sent.segments.length &&
      pausesFrom === next.pauses.length &&
      pausesFrom === run.sent.pauses.length
    ) {
      return;
    }
    const seq = run.seq;
    run.seq += 1;
    try {
      const update = await api.invoke<StreamUpdate>("analysis_stream_push", {
        request: {
          runId: run.runId,
          seq,
          segmentsFrom,
          segments: next.segments.slice(segmentsFrom),
          pausesFrom,
          pauses: next.pauses.slice(pausesFrom),
        },
      });
      if (runRef.current !== run || update.runId !== run.runId) return;
      run.maxStalenessMs = Math.max(run.maxStalenessMs, api.now() - next.since);
      if (update.status === "interrupted") {
        // The stream no longer holds what this client sent: the next update starts over.
        run.sent = { segments: [], pauses: [] };
      } else if (update.status === "live") {
        run.sent = { segments: next.segments, pauses: next.pauses };
      }
      setStatus(run, update.status, update.reason);
      if (update.status === "live" && update.report && !run.finished) {
        run.onReport(update.report, api.analyzer(update.report));
      }
    } catch (error) {
      setStatus(run, "failed", String(error));
    }
  }

  /** Sends the current observation; while an update is in flight it waits, coalesced. */
  function sync(segments: TranscriptSegment[], pauses: PauseSpan[]) {
    const run = runRef.current;
    if (!run || run.finished || (run.status !== "live" && run.status !== "interrupted")) return;
    const next = { segments, pauses, since: run.pending?.since ?? api.now() };
    if (run.busy) {
      if (run.pending) run.coalescedChanges += 1;
      run.pending = next;
      return;
    }
    run.busy = true;
    run.chain = pump(run, next);
  }

  /**
   * Ends the stream with the final observation: sends what is still pending, then compares the
   * stream's report with the batch analysis of exactly this observation.
   */
  async function finish(
    segments: TranscriptSegment[],
    pauses: PauseSpan[],
  ): Promise<LiveAnalysisEvidence | null> {
    const run = runRef.current;
    if (!run || run.finished) return null;
    run.finished = true;
    setLive(false);
    const base = {
      schemaVersion: LIVE_ANALYSIS_SCHEMA_VERSION,
      captureRunId: run.runId,
      queue: { coalescedChanges: run.coalescedChanges, maxStalenessMs: run.maxStalenessMs },
    } as const;
    if (run.status === "failed") {
      const evidence: LiveAnalysisEvidence = {
        ...base,
        finishedAt: new Date().toISOString(),
        status: run.status,
        ...(run.reason ? { reason: run.reason } : {}),
        parity: { state: "notComparable", reason: `incremental analysis ${run.status}` },
        work: null,
        maxUpdateMs: 0,
        oracleMs: 0,
      };
      evidenceRef.current = evidence;
      return evidence;
    }
    await run.chain;
    run.pending = null;
    if (run.status === "live" || run.status === "interrupted") {
      await push(run, { segments, pauses, since: api.now() });
    }
    if (runRef.current !== run) return null;
    let evidence: LiveAnalysisEvidence;
    try {
      const finished = await api.invoke<StreamFinished>("analysis_stream_finish", {
        request: { runId: run.runId, segments, pauses, sessionStartedAt: run.sessionStartedAt },
      });
      evidence = {
        ...base,
        queue: { coalescedChanges: run.coalescedChanges, maxStalenessMs: run.maxStalenessMs },
        finishedAt: new Date().toISOString(),
        status: finished.status,
        ...(finished.reason ? { reason: finished.reason } : {}),
        parity: finished.parity,
        work: finished.work,
        maxUpdateMs: finished.maxUpdateMs,
        oracleMs: finished.oracleMs,
      };
    } catch (error) {
      evidence = {
        ...base,
        finishedAt: new Date().toISOString(),
        status: "failed",
        reason: String(error),
        parity: { state: "notComparable", reason: "incremental analysis failed" },
        work: null,
        maxUpdateMs: 0,
        oracleMs: 0,
      };
    }
    if (runRef.current !== run) return null;
    evidenceRef.current = evidence;
    return evidence;
  }

  return { live, evidenceRef, start, sync, finish };
}
