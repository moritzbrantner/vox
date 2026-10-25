// Cross-runtime capability matrix of the speech analysis (apps/desktop/src-tauri/STUTTER_BENCH.md).
// The native row must match `speech_pipeline::native_capabilities` in the desktop app; both
// sides check it against fixtures/analysis-parity.json.
import type { AnalyzerProducer } from "./sessions";

/** `reduced`: produced by a simpler method and not comparable with a supported output. */
export type CapabilitySupport = "supported" | "reduced" | "unsupported";

export type AnalysisOutput =
  | "wordRepetition"
  | "soundRepetition"
  | "prolongation"
  | "filler"
  | "pauseBlock"
  | "acousticEvents"
  | "fusion"
  | "eventEvidence"
  | "missingObservations"
  | "captureMetrics"
  | "speakerAttribution";

export type AnalysisCapabilities = {
  producer: AnalyzerProducer;
  /** True when the analyzer lacks outputs a richer runtime produces. */
  reduced: boolean;
  outputs: Record<AnalysisOutput, CapabilitySupport>;
};

const SHARED_FALLBACK_OUTPUTS: Omit<Record<AnalysisOutput, CapabilitySupport>, "captureMetrics"> = {
  // Adjacent pairs only: a run of three is two overlapping events, not one.
  wordRepetition: "reduced",
  soundRepetition: "unsupported",
  prolongation: "supported",
  filler: "supported",
  pauseBlock: "supported",
  // Its own energy VAD and onset heuristics, without pitch or spectral features.
  acousticEvents: "reduced",
  fusion: "reduced",
  eventEvidence: "unsupported",
  missingObservations: "unsupported",
  speakerAttribution: "unsupported",
};

export const ANALYSIS_CAPABILITIES: Record<AnalyzerProducer, AnalysisCapabilities> = {
  desktopNative: {
    producer: "desktopNative",
    reduced: false,
    outputs: {
      wordRepetition: "supported",
      soundRepetition: "supported",
      prolongation: "supported",
      filler: "supported",
      pauseBlock: "supported",
      acousticEvents: "supported",
      fusion: "supported",
      eventEvidence: "supported",
      missingObservations: "supported",
      captureMetrics: "supported",
      speakerAttribution: "unsupported",
    },
  },
  // The shared fallback; the server measures capture metrics with the native worker.
  computeServer: {
    producer: "computeServer",
    reduced: true,
    outputs: { ...SHARED_FALLBACK_OUTPUTS, captureMetrics: "supported" },
  },
  // The shared fallback; capture metrics come from the WASM kernel when it loads.
  onDevice: {
    producer: "onDevice",
    reduced: true,
    outputs: { ...SHARED_FALLBACK_OUTPUTS, captureMetrics: "supported" },
  },
};

/**
 * Outputs two analyzers both fully support: only these are expected to agree on the same input
 * (event kind, span and text; confidences are calibrated per analyzer and never compared).
 */
export function equivalentOutputs(
  left: AnalysisCapabilities,
  right: AnalysisCapabilities,
): AnalysisOutput[] {
  return (Object.keys(left.outputs) as AnalysisOutput[]).filter(
    (output) => left.outputs[output] === "supported" && right.outputs[output] === "supported",
  );
}
