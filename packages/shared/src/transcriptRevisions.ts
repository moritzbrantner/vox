// Transcript identity and revisions (vox#26).
//
// Live: partial and final results belong to one transcription run and one recognition unit (a
// browser result index or a chunk). A run accepts only its own updates, a unit is finalized once,
// and a late or out-of-order partial never overwrites newer text, so races cannot duplicate or
// resurrect words.
//
// Saved: a session's transcript has revisions. The provisional transcript made while recording
// is the first; a user-started reference re-transcription appends a new current revision and
// keeps every earlier one with its provenance and a word-level reconciliation.
import type { TranscriptionEngineId, TranscriptSegment } from "./index";
import { observationFingerprint, type SessionRecord } from "./sessions";

// ---------------------------------------------------------------------------------------------
// Live partial-to-final identity

export type LiveTranscriptUpdate =
  /** Interim text of a unit; a higher `sequence` is newer. */
  | { kind: "partial"; runId: string; unitId: string; sequence: number; text: string }
  /** The unit's final segments. A unit is finalized at most once. */
  | { kind: "final"; runId: string; unitId: string; segments: TranscriptSegment[] }
  /** Ends the run: nothing more is accepted for it and pending partials are dropped. */
  | { kind: "cancel"; runId: string };

export type LiveTranscript = {
  /** The run this transcript is bound to; updates of any other run are ignored. */
  runId: string;
  canceled: boolean;
  /** Finalized units in the order they were finalized. */
  finals: { unitId: string; segments: TranscriptSegment[] }[];
  /** Latest partial per unit that is not final yet, in first-seen order. */
  partials: { unitId: string; sequence: number; text: string }[];
};

export function startLiveTranscript(runId: string): LiveTranscript {
  return { runId, canceled: false, finals: [], partials: [] };
}

/** Whether `unitId` was already finalized in this run. */
export function isUnitFinal(state: LiveTranscript, unitId: string) {
  return state.finals.some((final) => final.unitId === unitId);
}

/**
 * Applies one update. Returns the same object when the update is ignored: another run's, after
 * cancellation, a partial of a finalized unit or older than the unit's latest partial, or a
 * repeated finalization.
 */
export function applyLiveTranscriptUpdate(
  state: LiveTranscript,
  update: LiveTranscriptUpdate,
): LiveTranscript {
  if (update.runId !== state.runId || state.canceled) {
    return state;
  }
  if (update.kind === "cancel") {
    return { ...state, canceled: true, partials: [] };
  }
  if (isUnitFinal(state, update.unitId)) {
    return state;
  }
  if (update.kind === "partial") {
    const existing = state.partials.find((partial) => partial.unitId === update.unitId);
    if (existing && existing.sequence >= update.sequence) {
      return state;
    }
    const next = { unitId: update.unitId, sequence: update.sequence, text: update.text };
    return {
      ...state,
      partials: existing
        ? state.partials.map((partial) => (partial === existing ? next : partial))
        : [...state.partials, next],
    };
  }
  return {
    ...state,
    finals: [...state.finals, { unitId: update.unitId, segments: update.segments }],
    partials: state.partials.filter((partial) => partial.unitId !== update.unitId),
  };
}

/** Final segments of the run, ordered by start time (finalization order breaks ties). */
export function liveTranscriptSegments(state: LiveTranscript): TranscriptSegment[] {
  return state.finals
    .flatMap((final) => final.segments)
    .map((segment, order) => ({ segment, order }))
    .sort((a, b) => a.segment.startSeconds - b.segment.startSeconds || a.order - b.order)
    .map(({ segment }) => segment);
}

/** Pending interim text of units that are not final yet. */
export function liveTranscriptPartialText(state: LiveTranscript): string {
  return state.partials
    .map((partial) => partial.text.trim())
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------------------------
// Provenance

/** What was done to the audio between capture and the recognizer. */
export type TranscriptPreprocessing = {
  /** Sample rate of the captured audio; null when the recognizer captured its own audio. */
  captureSampleRate: number | null;
  /** Sample rate the model received; null when not known (browser speech). */
  modelSampleRate: number | null;
  /** Seconds per chunk the audio was split into for the model; null when not chunked. */
  chunkSeconds: number | null;
};

/**
 * Known limits of an engine/model/language combination, recorded with the transcript so they are
 * not mistaken for properties of the speech.
 */
export type TranscriptLimitation =
  /** The recognizer reports no timing: every segment is unaligned. */
  | "noTiming"
  /** The browser recognizer captures and processes its own audio; its preprocessing is unknown. */
  | "recognizerAudioUnknown"
  /** An English-only model was used for a language other than English. */
  | "englishOnlyModel"
  /** The model reported a different language than the one selected. */
  | "languageMismatch";

export const TRANSCRIPT_LIMITATION_LABELS: Record<TranscriptLimitation, string> = {
  noTiming: "No timing from the recognizer; segments are not aligned to the audio",
  recognizerAudioUnknown: "The browser recognizer's own audio processing is unknown",
  englishOnlyModel: "English-only model used for another language",
  languageMismatch: "The model detected a different language than selected",
};

export type TranscriptProvenance = {
  engine: TranscriptionEngineId;
  model: string;
  /** Recognition language selected when the run started; later selections never change it. */
  language: string;
  /** Language the model reported, when it reported one. */
  detectedLanguage: string | null;
  preprocessing: TranscriptPreprocessing;
  limitations: TranscriptLimitation[];
};

/** Provenance of a transcription run, with the limitations its combination is known to have. */
export function transcriptProvenance(input: {
  engine: TranscriptionEngineId;
  model: string;
  language: string;
  detectedLanguage?: string | null;
  preprocessing: TranscriptPreprocessing;
}): TranscriptProvenance {
  const limitations: TranscriptLimitation[] = [];
  const selected = baseLanguage(input.language);
  const detected = input.detectedLanguage ? baseLanguage(input.detectedLanguage) : null;
  if (input.engine === "browser") {
    limitations.push("noTiming", "recognizerAudioUnknown");
  }
  if (input.model.endsWith(".en") && selected !== "en") {
    limitations.push("englishOnlyModel");
  }
  if (detected && selected && detected !== selected) {
    limitations.push("languageMismatch");
  }
  return {
    engine: input.engine,
    model: input.model,
    language: input.language,
    detectedLanguage: input.detectedLanguage ?? null,
    preprocessing: input.preprocessing,
    limitations,
  };
}

function baseLanguage(tag: string) {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

/**
 * Marks segments whose timing is unusable (none, non-finite or not increasing) as unaligned. Their
 * times then only order them; they are never shown or used to time events.
 */
export function markUnalignedTiming(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.map((segment) =>
    segment.alignment === "unaligned" ||
    (Number.isFinite(segment.startSeconds) &&
      Number.isFinite(segment.endSeconds) &&
      segment.endSeconds > segment.startSeconds)
      ? segment
      : {
          ...segment,
          startSeconds: Number.isFinite(segment.startSeconds) ? segment.startSeconds : 0,
          endSeconds: Number.isFinite(segment.startSeconds) ? segment.startSeconds : 0,
          alignment: "unaligned" as const,
        },
  );
}

// ---------------------------------------------------------------------------------------------
// whisper.cpp reference models

const WHISPER_CPP_SIZE: Record<string, number> = {
  "tiny.en": 0,
  tiny: 0,
  "base.en": 1,
  base: 1,
  "small.en": 2,
  small: 2,
  "medium.en": 3,
  medium: 3,
  "large-v3-turbo": 4,
  "large-v3": 5,
};

/**
 * whisper.cpp models a post-session reference transcript may use: larger than the provisional
 * whisper.cpp model (any size after another engine), without English-only models for other
 * languages. Smallest first.
 */
export function referenceTranscriptModels(
  provisional: { engine: TranscriptionEngineId; model: string } | null,
  language: string,
): string[] {
  const floor =
    provisional?.engine === "whisperCpp" ? (WHISPER_CPP_SIZE[provisional.model] ?? -1) : -1;
  const english = baseLanguage(language) === "en";
  return Object.entries(WHISPER_CPP_SIZE)
    .filter(([model, size]) => size > floor && (english || !model.endsWith(".en")))
    .sort((a, b) => a[1] - b[1])
    .map(([model]) => model);
}

// ---------------------------------------------------------------------------------------------
// Saved revisions and reconciliation

export type TranscriptRevisionKind = "provisional" | "reference";

export type TranscriptReconciliation = {
  /** The revision these counts compare against (the one this revision replaced). */
  against: string;
  unchangedWords: number;
  substitutedWords: number;
  insertedWords: number;
  deletedWords: number;
};

export type TranscriptRevisionIdentity = {
  id: string;
  /** null for transcripts saved before revisions were recorded. */
  createdAt: string | null;
  kind: TranscriptRevisionKind;
  /** null when not recorded (older sessions, recovered captures). */
  provenance: TranscriptProvenance | null;
  /** The revision this one replaced as current; null for the first. */
  supersedes: string | null;
  /** Word-level comparison with the replaced revision; absent for the first. */
  reconciliation?: TranscriptReconciliation;
};

export type TranscriptRevision = TranscriptRevisionIdentity & { segments: TranscriptSegment[] };

/** Identity of the current transcript; sessions saved before revisions get a provisional one. */
export function currentTranscriptIdentity(record: SessionRecord): TranscriptRevisionIdentity {
  return (
    record.transcript ?? {
      id: `${record.id}:transcript`,
      createdAt: null,
      kind: "provisional",
      provenance: null,
      supersedes: null,
    }
  );
}

/** Every transcript revision, oldest first, ending with the current one. */
export function sessionTranscriptRevisions(record: SessionRecord): TranscriptRevision[] {
  return [
    ...(record.priorTranscripts ?? []),
    { ...currentTranscriptIdentity(record), segments: record.segments },
  ];
}

/**
 * Makes `segments` the session's current transcript. The replaced revision moves to
 * `priorTranscripts` unchanged; analysis runs and annotations stay as they were, bound to the
 * observation they describe, so the current report is unverified until the session is reanalyzed.
 */
export function reviseTranscript(
  record: SessionRecord,
  revision: {
    id: string;
    createdAt: string;
    kind: TranscriptRevisionKind;
    provenance: TranscriptProvenance;
  },
  segments: TranscriptSegment[],
): SessionRecord {
  if (!revision.id || !Number.isFinite(Date.parse(revision.createdAt))) {
    throw new Error("Transcript revisions need a non-empty id and a valid createdAt timestamp.");
  }
  if (sessionTranscriptRevisions(record).some((existing) => existing.id === revision.id)) {
    throw new Error(`Transcript revision ${revision.id} is already recorded.`);
  }
  const current = currentTranscriptIdentity(record);
  const { counts } = reconcileTranscripts(record.segments, segments);
  return {
    ...record,
    segments,
    transcript: {
      ...revision,
      supersedes: current.id,
      reconciliation: { against: current.id, ...counts },
    },
    priorTranscripts: [
      ...(record.priorTranscripts ?? []),
      { ...current, segments: record.segments },
    ],
  };
}

export type TranscriptDiffOperation =
  | { op: "equal"; words: string[] }
  | { op: "replace"; before: string[]; after: string[] }
  | { op: "insert"; words: string[] }
  | { op: "delete"; words: string[] };

/**
 * Word-level alignment of two transcripts (final segments, verbatim words). Words compare
 * case-insensitively without surrounding punctuation, so "Well," and "well" are unchanged.
 */
export function reconcileTranscripts(
  before: TranscriptSegment[],
  after: TranscriptSegment[],
): {
  operations: TranscriptDiffOperation[];
  counts: Omit<TranscriptReconciliation, "against">;
} {
  const a = transcriptWords(before);
  const b = transcriptWords(after);
  const keyA = a.map(wordKey);
  const keyB = b.map(wordKey);
  // Longest common subsequence table, filled from the end.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        keyA[i] === keyB[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const operations: TranscriptDiffOperation[] = [];
  let deleted: string[] = [];
  let inserted: string[] = [];
  const counts = { unchangedWords: 0, substitutedWords: 0, insertedWords: 0, deletedWords: 0 };
  const flush = () => {
    const paired = Math.min(deleted.length, inserted.length);
    if (paired) {
      operations.push({ op: "replace", before: deleted, after: inserted });
      counts.substitutedWords += paired;
    } else if (deleted.length) {
      operations.push({ op: "delete", words: deleted });
    } else if (inserted.length) {
      operations.push({ op: "insert", words: inserted });
    }
    counts.deletedWords += deleted.length - paired;
    counts.insertedWords += inserted.length - paired;
    deleted = [];
    inserted = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && keyA[i] === keyB[j]) {
      flush();
      const last = operations.at(-1);
      if (last?.op === "equal") last.words.push(b[j]);
      else operations.push({ op: "equal", words: [b[j]] });
      counts.unchangedWords += 1;
      i += 1;
      j += 1;
    } else if (
      j < b.length &&
      (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])
    ) {
      inserted.push(b[j]);
      j += 1;
    } else {
      deleted.push(a[i]);
      i += 1;
    }
  }
  flush();
  return { operations, counts };
}

function transcriptWords(segments: TranscriptSegment[]) {
  return segments
    .filter((segment) => segment.isFinal)
    .flatMap((segment) => segment.text.split(/\s+/))
    .filter(Boolean);
}

function wordKey(word: string) {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || word;
}

/**
 * Fingerprints of every transcript revision's observation. Annotations describe the revision that
 * was current when they were made, so each of these is a valid `inputId` for this session.
 */
export function transcriptObservationIds(record: SessionRecord): string[] {
  return sessionTranscriptRevisions(record).map((revision) =>
    observationFingerprint(revision.segments, record.pauses),
  );
}
