// Canonical saved-session record: original observations, the analysis that interpreted them and
// every superseded analysis stay distinct. A rerun appends; it never rewrites an earlier result.
import type { RecordingDescriptor } from "./capture";
import type {
  AnalysisReport,
  PauseSpan,
  StutterKind,
  TranscriptionModelIdentity,
  TranscriptSegment,
} from "./index";
import {
  type AssistanceCondition,
  canonicalSpokenLanguage,
  type SpeakingTask,
  type SpokenLanguage,
  UNKNOWN_SPOKEN_LANGUAGE,
} from "./outcomes";
import type { TranscriptRevision, TranscriptRevisionIdentity } from "./transcriptRevisions";

export const SESSION_SCHEMA_VERSION = 2;

/** Bump whenever `fallbackAnalyze` output can change for the same input. */
export const SHARED_ANALYSIS_VERSION = "3";

export type AnalyzerProducer = "onDevice" | "computeServer" | "desktopNative";

export type AnalyzerIdentity = {
  producer: AnalyzerProducer;
  algorithm: string;
  /** null when the producer does not report a version; never guessed. */
  version: string | null;
};

export type AnalysisRunIdentity = {
  id: string;
  /** null for runs migrated from records that never stored a timestamp. */
  createdAt: string | null;
  /** null for runs migrated from records that never stored who produced them. */
  analyzer: AnalyzerIdentity | null;
  /** Fingerprint of the observation the run analyzed (see `observationFingerprint`). */
  inputId: string;
  /** Whether captured audio fed the run; audio is not stored, so such runs cannot be replayed. */
  usedAudio: boolean | null;
  /** Fingerprint of the audio the run analyzed (see `audioFingerprint`); null when none or unknown. */
  audioId: string | null;
  /**
   * The transcription engine and model that produced the analyzed transcript. Absent or null when
   * unknown (older records, or a transcript that no local/server model produced).
   */
  transcription?: TranscriptionModelIdentity | null;
};

export type AnalysisRun = AnalysisRunIdentity & { report: AnalysisReport };

export type SessionContext = {
  /** `UNKNOWN_SPOKEN_LANGUAGE` when not recorded. */
  spokenLanguage: SpokenLanguage;
  task: SpeakingTask | null;
  condition: AssistanceCondition | null;
};

export type SessionRecord = {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string;
  startedAt: string;
  /**
   * The current transcript revision's segments; analysis never rewrites them. A reference
   * re-transcription replaces them through `reviseTranscript`, keeping the earlier revision.
   */
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  context: SessionContext;
  /** Empty for records saved before capture descriptors existed. */
  recordings: RecordingDescriptor[];
  /** Current interpretation, kept at the top level for existing readers (desktop corpus). */
  report: AnalysisReport;
  /** Identity of the run that produced `report`. */
  analysis: AnalysisRunIdentity;
  /** Superseded runs, oldest first. Append-only. */
  priorAnalyses: AnalysisRun[];
  /** Identity and provenance of the current transcript; absent on older sessions. */
  transcript?: TranscriptRevisionIdentity;
  /** Replaced transcript revisions with their segments, oldest first. Append-only. */
  priorTranscripts?: TranscriptRevision[];
  /** Human annotation revisions, oldest first. Append-only; analysis never changes them. */
  annotations: AnnotationRevision[];
  /** Two-rater validation declared for this session before either rater annotated it. */
  validation?: ValidationDeclaration;
  /**
   * Set on a session created from someone else's annotation exchange file: it holds their
   * transcript for review only, has no analysis, and is not part of this user's own speech data.
   */
  reviewCopy?: { exportedAt: string; importedAt: string };
};

export type ValidationDeclaration = {
  declaredAt: string;
  raters: [AnnotationRater, AnnotationRater];
};

export type AnnotatorRole = "self" | "clinician" | "researcher";

export type AnnotationRater = { role: AnnotatorRole; id?: string };

export function sameRater(a: AnnotationRater, b: AnnotationRater) {
  return a.role === b.role && (a.id || null) === (b.id || null);
}

/**
 * Disfluency events plus annotation-only labels for spans that are not disfluencies: no speech,
 * overlapping speakers and audio unusable for judging (see docs/annotation-handbook.md).
 */
export type AnnotationLabel = StutterKind | "noSpeech" | "overlap" | "unusable";

export const NON_EVENT_ANNOTATION_LABELS: readonly AnnotationLabel[] = [
  "noSpeech",
  "overlap",
  "unusable",
];

/** Whether a label marks a disfluency event (counted) rather than a span condition. */
export function isDisfluencyLabel(label: AnnotationLabel): label is StutterKind {
  return !NON_EVENT_ANNOTATION_LABELS.includes(label);
}

export type AnnotatedEvent = {
  kind: AnnotationLabel;
  startSeconds: number;
  endSeconds: number;
  /** "possible" for uncertain labels, e.g. a silent block the audio alone cannot establish. */
  certainty: "certain" | "possible";
  note?: string;
  /**
   * Set by an "uncertain" adjudication of a label disagreement: both raters' labels, rater 1's
   * first. `kind` is the first of them; the label is not settled.
   */
  candidateLabels?: [AnnotationLabel, AnnotationLabel];
};

/** What an adjudicator decided for one referred disagreement (docs/annotation-handbook.md). */
export type AdjudicationOutcome = "first" | "second" | "adjusted" | "noEvent" | "uncertain";

export type AdjudicationDecision = {
  /** The referred item, as `SpanDisagreement.key` names it for the cited ratings. */
  item: string;
  outcome: AdjudicationOutcome;
  /** The adjudicator's own span, only for "adjusted". */
  event?: AnnotatedEvent;
};

export type AdjudicationRecord = {
  /** The adjudicator's own statement of their qualification, e.g. "SLT, stuttering specialist". */
  qualification: string;
  /** Agreement rule that decided which items were accepted automatically and which referred. */
  rule: string;
  /** One decision per referred item; automatically accepted agreements need none. */
  decisions: AdjudicationDecision[];
};

export type AnnotationRevision = {
  id: string;
  createdAt: string;
  author: AnnotationRater;
  /** Analysis run shown while annotating; null when annotated without one (blind). */
  basedOnRunId: string | null;
  /** Fingerprint of the observation the annotation describes. */
  inputId: string;
  events: AnnotatedEvent[];
  status: "draft" | "accepted";
  /** Earlier revision this one replaces; the earlier one stays in the history. */
  supersedes: string | null;
  /**
   * For an adjudication: the two declared raters' revisions it resolves. The adjudicator is
   * neither rater, and the rater revisions stay unchanged.
   */
  adjudicates?: [string, string];
  /** Per-item decisions of a selective adjudication; absent on adjudications saved before 0.3. */
  adjudication?: AdjudicationRecord;
};

/** Version-1 records: what the web app stored before this schema. */
export type LegacySessionRecord = {
  id: string;
  startedAt: string;
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  report: AnalysisReport;
};

/** `inputId` of a run whose analyzed input is not known (e.g. saved before analysis finished). */
export const UNKNOWN_INPUT_ID = "unknown";

export const UNKNOWN_SESSION_CONTEXT: SessionContext = {
  spokenLanguage: UNKNOWN_SPOKEN_LANGUAGE,
  task: null,
  condition: null,
};

export function createSessionRecord(input: {
  id: string;
  startedAt: string;
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  report: AnalysisReport;
  /**
   * Pass `inputId` when the report was computed from an earlier observation (e.g. a save while a
   * re-analysis is still running); a mismatch with the saved observation then stays visible.
   */
  run: Omit<AnalysisRunIdentity, "inputId"> & { inputId?: string };
  context?: SessionContext;
  recordings?: RecordingDescriptor[];
  /** Identity and provenance of the transcript being saved. */
  transcript?: TranscriptRevisionIdentity;
}): SessionRecord {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: input.id,
    startedAt: input.startedAt,
    segments: input.segments,
    pauses: input.pauses,
    context: input.context ?? UNKNOWN_SESSION_CONTEXT,
    recordings: input.recordings ?? [],
    report: input.report,
    analysis: {
      ...input.run,
      inputId: input.run.inputId ?? observationFingerprint(input.segments, input.pauses),
    },
    priorAnalyses: [],
    annotations: [],
    ...(input.transcript ? { transcript: input.transcript } : {}),
  };
}

/**
 * Lifts a version-1 record into the current schema. Missing provenance stays visibly unknown
 * (null analyzer/timestamp, unknown language); nothing is inferred.
 */
export function migrateSessionRecord(record: LegacySessionRecord | SessionRecord): SessionRecord {
  if ("schemaVersion" in record) {
    if (record.schemaVersion !== SESSION_SCHEMA_VERSION) {
      throw new Error(`Unsupported session schema version ${String(record.schemaVersion)}.`);
    }
    // Version-2 records saved before annotations existed have none.
    return record.annotations ? record : { ...record, annotations: [] };
  }
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: record.id,
    startedAt: record.startedAt,
    segments: record.segments,
    pauses: record.pauses,
    context: UNKNOWN_SESSION_CONTEXT,
    recordings: [],
    report: record.report,
    analysis: {
      id: `${record.id}:legacy`,
      createdAt: null,
      analyzer: null,
      // Legacy records never stored which observation produced their report.
      inputId: UNKNOWN_INPUT_ID,
      usedAudio: null,
      audioId: null,
    },
    priorAnalyses: [],
    annotations: [],
  };
}

/**
 * Records a new analysis of the stored observation. The previous current run moves to
 * `priorAnalyses`; observations and earlier runs are untouched.
 */
export function reanalyzeSession(
  record: SessionRecord,
  run: Omit<AnalysisRunIdentity, "inputId">,
  report: AnalysisReport,
): SessionRecord {
  if (run.id === record.analysis.id || record.priorAnalyses.some((prior) => prior.id === run.id)) {
    throw new Error(`Analysis run ${run.id} is already recorded for session ${record.id}.`);
  }
  // Audio is not kept, so a rerun cannot remeasure the capture; its quality still describes it.
  const inherited = report.captureQuality ? undefined : record.report.captureQuality;
  return {
    ...record,
    report: inherited ? { ...report, captureQuality: inherited } : report,
    analysis: { ...run, inputId: observationFingerprint(record.segments, record.pauses) },
    priorAnalyses: [...record.priorAnalyses, { ...record.analysis, report: record.report }],
  };
}

/**
 * Records a human annotation revision. Earlier revisions are kept; a revision may replace one
 * earlier revision of the same rater (`supersedes`). Analysis runs never change annotations.
 */
export function annotateSession(
  record: SessionRecord,
  revision: Omit<AnnotationRevision, "inputId">,
): SessionRecord {
  if (!revision.id || !Number.isFinite(Date.parse(revision.createdAt))) {
    throw new Error("Annotation revisions need a non-empty id and a valid createdAt timestamp.");
  }
  if (record.annotations.some((existing) => existing.id === revision.id)) {
    throw new Error(`Annotation revision ${revision.id} is already recorded.`);
  }
  if (revision.supersedes !== null) {
    const replaced = record.annotations.find((existing) => existing.id === revision.supersedes);
    if (!replaced) {
      throw new Error(`Annotation revision ${revision.supersedes} does not exist.`);
    }
    // A rater replaces only their own revision; another rater's draft stays current.
    if (!sameRater(replaced.author, revision.author)) {
      throw new Error(`Annotation revision ${revision.supersedes} belongs to another rater.`);
    }
    // An adjudication is revised only by another adjudication, never by a plain annotation.
    if (replaced.adjudicates && !revision.adjudicates) {
      throw new Error("Revise an adjudication in two-rater validation, not as an annotation.");
    }
  }
  if (revision.adjudicates) {
    const raters = record.validation?.raters;
    if (!raters) {
      throw new Error(`Session ${record.id} has no declared two-rater validation.`);
    }
    if (raters.some((rater) => sameRater(rater, revision.author))) {
      throw new Error("A rater cannot adjudicate their own validation.");
    }
    if (revision.author.role !== "clinician" || !revision.author.id?.trim()) {
      throw new Error("An adjudicator is a named person in the Clinician role.");
    }
    if (!revision.adjudication?.qualification.trim()) {
      throw new Error("An adjudication needs the adjudicator's qualification statement.");
    }
    revision.adjudicates.forEach((id, index) => {
      const rated = record.annotations.find((existing) => existing.id === id);
      if (!rated || !sameRater(rated.author, raters[index])) {
        throw new Error(
          `Annotation revision ${id} is not a revision of declared rater ${index + 1}.`,
        );
      }
    });
  }
  if (revision.adjudication && !revision.adjudicates) {
    throw new Error("Adjudication decisions need the two ratings they resolve.");
  }
  const runIds = sessionAnalysisRuns(record).map((run) => run.id);
  if (revision.basedOnRunId !== null && !runIds.includes(revision.basedOnRunId)) {
    throw new Error(`Analysis run ${revision.basedOnRunId} is not part of session ${record.id}.`);
  }
  for (const event of revision.events) {
    if (
      !Number.isFinite(event.startSeconds) ||
      !Number.isFinite(event.endSeconds) ||
      event.endSeconds < event.startSeconds
    ) {
      throw new Error("Annotated events need finite times with end >= start.");
    }
  }
  return {
    ...record,
    annotations: [
      ...record.annotations,
      { ...revision, inputId: observationFingerprint(record.segments, record.pauses) },
    ],
  };
}

/**
 * Declares two-rater validation for a session. It must be declared before either rater has
 * annotated it, so the subset is chosen independently of the annotations.
 */
export function declareValidation(
  record: SessionRecord,
  declaration: ValidationDeclaration,
): SessionRecord {
  if (record.validation) {
    throw new Error(`Session ${record.id} already has a declared validation.`);
  }
  if (!Number.isFinite(Date.parse(declaration.declaredAt))) {
    throw new Error("A validation declaration needs a valid declaredAt timestamp.");
  }
  const [first, second] = declaration.raters;
  if (sameRater(first, second)) {
    throw new Error("Validation needs two different raters.");
  }
  if (
    record.annotations.some((revision) =>
      declaration.raters.some((rater) => sameRater(rater, revision.author)),
    )
  ) {
    throw new Error("A declared rater has already annotated this session.");
  }
  return { ...record, validation: { declaredAt: declaration.declaredAt, raters: [first, second] } };
}

/**
 * Records the speaking task and assistance condition of a saved session, and its spoken language
 * when none was recorded. A recorded language is never changed: analysis runs were bound to it.
 * The observation, analyses and annotations are untouched.
 */
export function tagSessionContext(
  record: SessionRecord,
  tags: {
    task: SpeakingTask | null;
    condition: AssistanceCondition | null;
    spokenLanguage?: SpokenLanguage;
  },
): SessionRecord {
  let spokenLanguage = record.context.spokenLanguage;
  if (tags.spokenLanguage !== undefined) {
    const declared = canonicalSpokenLanguage(tags.spokenLanguage);
    if (declared !== spokenLanguage) {
      if (canonicalSpokenLanguage(spokenLanguage) !== UNKNOWN_SPOKEN_LANGUAGE) {
        throw new Error("A recorded spoken language cannot be changed.");
      }
      spokenLanguage = declared;
    }
  }
  if (tags.condition?.kind === "assisted" && !tags.condition.aidId.trim()) {
    throw new Error("An assisted condition needs the aid that was used.");
  }
  return { ...record, context: { spokenLanguage, task: tags.task, condition: tags.condition } };
}

/** Revisions not replaced by a later one, oldest first. */
export function currentAnnotations(record: SessionRecord): AnnotationRevision[] {
  const superseded = new Set(record.annotations.map((revision) => revision.supersedes));
  return record.annotations.filter((revision) => !superseded.has(revision.id));
}

/** The current accepted human reference: the latest adjudication, else the latest accepted revision. */
export function acceptedAnnotation(record: SessionRecord): AnnotationRevision | null {
  const accepted = currentAnnotations(record).filter((revision) => revision.status === "accepted");
  // An adjudication resolves the validation raters' disagreements, so it is the reference.
  return accepted.filter((revision) => revision.adjudicates).at(-1) ?? accepted.at(-1) ?? null;
}

export type AnalysisSource = "automated" | "humanReference";

/**
 * Identifies the analyzer behind the current report; "unknown" when it or its version was never
 * recorded (an unreported version could hide an upgrade, so it is not one shared version).
 */
export function analyzerKey(record: SessionRecord): string {
  const analyzer = record.analysis.analyzer;
  return analyzer && analyzer.version !== null
    ? `${analyzer.producer}:${analyzer.algorithm}:${analyzer.version}`
    : "unknown";
}

/** True when the current report is known to be the analysis of exactly the saved observation. */
export function isAnalysisVerified(record: SessionRecord): boolean {
  return record.analysis.inputId === observationFingerprint(record.segments, record.pauses);
}

/** Saved transcript evidence a reanalysis can replay (audio is not stored with sessions). */
export function isReplayable(record: SessionRecord): boolean {
  return record.segments.length > 0 || record.pauses.length > 0;
}

/** Whether an accepted human annotation exists to compare against, or only automated analysis. */
export function analysisSource(record: SessionRecord): AnalysisSource {
  return acceptedAnnotation(record) ? "humanReference" : "automated";
}

/** Every run, oldest first, ending with the current one. */
export function sessionAnalysisRuns(record: SessionRecord): AnalysisRun[] {
  return [...record.priorAnalyses, { ...record.analysis, report: record.report }];
}

/**
 * Deterministic identity of the stored observation: every segment and pause field an analyzer
 * can read. Equal fingerprints mean runs analyzed the same transcript evidence.
 */
export function observationFingerprint(segments: TranscriptSegment[], pauses: PauseSpan[]) {
  const canonical = JSON.stringify([
    segments.map((segment) => [
      segment.text,
      segment.startSeconds,
      segment.endSeconds,
      segment.isFinal,
      segment.confidence ?? null,
      segment.speakerId ?? null,
      segment.speakerLabel ?? null,
      segment.speakerScore ?? null,
      // Only when set, so fingerprints of segments saved before alignment existed are unchanged.
      ...(segment.alignment ? [segment.alignment] : []),
    ]),
    pauses.map((pause) => [pause.startSeconds, pause.endSeconds, pause.afterText ?? null]),
  ]);
  return `obs-${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x050c5d1f)}`;
}

/** Deterministic identity of analyzed PCM: sample rate plus the exact float32 sample bits. */
export function audioFingerprint(samples: ArrayLike<number>, sampleRate: number) {
  // Reuse float32 input directly; anything else is converted once.
  const floats = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  const bits = new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
  let low = Math.imul(0x811c9dc5 ^ sampleRate, 0x01000193) >>> 0;
  let high = Math.imul(0x050c5d1f ^ bits.length, 0x01000193) >>> 0;
  for (let index = 0; index < bits.length; index += 1) {
    low = Math.imul(low ^ bits[index], 0x01000193) >>> 0;
    high = Math.imul(high ^ (bits[index] >>> 7), 0x01000193) >>> 0;
  }
  return `pcm-${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`;
}

function fnv1a(text: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
