// Annotation exchange file: lets a rater on another device annotate a session and send the
// revisions back. It carries the transcript, annotation revisions, the validation declaration and,
// only when the user selects it for that session, the audio kept with it. It never carries
// analysis results, assistance conditions, dates or voiceprints (owner decisions on vox#23:
// clinician-sharing consent only; audio only by explicit per-session selection; fixed rights).
import type { CaptureInterval } from "./capture";
import type { AnalysisReport, PauseSpan, TranscriptSegment } from "./index";
import {
  type AnnotatedEvent,
  type AnnotationRater,
  type AnnotationRevision,
  createSessionRecord,
  isDisfluencyLabel,
  observationFingerprint,
  sameRater,
  type SessionRecord,
  sessionAnalysisRuns,
  UNKNOWN_INPUT_ID,
  type ValidationDeclaration,
} from "./sessions";

export const ANNOTATION_EXCHANGE_FORMAT = "vox-annotation-exchange";
export const ANNOTATION_EXCHANGE_VERSION = 1;

/** Fixed permitted use of every exchange file (owner decision on vox#23). */
export const ANNOTATION_EXCHANGE_RIGHTS = {
  statement:
    "Shared by the person recorded for annotation review only. Do not redistribute. Not for model training.",
  permittedUses: ["review"],
  redistribution: false,
  modelTraining: false,
} as const;

export type ExchangeAudio = {
  sampleRate: number;
  startOffsetSeconds: number;
  discontinuities: CaptureInterval[];
  droppedSeconds: number;
  audioId: string;
  /** Little-endian float32 samples, base64. */
  samples: string;
};

export type AnnotationExchange = {
  format: typeof ANNOTATION_EXCHANGE_FORMAT;
  version: typeof ANNOTATION_EXCHANGE_VERSION;
  exportedAt: string;
  rights: typeof ANNOTATION_EXCHANGE_RIGHTS;
  consent: { purpose: "clinicianSharing"; grantedAt: string };
  session: {
    id: string;
    /** Fingerprint of `segments` and `pauses`; equal on both devices for the same transcript. */
    inputId: string;
    segments: TranscriptSegment[];
    pauses: PauseSpan[];
  };
  validation: ValidationDeclaration | null;
  revisions: AnnotationRevision[];
  audio: ExchangeAudio | null;
};

export function buildAnnotationExchange(
  record: SessionRecord,
  options: { exportedAt: Date; consentGrantedAt: string; audio?: ExchangeAudio | null },
): AnnotationExchange {
  return {
    format: ANNOTATION_EXCHANGE_FORMAT,
    version: ANNOTATION_EXCHANGE_VERSION,
    exportedAt: options.exportedAt.toISOString(),
    rights: ANNOTATION_EXCHANGE_RIGHTS,
    consent: { purpose: "clinicianSharing", grantedAt: options.consentGrantedAt },
    session: {
      id: record.id,
      inputId: observationFingerprint(record.segments, record.pauses),
      segments: record.segments,
      pauses: record.pauses,
    },
    validation: record.validation ?? null,
    revisions: record.annotations,
    audio: options.audio ?? null,
  };
}

/** Validates an untrusted exchange file; throws with the first problem found. */
export function parseAnnotationExchange(value: unknown): AnnotationExchange {
  const file = object(value, "The file");
  if (file.format !== ANNOTATION_EXCHANGE_FORMAT)
    throw new Error("This is not an annotation exchange file.");
  if (file.version !== ANNOTATION_EXCHANGE_VERSION) {
    throw new Error(`Unsupported annotation exchange version ${String(file.version)}.`);
  }
  timestamp(file.exportedAt, "exportedAt");
  if (JSON.stringify(file.rights) !== JSON.stringify(ANNOTATION_EXCHANGE_RIGHTS)) {
    throw new Error("The file's permitted-use statement is not the one this app issues.");
  }
  const consent = object(file.consent, "consent");
  if (consent.purpose !== "clinicianSharing")
    throw new Error("The file was not shared under clinician-sharing consent.");
  timestamp(consent.grantedAt, "consent.grantedAt");

  const session = object(file.session, "session");
  text(session.id, "session.id");
  const segments = array(session.segments, "session.segments").map(segment);
  const pauses = array(session.pauses, "session.pauses").map(pause);
  if (session.inputId !== observationFingerprint(segments, pauses)) {
    throw new Error("The file's transcript does not match its fingerprint.");
  }
  const validation = file.validation === null ? null : declaration(file.validation);
  const revisions = array(file.revisions, "revisions").map(revision);
  const audio = file.audio === null ? null : exchangeAudio(file.audio);
  return {
    format: ANNOTATION_EXCHANGE_FORMAT,
    version: ANNOTATION_EXCHANGE_VERSION,
    exportedAt: file.exportedAt as string,
    rights: ANNOTATION_EXCHANGE_RIGHTS,
    consent: { purpose: "clinicianSharing", grantedAt: consent.grantedAt as string },
    session: { id: session.id as string, inputId: session.inputId as string, segments, pauses },
    validation,
    revisions,
    audio,
  };
}

/** A session for reviewing someone else's transcript: no analysis, marked as a review copy. */
export function reviewCopyFromExchange(
  exchange: AnnotationExchange,
  { importedAt, emptyReport }: { importedAt: Date; emptyReport: AnalysisReport },
): SessionRecord {
  return {
    ...createSessionRecord({
      id: exchange.session.id,
      // The origin's date is not shared; the copy is dated by its import.
      startedAt: importedAt.toISOString(),
      segments: exchange.session.segments,
      pauses: exchange.session.pauses,
      report: emptyReport,
      run: {
        id: `${exchange.session.id}:review-copy`,
        createdAt: null,
        analyzer: null,
        usedAudio: null,
        audioId: null,
        inputId: UNKNOWN_INPUT_ID,
      },
    }),
    reviewCopy: { exportedAt: exchange.exportedAt, importedAt: importedAt.toISOString() },
  };
}

/**
 * Adds the file's validation declaration and revisions this session does not have yet. Nothing
 * local is changed or removed; a revision with a known id must be identical. Throws (changing
 * nothing) when the file describes a different transcript or conflicts with local records.
 */
export function mergeAnnotationExchange(
  record: SessionRecord,
  exchange: AnnotationExchange,
): { record: SessionRecord; added: number; alreadyPresent: number } {
  if (record.id !== exchange.session.id) throw new Error("The file is for another session.");
  if (observationFingerprint(record.segments, record.pauses) !== exchange.session.inputId) {
    throw new Error("The file describes a different version of this session's transcript.");
  }
  let validation = record.validation;
  if (exchange.validation) {
    if (!validation) {
      validation = exchange.validation;
    } else if (JSON.stringify(validation) !== JSON.stringify(exchange.validation)) {
      throw new Error("The file declares different validation raters for this session.");
    }
  }
  const known = new Map(record.annotations.map((item) => [item.id, item]));
  const annotations = [...record.annotations];
  const runIds = new Set(sessionAnalysisRuns(record).map((run) => run.id));
  let alreadyPresent = 0;
  for (const incoming of exchange.revisions) {
    const local = known.get(incoming.id);
    if (local) {
      if (
        JSON.stringify(canonicalRevision(local)) !== JSON.stringify(canonicalRevision(incoming))
      ) {
        throw new Error(`Annotation revision ${incoming.id} differs from the one already here.`);
      }
      alreadyPresent += 1;
      continue;
    }
    // A review copy has none of the origin's analysis runs; the origin knows its own.
    if (
      incoming.basedOnRunId !== null &&
      !record.reviewCopy &&
      !runIds.has(incoming.basedOnRunId)
    ) {
      throw new Error(
        `Annotation revision ${incoming.id} refers to an analysis this session does not have.`,
      );
    }
    if (incoming.supersedes !== null) {
      const replaced = known.get(incoming.supersedes);
      if (!replaced || !sameRater(replaced.author, incoming.author)) {
        throw new Error(
          `Annotation revision ${incoming.id} replaces a revision that is missing or another rater's.`,
        );
      }
    }
    if (incoming.adjudicates) {
      if (!validation || validation.raters.some((rater) => sameRater(rater, incoming.author))) {
        throw new Error(`Adjudication ${incoming.id} has no valid declared validation.`);
      }
      incoming.adjudicates.forEach((id, index) => {
        const rated = known.get(id);
        if (!rated || !sameRater(rated.author, validation!.raters[index])) {
          throw new Error(
            `Adjudication ${incoming.id} cites a revision that is not a declared rating.`,
          );
        }
      });
    }
    known.set(incoming.id, incoming);
    annotations.push(incoming);
  }
  if (validation && !record.validation) {
    // Declared before rating: no declared rater may have annotated this session before the file.
    const declaredAt = Date.parse(validation.declaredAt);
    const earlier = record.annotations.some(
      (item) =>
        validation!.raters.some((rater) => sameRater(rater, item.author)) &&
        Date.parse(item.createdAt) < declaredAt,
    );
    if (earlier)
      throw new Error(
        "A declared rater annotated this session before the validation was declared.",
      );
  }
  return {
    record: {
      ...record,
      ...(validation ? { validation } : {}),
      annotations,
    },
    added: annotations.length - record.annotations.length,
    alreadyPresent,
  };
}

/** Disfluency events in the file's current revisions, for the import/export preview. */
export function exchangeSummary(exchange: AnnotationExchange) {
  const raters: AnnotationRater[] = [];
  for (const item of exchange.revisions) {
    if (!raters.some((rater) => sameRater(rater, item.author))) raters.push(item.author);
  }
  return {
    segments: exchange.session.segments.length,
    revisions: exchange.revisions.length,
    raters,
    events: exchange.revisions.reduce(
      (sum, item) => sum + item.events.filter((event) => isDisfluencyLabel(event.kind)).length,
      0,
    ),
    audioSeconds: exchange.audio
      ? decodedLength(exchange.audio.samples) / exchange.audio.sampleRate
      : null,
  };
}

export function encodeSamples(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true));
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function decodeSamples(encoded: string): Float32Array {
  const binary = atob(encoded);
  if (binary.length % 4 !== 0) throw new Error("The file's audio is not whole float32 samples.");
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1)
    view.setUint8(index, binary.charCodeAt(index));
  const samples = new Float32Array(binary.length / 4);
  for (let index = 0; index < samples.length; index += 1)
    samples[index] = view.getFloat32(index * 4, true);
  return samples;
}

function decodedLength(encoded: string) {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor(((encoded.length * 3) / 4 - padding) / 4);
}

function canonicalRevision(item: AnnotationRevision) {
  return {
    id: item.id,
    createdAt: item.createdAt,
    author: { role: item.author.role, id: item.author.id ?? null },
    basedOnRunId: item.basedOnRunId,
    inputId: item.inputId,
    events: item.events.map((event) => [
      event.kind,
      event.startSeconds,
      event.endSeconds,
      event.certainty,
      event.note ?? null,
    ]),
    status: item.status,
    supersedes: item.supersedes,
    adjudicates: item.adjudicates ?? null,
  };
}

const LABELS = new Set([
  "soundRepetition",
  "wordRepetition",
  "prolongation",
  "block",
  "filler",
  "noSpeech",
  "overlap",
  "unusable",
]);
const ROLES = new Set(["self", "clinician", "researcher"]);
const GAP_REASONS = new Set(["dropout", "interrupted", "routeChange", "paused"]);

function revision(value: unknown): AnnotationRevision {
  const item = object(value, "revision");
  text(item.id, "revision id");
  timestamp(item.createdAt, "revision createdAt");
  text(item.inputId, "revision inputId");
  if (item.basedOnRunId !== null) text(item.basedOnRunId, "revision basedOnRunId");
  if (item.supersedes !== null) text(item.supersedes, "revision supersedes");
  if (item.status !== "draft" && item.status !== "accepted")
    throw new Error("A revision has an unknown status.");
  const adjudicates =
    item.adjudicates === undefined
      ? undefined
      : (array(item.adjudicates, "adjudicates").map((id) => text(id, "adjudicates")) as [
          string,
          string,
        ]);
  if (adjudicates && adjudicates.length !== 2)
    throw new Error("An adjudication must cite two revisions.");
  return {
    id: item.id as string,
    createdAt: item.createdAt as string,
    author: rater(item.author),
    basedOnRunId: item.basedOnRunId as string | null,
    inputId: item.inputId as string,
    events: array(item.events, "events").map(event),
    status: item.status as AnnotationRevision["status"],
    supersedes: item.supersedes as string | null,
    ...(adjudicates ? { adjudicates } : {}),
  };
}

function event(value: unknown): AnnotatedEvent {
  const item = object(value, "event");
  if (!LABELS.has(item.kind as string)) throw new Error("An event has an unknown label.");
  seconds(item.startSeconds, "event start");
  seconds(item.endSeconds, "event end");
  if ((item.endSeconds as number) < (item.startSeconds as number))
    throw new Error("An event ends before it starts.");
  if (item.certainty !== "certain" && item.certainty !== "possible")
    throw new Error("An event has an unknown certainty.");
  if (item.note !== undefined) text(item.note, "event note");
  return {
    kind: item.kind as AnnotatedEvent["kind"],
    startSeconds: item.startSeconds as number,
    endSeconds: item.endSeconds as number,
    certainty: item.certainty as AnnotatedEvent["certainty"],
    ...(item.note !== undefined ? { note: item.note as string } : {}),
  };
}

function rater(value: unknown): AnnotationRater {
  const item = object(value, "author");
  if (!ROLES.has(item.role as string)) throw new Error("An author has an unknown role.");
  if (item.id !== undefined) text(item.id, "author id");
  return item.id !== undefined
    ? { role: item.role as AnnotationRater["role"], id: item.id as string }
    : { role: item.role as AnnotationRater["role"] };
}

function declaration(value: unknown): ValidationDeclaration {
  const item = object(value, "validation");
  timestamp(item.declaredAt, "validation declaredAt");
  const raters = array(item.raters, "validation raters").map(rater);
  if (raters.length !== 2 || sameRater(raters[0], raters[1]))
    throw new Error("A validation needs two different raters.");
  return { declaredAt: item.declaredAt as string, raters: [raters[0], raters[1]] };
}

function segment(value: unknown): TranscriptSegment {
  const item = object(value, "segment");
  if (typeof item.text !== "string") throw new Error("A transcript segment has no text.");
  seconds(item.startSeconds, "segment start");
  seconds(item.endSeconds, "segment end");
  if (typeof item.isFinal !== "boolean")
    throw new Error("A transcript segment has no isFinal flag.");
  // Kept field by field and in order, so the fingerprint matches the sender's.
  const result: TranscriptSegment = {
    text: item.text,
    startSeconds: item.startSeconds as number,
    endSeconds: item.endSeconds as number,
    isFinal: item.isFinal,
  };
  if (item.confidence !== undefined)
    result.confidence = finite(item.confidence, "segment confidence");
  if (item.speakerId !== undefined) result.speakerId = text(item.speakerId, "speakerId");
  if (item.speakerLabel !== undefined)
    result.speakerLabel = text(item.speakerLabel, "speakerLabel");
  if (item.speakerScore !== undefined)
    result.speakerScore = finite(item.speakerScore, "speakerScore");
  return result;
}

function pause(value: unknown): PauseSpan {
  const item = object(value, "pause");
  seconds(item.startSeconds, "pause start");
  seconds(item.endSeconds, "pause end");
  const result: PauseSpan = {
    startSeconds: item.startSeconds as number,
    endSeconds: item.endSeconds as number,
  };
  if (item.afterText !== undefined) result.afterText = text(item.afterText, "pause afterText");
  return result;
}

function exchangeAudio(value: unknown): ExchangeAudio {
  const item = object(value, "audio");
  const sampleRate = finite(item.sampleRate, "audio sampleRate");
  if (sampleRate <= 0) throw new Error("The file's audio has no sample rate.");
  return {
    sampleRate,
    startOffsetSeconds: seconds(item.startOffsetSeconds, "audio startOffsetSeconds"),
    discontinuities: array(item.discontinuities, "audio discontinuities").map((gap) => {
      const entry = object(gap, "audio gap");
      if (!GAP_REASONS.has(entry.reason as string))
        throw new Error("An audio gap has an unknown reason.");
      return {
        startSeconds: seconds(entry.startSeconds, "gap start"),
        endSeconds: seconds(entry.endSeconds, "gap end"),
        reason: entry.reason as CaptureInterval["reason"],
      };
    }),
    droppedSeconds: seconds(item.droppedSeconds, "audio droppedSeconds"),
    audioId: text(item.audioId, "audio audioId"),
    samples: text(item.samples, "audio samples"),
  };
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${what} is not an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list.`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${what} is missing.`);
  return value;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${what} is not a number.`);
  return value;
}

function seconds(value: unknown, what: string): number {
  const number = finite(value, what);
  if (number < 0) throw new Error(`${what} is negative.`);
  return number;
}

function timestamp(value: unknown, what: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error(`${what} is not a timestamp.`);
}
