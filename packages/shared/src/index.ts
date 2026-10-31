import { ANALYSIS_CAPABILITIES } from "./analysisCapabilities";

export type TranscriptSegment = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  confidence?: number;
  speakerId?: string;
  speakerLabel?: string;
  speakerScore?: number;
  isFinal: boolean;
  /**
   * "unaligned" when the recognizer gave no timing for this text (browser speech) or its timing
   * is unusable: `startSeconds`/`endSeconds` then only order the segment and are never shown or
   * used to time block/prolongation events. Absent means the recognizer's own segment timing.
   */
  alignment?: "unaligned";
};

export type PauseSpan = {
  startSeconds: number;
  endSeconds: number;
  afterText?: string;
};

export type StutterKind =
  | "wordRepetition"
  | "soundRepetition"
  | "prolongation"
  | "block"
  | "filler";

export type StutterEvent = {
  kind: StutterKind;
  startSeconds: number;
  endSeconds: number;
  text: string;
  detail: string;
  confidence: number;
  source?: "transcript" | "acoustic" | "fused";
  acousticEvidence?: AcousticEvidence;
  /**
   * Native analysis only, for stages on the typed evidence path: a stable event id, the
   * observations (in `AnalysisReport.observations`) it rests on and why it was decided.
   */
  evidence?: EventEvidence;
};

export type EventEvidence = {
  id: string;
  supporting: string[];
  /** Observations that speak against the decision without overturning it; absent when none. */
  conflicting?: string[];
  explanation: string;
};

export type ObservationChannel = "transcript" | "pause" | "acoustic" | "speaker";

/** A missing channel, or uncovered part of the timeline, is never evidence of absence. */
export type MissingObservationReason =
  | "noAudio"
  | "audioTooShortForAnalysis"
  | "beyondAnalyzedAudioWindow"
  | "noFinalTranscript"
  | "noSpeakerAttribution";

/** Product-level observation with a stable id derived from its position in the input. */
export type SpeechObservation = {
  id: string;
  channel: ObservationChannel;
  startSeconds: number;
  endSeconds: number;
  /** Interpolated times are estimates spread over a segment, not measurements. */
  timing: "observed" | "interpolatedWithinSegment" | "session";
  confidence?: number;
} & (
  | { type: "transcriptToken"; raw: string; normalized: string; segment: number; token: number }
  | { type: "pause"; index: number; afterText?: string }
  | { type: "audioWindow"; sampleCount: number; sampleRate: number }
  /** Energy voice activity: someone spoke; identity is never inferred from it. */
  | { type: "speechActivity"; index: number; attribution: "unattributed"; score: number }
  | { type: "onset"; index: number; strength: number }
  | { type: "missing"; reason: MissingObservationReason }
);

export type AcousticEvidence = {
  energyRms?: number;
  silenceSeconds?: number;
  onsetCount?: number;
  onsetRate?: number;
  pitchMeanHz?: number | null;
  pitchStability?: number | null;
  spectralCentroidHz?: number;
  zeroCrossingRate?: number;
};

export type AcousticStats = {
  analyzedDurationSeconds: number;
  speechDurationSeconds: number;
  silenceDurationSeconds: number;
  voiceActivityRatio: number;
  onsetCount: number;
  meanOnsetRate: number;
  meanRms: number;
  noiseFloorRms: number;
};

export type AnalysisReport = {
  sessionStartedAt?: string;
  totalDurationSeconds: number;
  wordCount: number;
  stutterCount: number;
  stuttersPerMinute: number;
  severity: "none" | "mild" | "moderate" | "high";
  speechStats: SpeechStats;
  blockerStats: BlockerStats;
  chunks: ChunkAnalysis[];
  events: StutterEvent[];
  byKind: Partial<Record<StutterKind, number>>;
  acousticStats?: AcousticStats;
  /**
   * audio-analysis capture observations of the analyzed audio window (native analysis, the
   * compute server's audio-backed analysis, or the mobile app's measured upload).
   */
  captureMetrics?: import("./capture").MeasuredCaptureMetrics;
  /** Capture-quality gate of the run; reports without it predate the gate. */
  captureQuality?: import("./capture").RunCaptureQuality;
  /**
   * Silero speech/non-speech evidence of the capture (desktop only). Absent when the run had no
   * acoustic VAD; see `latestVoiceActivity` for the newest run that has it.
   */
  voiceActivity?: import("./voiceActivity").VoiceActivityEvidence;
  /**
   * Native analysis only: observations that events cite, plus explicit missing channels.
   * Absent from the shared fallback and older reports, which do not produce typed evidence.
   */
  observations?: SpeechObservation[];
  /**
   * Which outputs the producing analyzer supports (see `ANALYSIS_CAPABILITIES`). Absent from
   * reports that predate it; their capabilities are unknown, not full.
   */
  capabilities?: import("./analysisCapabilities").AnalysisCapabilities;
  /**
   * Detections withheld for insufficient evidence ("possible – not enough evidence"). They are
   * not events: every count, rate and trend leaves them out. Absent when there are none and in
   * reports that predate it.
   */
  insufficientEvidence?: PossibleEvent[];
};

/** Why a detection was withheld: `audioOnly` means only the audio supports it. */
export type InsufficientEvidenceReason = "audioOnly";

/** A withheld detection and the candidate it was withheld from, with that candidate's evidence. */
export type PossibleEvent = {
  reason: InsufficientEvidenceReason;
  candidate: StutterEvent;
};

/**
 * Sound repetitions found in the audio alone are withheld: on SEP-28k, repeated onset bursts
 * fire on fluent speech about as often as on sound repetitions
 * (`docs/benchmarks/sep28k-sound-repetition.md`).
 */
export function isAudioOnlySoundRepetition(eventItem: StutterEvent): boolean {
  return eventItem.kind === "soundRepetition" && eventItem.source === "acoustic";
}

export type SpeechStats = {
  speakingDurationSeconds: number;
  pauseDurationSeconds: number;
  wordsPerMinute: number;
  articulationRateWpm: number;
  meanChunkWords: number;
  meanChunkDurationSeconds: number;
  eventDensityPer100Words: number;
  fluencyPercentage: number;
};

export type BlockerStats = {
  blockCount: number;
  totalBlockSeconds: number;
  averageBlockSeconds: number;
  longestBlockSeconds: number;
  blocksPerMinute: number;
  blockedTimePercentage: number;
};

export type ChunkAnalysis = {
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  text: string;
  wordCount: number;
  stutterCount: number;
  blockCount: number;
  fillerCount: number;
  wordsPerMinute: number;
  silentPauseSeconds: number;
  averageConfidence?: number | null;
};

export type AnalyzeSpeechRequest = {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
};

export type Voiceprint = {
  embedding: number[];
  sampleRate: number;
  sampleCount: number;
};

export type SpeakerProfile = {
  id: string;
  label: string;
  embeddings: number[][];
  sampleRate: number;
  sampleCount: number;
};

export type SpeakerMatch = {
  speakerId: string;
  label: string;
  score: number;
};

export type SpeakerIdentification = {
  bestMatch?: SpeakerMatch | null;
  matches: SpeakerMatch[];
  isMatch: boolean;
};

export type TranscriptionEngineId = "browser" | "whisperCpp" | "whisperCli" | "fasterWhisper";

/**
 * Where the whisper.cpp engine may run: "auto" uses the GPU (native-whisperx on CUDA) when one
 * is usable and falls back to the CPU; "cpu" never tries the GPU.
 */
export type TranscriptionDevicePreference = "auto" | "cpu";

/** The backend and device that produced a transcript (whisper.cpp engine only). */
export type TranscriptCompute = {
  backend: "nativeWhisperx" | "whisperCpp";
  device: "cuda" | "cpu";
  /** Why the GPU was not used although it was allowed. */
  gpuUnavailableReason?: string;
};

export const COMPUTE_BACKEND_LABELS: Record<TranscriptCompute["backend"], string> = {
  nativeWhisperx: "native-whisperx",
  whisperCpp: "whisper.cpp",
};

/** "native-whisperx on CUDA", or "whisper.cpp on CPU". */
export function describeCompute(compute: TranscriptCompute) {
  return `${COMPUTE_BACKEND_LABELS[compute.backend]} on ${compute.device === "cuda" ? "CUDA" : "CPU"}`;
}

export type TranscriptionSettings = {
  engine: TranscriptionEngineId;
  model: string;
  device: TranscriptionDevicePreference;
};

export type TranscriptionEngine = {
  id: TranscriptionEngineId;
  label: string;
  mode: string;
  nativeOnly: boolean;
  models: string[];
};

export type TranscriptionModelStatus = {
  id: string;
  label: string;
  cached: boolean;
  downloadable: boolean;
  /**
   * "unknown" when the status could not be checked (for example, the compute server is
   * unreachable); `cached`/`downloadable` are then placeholders, not facts.
   */
  availability?: "unknown";
  /** Outcome of the last failed preparation (download) of a model that is not cached. */
  preparation?: ModelPreparationFailure;
};

export type ModelPreparationFailure = "canceled" | "interrupted" | "failed";

/** Classifies a failed model download by its error text; never treats it as prepared. */
export function modelPreparationFailure(error: unknown): ModelPreparationFailure {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/cancel|abort/.test(text)) {
    return "canceled";
  }
  if (/network|connection|reset|interrupt|timed? ?out|offline|incomplete|partial|eof/.test(text)) {
    return "interrupted";
  }
  return "failed";
}

/** Model statuses whose availability could not be checked. */
export function uncheckedModelStatuses(engine: TranscriptionEngineId): TranscriptionModelStatus[] {
  return staticModelStatuses(engine).map((model) =>
    engine === "browser" ? model : { ...model, availability: "unknown" as const },
  );
}

/** The transcription engine and model that produced a transcript. */
export type TranscriptionModelIdentity = {
  engine: TranscriptionEngineId;
  model: string;
};

export type TranscriptionProgressEvent = {
  phase: string;
  message: string;
  model?: string;
  progress?: number;
};

/** Saved sessions use the canonical record; `LegacySessionRecord` is only a migration input. */
export type SavedSession = import("./sessions").SessionRecord;

export type TranscribeAudioRequest = {
  samples: number[];
  sampleRate: number;
  provider: TranscriptionEngineId;
  model: string;
  language?: string;
  /** Defaults to "auto". */
  device?: TranscriptionDevicePreference;
};

export type TranscribeAudioResult = {
  text?: string | null;
  language?: string | null;
  segments: TranscriptSegment[];
  provider: TranscriptionEngineId;
  model: string;
  /** whisper.cpp engine only: the backend and device that ran it. */
  compute?: TranscriptCompute;
  /**
   * File transcription only: audio-analysis capture observations of the decoded upload, measured
   * as native analysis measures its audio. Absent when the server could not measure the file.
   */
  captureMetrics?: import("./capture").MeasuredCaptureMetrics;
};

export const TRANSCRIPTION_ENGINES: TranscriptionEngine[] = [
  {
    id: "browser",
    label: "Browser Speech",
    mode: "Live",
    nativeOnly: false,
    models: ["default"],
  },
  {
    id: "whisperCpp",
    label: "whisper.cpp",
    mode: "Chunked",
    nativeOnly: true,
    models: [
      "tiny.en",
      "tiny",
      "base.en",
      "base",
      "small.en",
      "small",
      "medium.en",
      "medium",
      "large-v3",
      "large-v3-turbo",
    ],
  },
  {
    id: "whisperCli",
    label: "Whisper CLI",
    mode: "Chunked",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large", "turbo"],
  },
  {
    id: "fasterWhisper",
    label: "Faster-Whisper",
    mode: "Chunked",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large-v3", "distil-large-v3"],
  },
];

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

/**
 * Reduced analysis shared by the browser and the compute server. Its report names its producer's
 * capabilities, so it is never read as the native evidence-carrying analysis.
 */
export function fallbackAnalyze(
  request: AnalyzeSpeechRequest,
  producer: "onDevice" | "computeServer" = "onDevice",
): AnalysisReport {
  const transcriptEvents: StutterEvent[] = [];
  let wordCount = 0;
  let duration = 0;
  for (const segment of request.segments.filter((item) => item.isFinal)) {
    const words = segment.text.split(/\s+/).filter(Boolean);
    wordCount += words.filter((word) => !isFiller(normalize(word))).length;
    duration = Math.max(duration, segment.endSeconds);
    const step = Math.max(
      0.1,
      (segment.endSeconds - segment.startSeconds) / Math.max(1, words.length),
    );
    for (let index = 0; index < words.length; index += 1) {
      const word = normalize(words[index]);
      const next = normalize(words[index + 1] ?? "");
      const start = segment.startSeconds + step * index;
      if (word && word === next && !isFiller(word)) {
        transcriptEvents.push(
          event(
            "wordRepetition",
            start,
            start + step * 2,
            `${words[index]} ${words[index + 1]}`,
            "Repeated word sequence",
            0.78,
          ),
        );
      }
      // An unaligned segment has no timing to place a prolongation in; none is invented.
      if (longestRun(word) >= 4 && segment.alignment !== "unaligned") {
        transcriptEvents.push(
          event("prolongation", start, start + step, words[index], "Extended sound in word", 0.74),
        );
      }
      if (isFiller(word)) {
        transcriptEvents.push(
          event("filler", start, start + step, words[index], "Filler or restart marker", 0.58),
        );
      }
    }
  }
  for (const pause of request.pauses) {
    duration = Math.max(duration, pause.endSeconds);
    if (pause.endSeconds - pause.startSeconds >= 0.75) {
      transcriptEvents.push(
        event(
          "block",
          pause.startSeconds,
          pause.endSeconds,
          pause.afterText ?? "pause",
          `${(pause.endSeconds - pause.startSeconds).toFixed(1)}s silent pause before speech`,
          0.62,
        ),
      );
    }
  }
  const acoustic = analyzeAcoustics(request);
  if (acoustic) {
    duration = Math.max(duration, acoustic.stats.analyzedDurationSeconds);
  }
  const fused = fuseEvents(transcriptEvents, acoustic?.events ?? []);
  fused.sort((left, right) => left.startSeconds - right.startSeconds);
  const events = fused.filter((item) => !isAudioOnlySoundRepetition(item));
  const insufficientEvidence = fused
    .filter(isAudioOnlySoundRepetition)
    .map((candidate): PossibleEvent => ({ reason: "audioOnly", candidate }));
  const minutes = Math.max(duration / 60, 1 / 60);
  const rate = events.length / minutes;
  const density = wordCount ? events.length / wordCount : 0;
  const finalSegments = request.segments.filter((item) => item.isFinal);
  const speakingDurationSeconds = finalSegments.reduce(
    (sum, segment) => sum + Math.max(0, segment.endSeconds - segment.startSeconds),
    0,
  );
  return {
    sessionStartedAt: request.sessionStartedAt,
    totalDurationSeconds: duration,
    wordCount,
    stutterCount: events.length,
    stuttersPerMinute: rate,
    severity:
      events.length === 0
        ? "none"
        : rate >= 12 || density >= 0.18
          ? "high"
          : rate >= 6 || density >= 0.1
            ? "moderate"
            : "mild",
    speechStats: buildSpeechStats(
      duration,
      speakingDurationSeconds,
      request.pauses,
      wordCount,
      events.length,
      finalSegments.length,
    ),
    blockerStats: buildBlockerStats(events, duration),
    chunks: buildChunkAnalysis(finalSegments, request.pauses, events),
    events,
    byKind: events.reduce<Partial<Record<StutterKind, number>>>((acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    }, {}),
    acousticStats: acoustic?.stats,
    capabilities: ANALYSIS_CAPABILITIES[producer],
    ...(insufficientEvidence.length > 0 ? { insufficientEvidence } : {}),
  };
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

function buildSpeechStats(
  totalDurationSeconds: number,
  speakingDurationSeconds: number,
  pauses: PauseSpan[],
  wordCount: number,
  stutterCount: number,
  chunkCount: number,
): SpeechStats {
  const pauseDurationSeconds = pauses.reduce(
    (sum, pause) => sum + Math.max(0, pause.endSeconds - pause.startSeconds),
    0,
  );
  const minutes = Math.max(totalDurationSeconds / 60, 1 / 60);
  const speakingMinutes = Math.max(speakingDurationSeconds / 60, 1 / 60);
  const eventDensityPer100Words = wordCount ? (stutterCount / wordCount) * 100 : 0;
  return {
    speakingDurationSeconds,
    pauseDurationSeconds,
    wordsPerMinute: wordCount / minutes,
    articulationRateWpm: wordCount / speakingMinutes,
    meanChunkWords: chunkCount ? wordCount / chunkCount : 0,
    meanChunkDurationSeconds: chunkCount ? speakingDurationSeconds / chunkCount : 0,
    eventDensityPer100Words,
    fluencyPercentage: wordCount ? Math.max(0, Math.min(100, 100 - eventDensityPer100Words)) : 100,
  };
}

function buildBlockerStats(events: StutterEvent[], totalDurationSeconds: number): BlockerStats {
  const blockDurations = events
    .filter((event) => event.kind === "block")
    .map((event) => Math.max(0, event.endSeconds - event.startSeconds));
  const totalBlockSeconds = blockDurations.reduce((sum, value) => sum + value, 0);
  const minutes = Math.max(totalDurationSeconds / 60, 1 / 60);
  return {
    blockCount: blockDurations.length,
    totalBlockSeconds,
    averageBlockSeconds: blockDurations.length ? totalBlockSeconds / blockDurations.length : 0,
    longestBlockSeconds: Math.max(0, ...blockDurations),
    blocksPerMinute: blockDurations.length / minutes,
    blockedTimePercentage: totalDurationSeconds
      ? (totalBlockSeconds / totalDurationSeconds) * 100
      : 0,
  };
}

function buildChunkAnalysis(
  segments: TranscriptSegment[],
  pauses: PauseSpan[],
  events: StutterEvent[],
): ChunkAnalysis[] {
  return segments.map((segment, index) => {
    const words = segment.text.split(/\s+/).filter(Boolean);
    const wordCount = words.filter((word) => !isFiller(normalize(word))).length;
    const durationSeconds = Math.max(0, segment.endSeconds - segment.startSeconds);
    const chunkEvents = events.filter((eventItem) => eventAppliesToSegment(eventItem, segment));
    return {
      index,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      durationSeconds,
      text: segment.text,
      wordCount,
      stutterCount: chunkEvents.length,
      blockCount: chunkEvents.filter((eventItem) => eventItem.kind === "block").length,
      fillerCount: chunkEvents.filter((eventItem) => eventItem.kind === "filler").length,
      wordsPerMinute: wordCount / Math.max(durationSeconds / 60, 1 / 60),
      silentPauseSeconds: pauses.reduce(
        (sum, pause) =>
          sum +
          Math.max(
            0,
            Math.min(pause.endSeconds, segment.endSeconds) -
              Math.max(pause.startSeconds, segment.startSeconds),
          ),
        0,
      ),
      averageConfidence: meanFinite([segment.confidence, segment.speakerScore]),
    };
  });
}

function eventAppliesToSegment(eventItem: StutterEvent, segment: TranscriptSegment) {
  return (
    overlaps(
      eventItem.startSeconds,
      eventItem.endSeconds,
      segment.startSeconds,
      segment.endSeconds,
    ) ||
    (eventItem.kind === "block" &&
      eventItem.endSeconds <= segment.startSeconds &&
      segment.startSeconds - eventItem.endSeconds <= 1)
  );
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function meanFinite(values: Array<number | undefined>) {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

type AcousticFrame = {
  startSeconds: number;
  endSeconds: number;
  rms: number;
  zcr: number;
};

type AcousticOnset = {
  timestampSeconds: number;
  strength: number;
};

type AcousticAnalysis = {
  stats: AcousticStats;
  events: StutterEvent[];
  frames: AcousticFrame[];
  speechSpans: Array<{ startSeconds: number; endSeconds: number; score: number }>;
  onsets: AcousticOnset[];
};

function analyzeAcoustics(request: AnalyzeSpeechRequest): AcousticAnalysis | null {
  if (!request.samples && request.sampleRate == null) {
    return null;
  }
  if (!request.samples || request.sampleRate == null) {
    throw new Error("samples and sampleRate must be provided together");
  }
  if (!Number.isFinite(request.sampleRate) || request.sampleRate <= 0) {
    throw new Error("sampleRate must be greater than zero");
  }
  if (request.samples.length < request.sampleRate / 4) {
    throw new Error("at least 250ms of audio samples are required");
  }
  if (request.samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error("audio samples must be finite");
  }

  const targetSampleRate = 16_000;
  const samples = resampleSamples(
    request.samples.map((sample) => Math.max(-1, Math.min(1, sample))),
    request.sampleRate,
    targetSampleRate,
  ).slice(0, targetSampleRate * 90);
  const frameSamples = Math.max(1, Math.round(targetSampleRate * 0.03));
  const hopSamples = Math.max(1, Math.round(targetSampleRate * 0.01));
  const frames = frameAudio(samples, targetSampleRate, frameSamples, hopSamples);
  if (!frames.length) {
    return null;
  }

  const rmsValues = frames.map((frame) => frame.rms);
  const noiseFloorRms = percentile(rmsValues, 0.2);
  const meanRms = rmsValues.reduce((sum, value) => sum + value, 0) / rmsValues.length;
  const speechThreshold = Math.min(
    Math.max(noiseFloorRms * 3, 0.01),
    Math.max(meanRms * 0.8, 0.01),
  );
  const silenceThreshold = Math.max(noiseFloorRms * 1.5, 0.006);
  const speechSpans = detectSpeechSpans(frames, speechThreshold, 0.08, 0.08);
  const onsets = detectAcousticOnsets(frames);
  const events = [
    ...detectAcousticBlocks(frames, speechSpans, onsets, request, silenceThreshold),
    ...detectAcousticProlongations(frames, speechSpans, onsets, request),
    ...detectAcousticRepetitions(frames, onsets, request),
  ];
  addFillerEvidence(events, request, frames, speechThreshold);

  const speechDurationSeconds = speechSpans.reduce(
    (sum, span) => sum + Math.max(0, span.endSeconds - span.startSeconds),
    0,
  );
  const analyzedDurationSeconds = samples.length / targetSampleRate;
  const stats: AcousticStats = {
    analyzedDurationSeconds,
    speechDurationSeconds,
    silenceDurationSeconds: Math.max(0, analyzedDurationSeconds - speechDurationSeconds),
    voiceActivityRatio: analyzedDurationSeconds
      ? speechDurationSeconds / analyzedDurationSeconds
      : 0,
    onsetCount: onsets.length,
    meanOnsetRate: analyzedDurationSeconds ? onsets.length / analyzedDurationSeconds : 0,
    meanRms,
    noiseFloorRms,
  };
  return { stats, events, frames, speechSpans, onsets };
}

function frameAudio(
  samples: number[],
  sampleRate: number,
  frameSamples: number,
  hopSamples: number,
): AcousticFrame[] {
  const frames: AcousticFrame[] = [];
  for (let start = 0; start < samples.length; start += hopSamples) {
    const end = Math.min(samples.length, start + frameSamples);
    const frame = samples.slice(start, end);
    if (!frame.length) {
      continue;
    }
    const rmsValue = Math.sqrt(
      frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length,
    );
    let crossings = 0;
    for (let index = 1; index < frame.length; index += 1) {
      if (frame[index - 1] >= 0 !== frame[index] >= 0) {
        crossings += 1;
      }
    }
    frames.push({
      startSeconds: start / sampleRate,
      endSeconds: end / sampleRate,
      rms: rmsValue,
      zcr: crossings / Math.max(1, frame.length - 1),
    });
    if (end === samples.length) {
      break;
    }
  }
  return frames;
}

function detectSpeechSpans(
  frames: AcousticFrame[],
  threshold: number,
  minSpeechSeconds: number,
  mergeGapSeconds: number,
) {
  const spans: Array<{ startSeconds: number; endSeconds: number; score: number }> = [];
  let active: { startSeconds: number; endSeconds: number; score: number; count: number } | null =
    null;
  for (const frame of frames) {
    if (frame.rms >= threshold) {
      if (!active) {
        active = {
          startSeconds: frame.startSeconds,
          endSeconds: frame.endSeconds,
          score: frame.rms,
          count: 1,
        };
      } else {
        active.endSeconds = frame.endSeconds;
        active.score += frame.rms;
        active.count += 1;
      }
    } else if (active) {
      spans.push({
        startSeconds: active.startSeconds,
        endSeconds: active.endSeconds,
        score: active.score / active.count,
      });
      active = null;
    }
  }
  if (active) {
    spans.push({
      startSeconds: active.startSeconds,
      endSeconds: active.endSeconds,
      score: active.score / active.count,
    });
  }

  const merged: typeof spans = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.startSeconds - last.endSeconds <= mergeGapSeconds) {
      const firstDuration = last.endSeconds - last.startSeconds;
      const secondDuration = span.endSeconds - span.startSeconds;
      last.endSeconds = span.endSeconds;
      last.score =
        (last.score * firstDuration + span.score * secondDuration) /
        Math.max(0.001, firstDuration + secondDuration);
    } else {
      merged.push({ ...span });
    }
  }
  return merged.filter((span) => span.endSeconds - span.startSeconds >= minSpeechSeconds);
}

function detectAcousticOnsets(frames: AcousticFrame[]): AcousticOnset[] {
  const strengths = frames.map((frame, index) =>
    Math.max(0, frame.rms - (frames[index - 1]?.rms ?? frame.rms)),
  );
  const threshold = Math.max(0.03, median(strengths) + 1.5 * mad(strengths));
  const onsets: AcousticOnset[] = [];
  for (let index = 1; index + 1 < frames.length; index += 1) {
    const strength = strengths[index];
    if (
      strength < threshold ||
      strength < strengths[index - 1] ||
      strength < strengths[index + 1]
    ) {
      continue;
    }
    const timestampSeconds = frames[index].startSeconds;
    if (onsets.at(-1) && timestampSeconds - onsets[onsets.length - 1].timestampSeconds < 0.07) {
      continue;
    }
    onsets.push({ timestampSeconds, strength });
  }
  return onsets;
}

function detectAcousticBlocks(
  frames: AcousticFrame[],
  speechSpans: Array<{ startSeconds: number; endSeconds: number; score: number }>,
  onsets: AcousticOnset[],
  request: AnalyzeSpeechRequest,
  silenceThreshold: number,
): StutterEvent[] {
  const events: StutterEvent[] = [];
  for (let index = 0; index + 1 < speechSpans.length; index += 1) {
    const left = speechSpans[index];
    const right = speechSpans[index + 1];
    const duration = right.startSeconds - left.endSeconds;
    if (duration < 0.5 || duration > 1.25) {
      continue;
    }
    const gapFrames = frames.filter(
      (frame) => frame.startSeconds >= left.endSeconds && frame.endSeconds <= right.startSeconds,
    );
    if (gapFrames.some((frame) => frame.rms > silenceThreshold)) {
      continue;
    }
    const hasPause = request.pauses.some(
      (pause) =>
        overlapSeconds(pause.startSeconds, pause.endSeconds, left.endSeconds, right.startSeconds) >=
        0.1,
    );
    const followedByOnset = onsets.some(
      (onset) =>
        onset.timestampSeconds >= right.startSeconds &&
        onset.timestampSeconds <= right.startSeconds + 0.18,
    );
    let confidence = 0.62 + (followedByOnset ? 0.1 : 0) + (hasPause ? 0.1 : 0);
    confidence = Math.min(0.95, confidence);
    events.push(
      event(
        "block",
        left.endSeconds,
        right.startSeconds,
        nearestTextAfter(request.segments, right.startSeconds) ?? "pause",
        `${duration.toFixed(1)}s acoustic silent block before speech`,
        confidence,
        "acoustic",
        {
          silenceSeconds: duration,
          onsetCount: followedByOnset ? 1 : 0,
          energyRms: mean(gapFrames.map((frame) => frame.rms)),
          zeroCrossingRate: mean(gapFrames.map((frame) => frame.zcr)),
        },
      ),
    );
  }
  return events;
}

function detectAcousticProlongations(
  frames: AcousticFrame[],
  speechSpans: Array<{ startSeconds: number; endSeconds: number; score: number }>,
  onsets: AcousticOnset[],
  request: AnalyzeSpeechRequest,
): StutterEvent[] {
  const events: StutterEvent[] = [];
  for (const span of speechSpans) {
    const duration = span.endSeconds - span.startSeconds;
    if (duration < 0.45) {
      continue;
    }
    const spanOnsets = onsets.filter(
      (onset) =>
        onset.timestampSeconds >= span.startSeconds && onset.timestampSeconds <= span.endSeconds,
    );
    if (spanOnsets.length > 1) {
      continue;
    }
    const spanFrames = frames.filter(
      (frame) => frame.startSeconds >= span.startSeconds && frame.endSeconds <= span.endSeconds,
    );
    const zcrStability = 1 - Math.min(1, stddev(spanFrames.map((frame) => frame.zcr)) * 20);
    const transcriptSupport = request.segments
      .filter(
        (segment) =>
          segment.isFinal &&
          overlaps(span.startSeconds, span.endSeconds, segment.startSeconds, segment.endSeconds),
      )
      .some((segment) => /\p{L}*(\p{L})\1{3,}\p{L}*|(?:\p{L}-){2,}\p{L}/u.test(segment.text));
    let confidence =
      0.6 +
      (duration >= 0.7 ? 0.15 : 0) +
      (zcrStability >= 0.55 ? 0.1 : 0) +
      (transcriptSupport ? 0.1 : 0);
    confidence = Math.min(0.95, confidence);
    events.push(
      event(
        "prolongation",
        span.startSeconds,
        span.endSeconds,
        nearestTextAt(request.segments, span.startSeconds, span.endSeconds) ?? "voiced stretch",
        `${duration.toFixed(1)}s stable voiced stretch`,
        confidence,
        "acoustic",
        {
          energyRms: span.score,
          onsetCount: spanOnsets.length,
          onsetRate: spanOnsets.length / Math.max(0.001, duration),
          pitchMeanHz: null,
          pitchStability: zcrStability,
          zeroCrossingRate: mean(spanFrames.map((frame) => frame.zcr)),
        },
      ),
    );
  }
  return events;
}

function detectAcousticRepetitions(
  frames: AcousticFrame[],
  onsets: AcousticOnset[],
  request: AnalyzeSpeechRequest,
): StutterEvent[] {
  const events: StutterEvent[] = [];
  let index = 0;
  while (index < onsets.length) {
    let end = index + 1;
    while (
      end < onsets.length &&
      onsets[end].timestampSeconds - onsets[end - 1].timestampSeconds >= 0.08 &&
      onsets[end].timestampSeconds - onsets[end - 1].timestampSeconds <= 0.35 &&
      end - index < 5
    ) {
      end += 1;
    }
    const cluster = onsets.slice(index, end);
    if (cluster.length >= 2) {
      const startSeconds = Math.max(0, cluster[0].timestampSeconds - 0.04);
      const endSeconds = cluster[cluster.length - 1].timestampSeconds + 0.12;
      const duration = endSeconds - startSeconds;
      const intervals = cluster
        .slice(1)
        .map(
          (onset, clusterIndex) => onset.timestampSeconds - cluster[clusterIndex].timestampSeconds,
        );
      const regular = stddev(intervals) <= 0.08;
      const supportedByTranscript = request.segments.some(
        (segment) =>
          segment.isFinal &&
          overlaps(startSeconds, endSeconds, segment.startSeconds, segment.endSeconds) &&
          hasRepeatedTranscriptToken(segment.text),
      );
      let confidence = 0.58 + (supportedByTranscript ? 0.15 : 0) + (regular ? 0.1 : 0);
      if (mean(cluster.map((onset) => onset.strength)) >= 0.08) {
        confidence += 0.1;
      }
      events.push(
        event(
          supportedByTranscript ? "wordRepetition" : "soundRepetition",
          startSeconds,
          endSeconds,
          nearestTextAt(request.segments, startSeconds, endSeconds) ?? "repeated bursts",
          `${cluster.length} repeated onset bursts`,
          Math.min(0.95, confidence),
          "acoustic",
          {
            onsetCount: cluster.length,
            onsetRate: cluster.length / Math.max(0.001, duration),
            energyRms: mean(
              frames
                .filter((frame) =>
                  overlaps(frame.startSeconds, frame.endSeconds, startSeconds, endSeconds),
                )
                .map((frame) => frame.rms),
            ),
          },
        ),
      );
      index = end;
    } else {
      index += 1;
    }
  }
  return events;
}

function addFillerEvidence(
  acousticEvents: StutterEvent[],
  request: AnalyzeSpeechRequest,
  frames: AcousticFrame[],
  speechThreshold: number,
) {
  for (const segment of request.segments.filter((item) => item.isFinal)) {
    const words = segment.text.split(/\s+/).filter(Boolean);
    const step = Math.max(
      0.1,
      (segment.endSeconds - segment.startSeconds) / Math.max(1, words.length),
    );
    words.forEach((word, index) => {
      if (!isFiller(normalize(word))) {
        return;
      }
      const startSeconds = segment.startSeconds + step * index;
      const endSeconds = startSeconds + step;
      const overlapFrames = frames.filter((frame) =>
        overlaps(frame.startSeconds, frame.endSeconds, startSeconds, endSeconds),
      );
      const voiced = overlapFrames.some((frame) => frame.rms >= speechThreshold);
      if (voiced) {
        acousticEvents.push(
          event(
            "filler",
            startSeconds,
            endSeconds,
            word,
            "Voiced filler evidence",
            0.56,
            "acoustic",
            {
              energyRms: mean(overlapFrames.map((frame) => frame.rms)),
              zeroCrossingRate: mean(overlapFrames.map((frame) => frame.zcr)),
            },
          ),
        );
      }
    });
  }
}

function fuseEvents(transcriptEvents: StutterEvent[], acousticEvents: StutterEvent[]) {
  const usedAcoustic = new Set<number>();
  const fused: StutterEvent[] = transcriptEvents.map((textEvent) => {
    const acousticIndex = acousticEvents.findIndex(
      (candidate, index) =>
        !usedAcoustic.has(index) &&
        candidate.kind === textEvent.kind &&
        overlapSeconds(
          candidate.startSeconds,
          candidate.endSeconds,
          textEvent.startSeconds,
          textEvent.endSeconds,
        ) >= 0.1,
    );
    if (acousticIndex < 0) {
      return { ...textEvent, source: textEvent.source ?? "transcript" };
    }
    usedAcoustic.add(acousticIndex);
    const acoustic = acousticEvents[acousticIndex];
    return {
      ...textEvent,
      startSeconds: Math.min(textEvent.startSeconds, acoustic.startSeconds),
      endSeconds: Math.max(textEvent.endSeconds, acoustic.endSeconds),
      detail: `${textEvent.detail}; ${acoustic.detail}`,
      confidence: Math.min(0.98, Math.max(textEvent.confidence, acoustic.confidence) + 0.08),
      source: "fused" as const,
      acousticEvidence: acoustic.acousticEvidence,
    };
  });

  for (const [index, acoustic] of acousticEvents.entries()) {
    if (usedAcoustic.has(index) || !passesAcousticThreshold(acoustic)) {
      continue;
    }
    fused.push(acoustic);
  }

  fused.sort((left, right) => left.startSeconds - right.startSeconds);
  return fused.filter((item, index, list) => {
    const previous = list[index - 1];
    return !(
      previous &&
      previous.kind === item.kind &&
      Math.abs(previous.startSeconds - item.startSeconds) < 0.08 &&
      previous.text === item.text
    );
  });
}

function passesAcousticThreshold(eventItem: StutterEvent) {
  if (eventItem.kind === "soundRepetition") {
    return eventItem.confidence >= 0.68;
  }
  if (eventItem.kind === "block" || eventItem.kind === "prolongation") {
    return eventItem.confidence >= 0.6;
  }
  return eventItem.confidence >= 0.55;
}

function nearestTextAfter(segments: TranscriptSegment[], seconds: number) {
  return segments
    .filter((segment) => segment.isFinal && segment.startSeconds >= seconds)
    .sort((left, right) => left.startSeconds - right.startSeconds)[0]?.text;
}

function nearestTextAt(segments: TranscriptSegment[], startSeconds: number, endSeconds: number) {
  return segments.find(
    (segment) =>
      segment.isFinal &&
      overlaps(startSeconds, endSeconds, segment.startSeconds, segment.endSeconds),
  )?.text;
}

function hasRepeatedTranscriptToken(text: string) {
  const words = text.split(/\s+/).map(normalize).filter(Boolean);
  return words.some((word, index) => index > 0 && word === words[index - 1]);
}

function overlapSeconds(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function percentile(values: number[], quantile: number) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * sorted.length)));
  return sorted[index];
}

function median(values: number[]) {
  return percentile(values, 0.5);
}

function mad(values: number[]) {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values: number[]) {
  if (values.length < 2) {
    return 0;
  }
  const center = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - center) ** 2)));
}

export function fallbackEmbedding(samples: number[]) {
  const bands = 20;
  const values = Array.from({ length: bands }, () => 0);
  const stride = Math.max(1, Math.floor(samples.length / bands));
  for (let index = 0; index < bands; index += 1) {
    const chunk = samples.slice(index * stride, (index + 1) * stride);
    values[index] = Math.sqrt(
      chunk.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, chunk.length),
    );
  }
  const norm = Math.hypot(...values) || 1;
  return values.map((value) => value / norm);
}

export function cosine(left: number[], right: number[]) {
  const size = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < size; index += 1) {
    sum += left[index] * right[index];
  }
  return sum;
}

export function resampleSamples(samples: number[], sampleRate: number, targetSampleRate: number) {
  if (sampleRate === targetSampleRate) {
    return samples;
  }
  const resultLength = Math.max(1, Math.round((samples.length * targetSampleRate) / sampleRate));
  const result = Array.from({ length: resultLength }, () => 0);
  const ratio = sampleRate / targetSampleRate;
  for (let index = 0; index < resultLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourceIndex - left;
    result[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return result;
}

export function staticModelStatuses(engine: TranscriptionEngineId): TranscriptionModelStatus[] {
  return getTranscriptionEngine(engine).models.map((model) => ({
    id: model,
    label: model,
    cached: engine === "browser",
    downloadable: false,
  }));
}

export function getTranscriptionEngine(id: TranscriptionEngineId) {
  return TRANSCRIPTION_ENGINES.find((engine) => engine.id === id) ?? TRANSCRIPTION_ENGINES[0];
}

function event(
  kind: StutterKind,
  startSeconds: number,
  endSeconds: number,
  text: string,
  detail: string,
  confidence: number,
  source: StutterEvent["source"] = "transcript",
  acousticEvidence?: AcousticEvidence,
): StutterEvent {
  return { kind, startSeconds, endSeconds, text, detail, confidence, source, acousticEvidence };
}

function normalize(value: string) {
  return value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

function isFiller(value: string) {
  return ["um", "uh", "erm", "hm", "hmm", "like", "äh", "ähm", "eh"].includes(value);
}

function longestRun(value: string) {
  let previous = "";
  let current = 0;
  let longest = 0;
  for (const char of value) {
    current = char === previous ? current + 1 : 1;
    previous = char;
    longest = Math.max(longest, current);
  }
  return longest;
}
export * from "./analysisCapabilities";
export * from "./capture";
export * from "./outcomes";
export * from "./sessions";
export * from "./annotations";
export * from "./validation";
export * from "./annotationExchange";
export * from "./comparison";
export * from "./transcriptText";
export * from "./transcriptRevisions";
export * from "./consent";
export * from "./evidenceExport";
export * from "./voiceActivity";
