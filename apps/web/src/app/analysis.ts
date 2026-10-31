// Speech analysis: the desktop or compute-client run, its fallback, and the empty report.
import { type AnalyzedSpeech, ON_DEVICE_ANALYZER } from "@stutter-tracker/compute-client";
import {
  type AnalyzerIdentity,
  audioFingerprint,
  fallbackAnalyze as sharedFallbackAnalyze,
  observationFingerprint,
} from "@stutter-tracker/shared";
import { invoke } from "@tauri-apps/api/core";
import { measureCaptureOnDevice } from "../audio/captureKernel";
import {
  type AnalysisReport,
  type BlockerStats,
  type PauseSpan,
  type SpeechStats,
  type TranscriptSegment,
} from "../types";
import { TRANSCRIPTION_TARGET_SAMPLE_RATE, computeClient, isDesktopApp } from "./config";
import { resampleSamples } from "./transcription";

async function analyze(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
}): Promise<AnalyzedSpeech> {
  if (!isDesktopApp()) {
    return computeClient.analyzeSpeechSessionRun(request);
  }
  const report = await invoke<AnalysisReport & { analyzerVersion?: string }>(
    "analyze_speech_session",
    { request },
  );
  return { report, analyzer: desktopAnalyzer(report.analyzerVersion) };
}

/** The desktop command reports its detector version; older desktop builds leave it unknown. */
export function desktopAnalyzer(version: string | undefined): AnalyzerIdentity {
  return {
    producer: "desktopNative",
    algorithm: "analyze_speech_session",
    version: version ?? null,
  };
}

export async function analyzeWithFallback(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
}): Promise<
  AnalyzedSpeech & {
    usedAudio: boolean;
    inputId: string;
    audioId: string | null;
    runId: string;
    createdAt: string;
  }
> {
  const usedAudio = Boolean(request.samples?.length && request.sampleRate);
  // Minted here, where the analyzer actually runs, so a cached result keeps its identity.
  const provenance = {
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    usedAudio,
    audioId:
      usedAudio && request.samples && request.sampleRate
        ? audioFingerprint(request.samples, request.sampleRate)
        : null,
    inputId: observationFingerprint(request.segments, request.pauses),
  };
  // An on-device analysis (the compute client's own fallback, or this one) measures the analyzed
  // audio window with the WASM kernel; without a kernel the run stays unmeasured. Metrics reported
  // by the desktop app or a compute server are kept as they are.
  const measuredOnDevice = async ({
    report,
    analyzer,
  }: AnalyzedSpeech): Promise<AnalyzedSpeech> => {
    if (
      analyzer.producer !== ON_DEVICE_ANALYZER.producer ||
      report.captureMetrics ||
      !usedAudio ||
      !request.samples ||
      !request.sampleRate
    ) {
      return { report, analyzer };
    }
    const captureMetrics = await measureCaptureOnDevice(request.samples, request.sampleRate);
    return { report: captureMetrics ? { ...report, captureMetrics } : report, analyzer };
  };
  let analyzed: AnalyzedSpeech;
  try {
    analyzed = await analyze(request);
  } catch {
    analyzed = { report: fallbackAnalyze(request), analyzer: ON_DEVICE_ANALYZER };
  }
  return { ...(await measuredOnDevice(analyzed)), ...provenance };
}

export function fallbackAnalyze(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
}): AnalysisReport {
  return sharedFallbackAnalyze(request) as AnalysisReport;
}

function emptySpeechStats(): SpeechStats {
  return {
    speakingDurationSeconds: 0,
    pauseDurationSeconds: 0,
    wordsPerMinute: 0,
    articulationRateWpm: 0,
    meanChunkWords: 0,
    meanChunkDurationSeconds: 0,
    eventDensityPer100Words: 0,
    fluencyPercentage: 100,
  };
}

function emptyBlockerStats(): BlockerStats {
  return {
    blockCount: 0,
    totalBlockSeconds: 0,
    averageBlockSeconds: 0,
    longestBlockSeconds: 0,
    blocksPerMinute: 0,
    blockedTimePercentage: 0,
  };
}

export function analysisAudioPayload(samples: number[], sampleRate: number) {
  if (!samples.length || sampleRate <= 0) {
    return {};
  }
  const maxSourceSamples = Math.floor(sampleRate * 90);
  const capped = samples.slice(Math.max(0, samples.length - maxSourceSamples));
  return {
    samples: resampleSamples(capped, sampleRate, TRANSCRIPTION_TARGET_SAMPLE_RATE),
    sampleRate: TRANSCRIPTION_TARGET_SAMPLE_RATE,
  };
}

export function emptyReport(): AnalysisReport {
  return {
    totalDurationSeconds: 0,
    wordCount: 0,
    stutterCount: 0,
    stuttersPerMinute: 0,
    severity: "none",
    speechStats: emptySpeechStats(),
    blockerStats: emptyBlockerStats(),
    chunks: [],
    events: [],
    byKind: {},
  };
}

export function normalizedSpeechStats(report: AnalysisReport): SpeechStats {
  return report.speechStats ?? emptySpeechStats();
}

export function normalizedBlockerStats(report: AnalysisReport): BlockerStats {
  return report.blockerStats ?? emptyBlockerStats();
}
