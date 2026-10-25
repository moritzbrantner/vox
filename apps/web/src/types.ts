import type { SessionRecord } from "@stutter-tracker/shared";

export type TranscriptSegment = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  confidence?: number;
  speakerId?: string;
  speakerLabel?: string;
  speakerScore?: number;
  isFinal: boolean;
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
};

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
  /** Native analysis only: audio-analysis capture observations of the analyzed audio window. */
  captureMetrics?: import("@stutter-tracker/shared").MeasuredCaptureMetrics;
  /** Capture-quality gate of the run; reports without it predate the gate. */
  captureQuality?: import("@stutter-tracker/shared").RunCaptureQuality;
  /**
   * Detections withheld for insufficient evidence. Not events: shown only in the analysis
   * details and left out of every count, rate and trend.
   */
  insufficientEvidence?: PossibleEvent[];
};

export type PossibleEvent = {
  reason: import("@stutter-tracker/shared").InsufficientEvidenceReason;
  /** The withheld candidate; `evidence` cites the report's observations (native analysis). */
  candidate: StutterEvent & { evidence?: import("@stutter-tracker/shared").EventEvidence };
};

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

export type TranscriptionSettings = {
  engine: TranscriptionEngineId;
  model: string;
};

export type TranscriptionEngine = {
  id: TranscriptionEngineId;
  label: string;
  mode: string;
  nativeOnly: boolean;
  models: string[];
};

export type TranscriptionModelStatus = import("@stutter-tracker/shared").TranscriptionModelStatus;

export type TranscriptionProgressEvent = {
  phase: string;
  message: string;
  model?: string;
  progress?: number;
};

export type TranscriptionChunkStats = {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  lastMessage: string;
};

export type TranscriptionChunkStatus = "queued" | "processing" | "completed" | "failed";

export type TranscriptionChunkRecord = {
  id: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  status: TranscriptionChunkStatus;
  transcript: string;
  segmentCount: number;
  error?: string;
};

export type TranscriptionChunkSummary = Record<TranscriptionChunkStatus, number> & {
  total: number;
};

/** Saved sessions use the canonical product record shared with the other apps. */
export type SavedSession = SessionRecord;

export type IntentPredictionReason =
  | "currentContext"
  | "block"
  | "filler"
  | "repetition"
  | "prolongation";

export type IntentWordPrediction = {
  token: string;
  count: number;
  probability: number;
  phrase: string;
};

export type SpeakerIntentPrediction = {
  id: string;
  reason: IntentPredictionReason;
  contextText: string;
  triggerText?: string | null;
  startSeconds?: number | null;
  endSeconds?: number | null;
  speakerId?: string | null;
  speakerLabel?: string | null;
  confidence: number;
  suggestions: IntentWordPrediction[];
};

export type SpeechCorpusAnalysis = {
  stats: SpeechCorpusStats;
  text: CorpusTextStats;
  readability: CorpusReadability;
  sentiment: CorpusSentiment;
  linguistic: CorpusLinguisticSummary;
  topTerms: CorpusTerm[];
  keywords: CorpusKeyword[];
  summary: string[];
  speakers: SpeakerCorpusSummary[];
};

export type SpeechCorpusStats = {
  sessions: number;
  documents: number;
  speakers: number;
  totalDurationSeconds: number;
  totalTerms: number;
  uniqueTerms: number;
  averageTermsPerDocument: number;
  wordCount: number;
  stutterCount: number;
  stuttersPerMinute: number;
  lexicalDiversity: number;
  /** Sessions whose capture quality is unknown; left out of the event totals. */
  withheldSessions: number;
};

export type CorpusTextStats = {
  bytes: number;
  chars: number;
  words: number;
  lines: number;
  sentences: number;
  uniqueTerms: number;
};

export type CorpusReadability = {
  sentenceCount: number;
  wordCount: number;
  averageSentenceWords: number;
  averageWordChars: number;
};

export type CorpusSentiment = {
  positiveScore: number;
  negativeScore: number;
  compound: number;
  tokenCount: number;
  matchedTerms: number;
  label: string;
};

export type CorpusLinguisticSummary = {
  language?: string | null;
  languageConfidence?: number | null;
  tokenCount: number;
  sentenceCount: number;
  lemmaCount: number;
  entityCount: number;
  entities: string[];
  topics: string[];
  register: string;
  disfluencyMarkers: number;
  questionCount: number;
  exclamationCount: number;
};

export type CorpusTerm = {
  term: string;
  collectionCount: number;
  documentCount: number;
  collectionFrequency: number;
};

export type CorpusKeyword = {
  text: string;
  score: number;
  count: number;
};

export type SpeakerCorpusSummary = {
  speakerId?: string | null;
  speakerLabel: string;
  documents: number;
  wordCount: number;
  durationSeconds: number;
  stutterCount: number;
  lexicalDiversity: number;
  topTerms: CorpusTerm[];
  keywords: CorpusKeyword[];
};
