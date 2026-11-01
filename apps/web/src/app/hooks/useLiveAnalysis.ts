import { hashKey, useQuery } from "@tanstack/react-query";
import { UNKNOWN_INPUT_ID } from "@stutter-tracker/shared";
import { useEffect, useMemo } from "react";
import { withCaptureQuality } from "../../audio/captureQuality";
import { analysisAudioPayload, analyzeWithFallback } from "../analysis";
import { TRANSCRIPTION_TARGET_SAMPLE_RATE } from "../config";
import type { useAnalysisStream } from "./useAnalysisStream";
import type { useWorkspace } from "./useWorkspace";

type LiveAnalysisDeps = Pick<
  ReturnType<typeof useWorkspace>,
  | "segments"
  | "pauses"
  | "setReport"
  | "setReportRun"
  | "transcriptModelRef"
  | "captureRevision"
  | "startedAtRef"
  | "sampleRateRef"
  | "samplesRef"
  | "capturedSampleCountRef"
  | "captureDescriptorRef"
  | "viewedSession"
  | "viewedSessionRef"
> & {
  analysisStream: Pick<ReturnType<typeof useAnalysisStream>, "live" | "start" | "sync">;
};

/**
 * Analysis of the workspace observation, and applying its result to the report. While the
 * desktop's incremental analysis is live, it supplies the report from what changed (vox#38) and
 * the batch analysis waits; after Stop the batch analysis runs once over the whole capture.
 */
export function useLiveAnalysis({
  segments,
  pauses,
  setReport,
  setReportRun,
  transcriptModelRef,
  captureRevision,
  startedAtRef,
  sampleRateRef,
  samplesRef,
  capturedSampleCountRef,
  captureDescriptorRef,
  viewedSession,
  viewedSessionRef,
  analysisStream,
}: LiveAnalysisDeps) {
  const streamLive = analysisStream.live;
  const analysisRequest = useMemo(() => {
    // While streaming, no audio is resampled for a batch run that is not going to happen.
    const audio = streamLive ? {} : analysisAudioPayload(samplesRef.current, sampleRateRef.current);
    return {
      segments,
      pauses,
      sessionStartedAt: startedAtRef.current?.toISOString(),
      ...audio,
    };
    // captureRevision is a deliberate trigger: samplesRef is a ref and not a dependency itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, pauses, captureRevision, streamLive]);
  // Read with the observation above, so the quality gate describes the capture analyzed (also a
  // recovered one whose audio is gone). It stays on this device: analysis requests never carry it.
  const analysisDescriptor = useMemo(() => captureDescriptorRef.current, [analysisRequest]);
  const analysisCaptureSeconds = useMemo(
    () =>
      sampleRateRef.current > 0
        ? Math.max(capturedSampleCountRef.current, samplesRef.current.length) /
          sampleRateRef.current
        : 0,
    // Read with the observation above, like the descriptor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analysisRequest],
  );

  const analysisQueryKey = useMemo(
    // Gaps are appended to the descriptor during capture; a new gap must re-gate the report.
    () => [
      "analysis",
      analysisRequest,
      analysisDescriptor?.runId ?? null,
      analysisDescriptor?.discontinuities.length ?? 0,
      // The same analyzed tail of a longer capture covers a different share of it.
      analysisCaptureSeconds,
    ],
    [
      analysisRequest,
      analysisDescriptor?.runId,
      analysisDescriptor?.discontinuities.length,
      analysisCaptureSeconds,
    ],
  );
  // The key holds up to 90 s of samples and the app renders on every audio frame, so its default
  // hash (the same function) is computed once per key instead of several times per render.
  const analysisQueryHash = useMemo(() => hashKey(analysisQueryKey), [analysisQueryKey]);

  const analysisQuery = useQuery({
    queryKey: analysisQueryKey,
    queryHash: analysisQueryHash,
    queryFn: async () => {
      const analysis = await analyzeWithFallback(analysisRequest);
      return {
        ...analysis,
        report: withCaptureQuality(
          analysis.report,
          analysisDescriptor,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          analysisCaptureSeconds,
        ),
      };
    },
    enabled: viewedSession === null && !streamLive,
  });

  const isAnalyzing = analysisQuery.isFetching;

  useEffect(() => {
    // A late result must not replace a saved session's stored analysis.
    if (analysisQuery.data && viewedSessionRef.current === null) {
      setReport(analysisQuery.data.report);
      setReportRun({
        id: analysisQuery.data.runId,
        createdAt: analysisQuery.data.createdAt,
        analyzer: analysisQuery.data.analyzer,
        usedAudio: analysisQuery.data.usedAudio,
        audioId: analysisQuery.data.audioId,
        inputId: analysisQuery.data.inputId,
        transcription: transcriptModelRef.current,
      });
    }
  }, [analysisQuery.data]);

  // Only what changed reaches the stream; it ignores calls when no capture run is streaming.
  useEffect(() => {
    if (viewedSession === null) analysisStream.sync(segments, pauses);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, pauses, viewedSession]);

  /** Starts the incremental analysis of a capture run; its reports are the live report. */
  function startAnalysisStream(runId: string, sessionStartedAt: string) {
    analysisStream.start(runId, sessionStartedAt, (report) => {
      const descriptor = captureDescriptorRef.current;
      if (viewedSessionRef.current !== null || descriptor?.runId !== runId) return;
      setReport(
        withCaptureQuality(
          report,
          descriptor,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          sampleRateRef.current > 0 ? capturedSampleCountRef.current / sampleRateRef.current : 0,
        ),
      );
      setReportRun({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        analyzer: {
          producer: "desktopNative",
          algorithm: "analysis_stream",
          version: report.analyzerVersion ?? null,
        },
        usedAudio: false,
        audioId: null,
        // A provisional live report; the batch run after Stop identifies its input.
        inputId: UNKNOWN_INPUT_ID,
        transcription: transcriptModelRef.current,
      });
    });
  }

  return { analysisRequest, analysisQuery, isAnalyzing, startAnalysisStream };
}
