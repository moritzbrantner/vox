import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { withCaptureQuality } from "../../audio/captureQuality";
import { analysisAudioPayload, analyzeWithFallback } from "../analysis";
import { TRANSCRIPTION_TARGET_SAMPLE_RATE } from "../config";
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
>;

/** Analysis of the workspace observation, and applying its result to the report. */
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
}: LiveAnalysisDeps) {
  const analysisRequest = useMemo(() => {
    const audio = analysisAudioPayload(samplesRef.current, sampleRateRef.current);
    return {
      segments,
      pauses,
      sessionStartedAt: startedAtRef.current?.toISOString(),
      ...audio,
    };
    // captureRevision is a deliberate trigger: samplesRef is a ref and not a dependency itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, pauses, captureRevision]);
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

  const analysisQuery = useQuery({
    // Gaps are appended to the descriptor during capture; a new gap must re-gate the report.
    queryKey: [
      "analysis",
      analysisRequest,
      analysisDescriptor?.runId ?? null,
      analysisDescriptor?.discontinuities.length ?? 0,
      // The same analyzed tail of a longer capture covers a different share of it.
      analysisCaptureSeconds,
    ],
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
    enabled: viewedSession === null,
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

  return { analysisRequest, analysisQuery, isAnalyzing };
}
