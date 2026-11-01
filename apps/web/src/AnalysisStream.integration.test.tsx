import type { LiveAnalysisEvidence } from "@stutter-tracker/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { emptyReport } from "./app/analysis";
import {
  type AnalysisStreamApi,
  STREAM_UNAVAILABLE_OFF_DESKTOP,
  useAnalysisStream,
} from "./app/hooks/useAnalysisStream";
import { isAnalysisReport } from "./storage/sessionBackup";
import type { PauseSpan, TranscriptSegment } from "./types";

const work = {
  updates: 2,
  noOpUpdates: 0,
  duplicateUpdates: 0,
  rejectedUpdates: 0,
  segmentsAnalyzed: 3,
  tokensAnalyzed: 7,
  pausesAnalyzed: 1,
  segmentsRevisited: 0,
  pausesRevisited: 0,
  fullRebuilds: 0,
  reportsBuilt: 2,
  reportEvents: 3,
  reportChunks: 4,
  chunkEventReads: 5,
  retainedSegments: 3,
  retainedPauses: 1,
  retainedEvents: 2,
  retainedCitedObservations: 2,
};

type Push = {
  runId: string;
  seq: number;
  segmentsFrom: number;
  segments: TranscriptSegment[];
  pausesFrom: number;
  pauses: PauseSpan[];
};

/**
 * The desktop stream as the Rust side answers it: it holds what the updates built and reports
 * `interrupted` for an update that does not fit, like `AnalysisStream::push`.
 */
function fakeDesktop(options: { pushDelayMs?: number; interruptSeq?: number } = {}) {
  const pushes: Push[] = [];
  const finishes: Array<{ runId: string; segments: TranscriptSegment[]; pauses: PauseSpan[] }> = [];
  let held = { segments: [] as TranscriptSegment[], pauses: [] as PauseSpan[] };
  let clock = 0;
  const api: AnalysisStreamApi = {
    isDesktop: () => true,
    now: () => clock,
    async invoke<T>(command: string, args: Record<string, unknown>) {
      if (command === "analysis_stream_start") {
        held = { segments: [], pauses: [] };
        return undefined as T;
      }
      if (command === "analysis_stream_push") {
        const request = args.request as Push;
        pushes.push(request);
        if (options.pushDelayMs) await new Promise((r) => setTimeout(r, options.pushDelayMs));
        if (request.seq === options.interruptSeq) {
          return {
            runId: request.runId,
            seq: request.seq,
            status: "interrupted",
            reason: "update missing",
            changed: false,
            work,
            processingMs: 0.1,
          } as T;
        }
        held = {
          segments: [...held.segments.slice(0, request.segmentsFrom), ...request.segments],
          pauses: [...held.pauses.slice(0, request.pausesFrom), ...request.pauses],
        };
        return {
          runId: request.runId,
          seq: request.seq,
          status: "live",
          changed: true,
          report: { ...emptyReport(), wordCount: held.segments.length },
          work,
          processingMs: 0.1,
        } as T;
      }
      if (command === "analysis_stream_finish") {
        const request = args.request as (typeof finishes)[number];
        finishes.push(request);
        const same =
          JSON.stringify(request.segments) === JSON.stringify(held.segments) &&
          JSON.stringify(request.pauses) === JSON.stringify(held.pauses);
        return {
          runId: request.runId,
          status: "live",
          parity: same
            ? { state: "match", events: 0, chunks: held.segments.length, observations: 1 }
            : { state: "mismatch", differenceCount: 1, differences: ["report.wordCount"] },
          work,
          maxUpdateMs: 0.2,
          oracleMs: 1.5,
        } as T;
      }
      throw new Error(`unexpected ${command}`);
    },
  };
  return { api, pushes, finishes, tick: (ms: number) => (clock += ms) };
}

function segment(text: string, start: number): TranscriptSegment {
  return { text, startSeconds: start, endSeconds: start + 1, isFinal: true };
}

const pause: PauseSpan = { startSeconds: 1, endSeconds: 2 };

describe("incremental analysis while recording (vox#38)", () => {
  it("sends only what changed, reports live, and saves exact batch parity at the end", async () => {
    const desktop = fakeDesktop();
    const reports: number[] = [];
    const { result } = renderHook(() => useAnalysisStream(desktop.api));
    const a = segment("I I want", 0);
    const b = segment("um the ball", 1);
    act(() =>
      result.current.start("run-1", "2026-11-01T00:00:00.000Z", (r) => reports.push(r.wordCount)),
    );
    expect(result.current.live).toBe(true);
    act(() => result.current.sync([a], []));
    await waitFor(() => expect(reports).toEqual([1]));
    act(() => result.current.sync([a, b], [pause]));
    await waitFor(() => expect(reports).toEqual([1, 2]));
    // Unchanged input sends nothing.
    act(() => result.current.sync([a, b], [pause]));
    // A correction of the newest segment replaces it only.
    const corrected = { ...b, text: "um the the ball" };
    act(() => result.current.sync([a, corrected], [pause]));
    await waitFor(() => expect(reports).toEqual([1, 2, 2]));
    expect(
      desktop.pushes.map(({ segmentsFrom, segments, pausesFrom, pauses }) => [
        segmentsFrom,
        segments.length,
        pausesFrom,
        pauses.length,
      ]),
    ).toEqual([
      [0, 1, 0, 0],
      [1, 1, 0, 1],
      [1, 1, 1, 0],
    ]);

    let evidence: LiveAnalysisEvidence | null = null;
    await act(async () => {
      evidence = await result.current.finish([a, corrected], [pause]);
    });
    expect(result.current.live).toBe(false);
    expect(desktop.finishes).toHaveLength(1);
    expect(evidence).toMatchObject({
      captureRunId: "run-1",
      status: "live",
      parity: { state: "match" },
      work,
      oracleMs: 1.5,
    });
    expect(result.current.evidenceRef.current).toBe(evidence);
    expect(isAnalysisReport({ ...emptyReport(), liveAnalysis: evidence })).toBe(true);
    // Late changes after the end do not reach the stream.
    act(() => result.current.sync([a], []));
    expect(desktop.pushes).toHaveLength(3);
  });

  it("keeps one update in flight and folds later changes into the next", async () => {
    const desktop = fakeDesktop({ pushDelayMs: 200 });
    const { result } = renderHook(() => useAnalysisStream(desktop.api));
    const items = [0, 1, 2, 3, 4].map((index) => segment(`w${index}`, index));
    act(() => result.current.start("run-1", "t", () => undefined));
    act(() => result.current.sync(items.slice(0, 1), []));
    await waitFor(() => expect(desktop.pushes).toHaveLength(1), { interval: 2 });
    act(() => result.current.sync(items.slice(0, 2), []));
    act(() => result.current.sync(items.slice(0, 3), []));
    act(() => result.current.sync(items.slice(0, 5), []));
    let evidence: LiveAnalysisEvidence | null = null;
    await act(async () => {
      evidence = await result.current.finish(items, []);
    });
    // The three changes waiting behind the first update went as one.
    expect(desktop.pushes.map((push) => [push.segmentsFrom, push.segments.length])).toEqual([
      [0, 1],
      [1, 4],
    ]);
    expect(evidence).toMatchObject({ parity: { state: "match" }, queue: { coalescedChanges: 2 } });
  });

  it("resynchronizes from the start after an interruption, so parity stays comparable", async () => {
    const desktop = fakeDesktop({ interruptSeq: 1 });
    const { result } = renderHook(() => useAnalysisStream(desktop.api));
    const a = segment("a", 0);
    const b = segment("b", 1);
    act(() => result.current.start("run-1", "t", () => undefined));
    act(() => result.current.sync([a], []));
    await waitFor(() => expect(desktop.pushes).toHaveLength(1), { interval: 2 });
    act(() => result.current.sync([a, b], []));
    await waitFor(() => expect(desktop.pushes).toHaveLength(2));
    let evidence: LiveAnalysisEvidence | null = null;
    await act(async () => {
      evidence = await result.current.finish([a, b], []);
    });
    expect(desktop.pushes[2]).toMatchObject({ segmentsFrom: 0, pausesFrom: 0 });
    expect(evidence).toMatchObject({ parity: { state: "match" } });
  });

  it("ignores the reports of an older capture once a new one started", async () => {
    const desktop = fakeDesktop({ pushDelayMs: 200 });
    const seen: string[] = [];
    const { result } = renderHook(() => useAnalysisStream(desktop.api));
    act(() => result.current.start("old", "t", () => seen.push("old")));
    act(() => result.current.sync([segment("a", 0)], []));
    await waitFor(() => expect(desktop.pushes).toHaveLength(1), { interval: 2 });
    act(() => result.current.start("new", "t", () => seen.push("new")));
    act(() => result.current.sync([segment("b", 0)], []));
    await waitFor(() => expect(seen).toEqual(["new"]));
  });

  it("is unavailable off the desktop: the batch analysis stays in charge, nothing is compared", async () => {
    const desktop = fakeDesktop();
    const { result } = renderHook(() =>
      useAnalysisStream({ ...desktop.api, isDesktop: () => false }),
    );
    act(() => result.current.start("run-1", "t", () => undefined));
    expect(result.current.live).toBe(false);
    act(() => result.current.sync([segment("a", 0)], []));
    let evidence: LiveAnalysisEvidence | null = null;
    await act(async () => {
      evidence = await result.current.finish([segment("a", 0)], []);
    });
    expect(desktop.pushes).toHaveLength(0);
    expect(evidence).toMatchObject({
      status: "unavailable",
      reason: STREAM_UNAVAILABLE_OFF_DESKTOP,
      parity: { state: "notComparable" },
      work: null,
    });
  });

  it("rejects malformed saved evidence", () => {
    expect(
      isAnalysisReport({
        ...emptyReport(),
        liveAnalysis: { schemaVersion: 1, captureRunId: "x", status: "live" },
      }),
    ).toBe(false);
  });
});
