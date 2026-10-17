// Two-rater validation: how far two independent human raters agree, measured rather than
// assumed. Disagreements are reported as records; adjudication resolves them in a separate
// revision and never edits either rater's revision.
import type { AnnotatedEvent, AnnotationRevision, SessionRecord } from "./sessions";
import { currentAnnotations, isDisfluencyLabel, sameRater } from "./sessions";

/** Spans of the same label match when they overlap or their onsets are this close. */
export const DEFAULT_ONSET_TOLERANCE_SECONDS = 0.25;
/** Frame length of the time-based agreement (any disfluency present or not). */
export const AGREEMENT_FRAME_SECONDS = 0.01;

export type SpanDisagreement =
  | { kind: "labelMismatch"; first: AnnotatedEvent; second: AnnotatedEvent }
  | { kind: "onlyFirst"; first: AnnotatedEvent }
  | { kind: "onlySecond"; second: AnnotatedEvent };

export type RaterComparison = {
  matches: Array<{ first: AnnotatedEvent; second: AnnotatedEvent }>;
  disagreements: SpanDisagreement[];
  /** Disfluency events each rater marked. */
  eventCounts: [number, number];
  /** 2 × matched disfluency events / all disfluency events; null when neither marked any. */
  positiveAgreement: number | null;
  /** Cohen's kappa over 10 ms frames for "a disfluency is present"; null when undefined. */
  frameKappa: number | null;
  onsetToleranceSeconds: number;
};

export function compareRaters(
  first: AnnotatedEvent[],
  second: AnnotatedEvent[],
  { onsetToleranceSeconds = DEFAULT_ONSET_TOLERANCE_SECONDS, durationSeconds = 0 } = {},
): RaterComparison {
  const pairs: Array<{ i: number; j: number; score: number; same: boolean }> = [];
  first.forEach((a, i) =>
    second.forEach((b, j) => {
      const overlap =
        Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds);
      const close = Math.abs(a.startSeconds - b.startSeconds) <= onsetToleranceSeconds;
      if (overlap > 0 || close) {
        pairs.push({
          i,
          j,
          score: Math.max(0, overlap) + (close ? 1e-6 : 0),
          same: a.kind === b.kind,
        });
      }
    }),
  );
  // Same-label pairs first, then the largest overlap; each span is used once.
  pairs.sort(
    (x, y) => Number(y.same) - Number(x.same) || y.score - x.score || x.i - y.i || x.j - y.j,
  );
  const usedFirst = new Set<number>();
  const usedSecond = new Set<number>();
  const matches: RaterComparison["matches"] = [];
  const disagreements: SpanDisagreement[] = [];
  for (const pair of pairs) {
    if (usedFirst.has(pair.i) || usedSecond.has(pair.j)) continue;
    usedFirst.add(pair.i);
    usedSecond.add(pair.j);
    if (pair.same) matches.push({ first: first[pair.i], second: second[pair.j] });
    else
      disagreements.push({ kind: "labelMismatch", first: first[pair.i], second: second[pair.j] });
  }
  first.forEach((a, i) => usedFirst.has(i) || disagreements.push({ kind: "onlyFirst", first: a }));
  second.forEach(
    (b, j) => usedSecond.has(j) || disagreements.push({ kind: "onlySecond", second: b }),
  );
  matches.sort((x, y) => x.first.startSeconds - y.first.startSeconds);
  disagreements.sort((x, y) => onset(x) - onset(y));

  const eventCounts: [number, number] = [
    first.filter((event) => isDisfluencyLabel(event.kind)).length,
    second.filter((event) => isDisfluencyLabel(event.kind)).length,
  ];
  const matchedEvents = matches.filter((match) => isDisfluencyLabel(match.first.kind)).length;
  const total = eventCounts[0] + eventCounts[1];
  return {
    matches,
    disagreements,
    eventCounts,
    positiveAgreement: total === 0 ? null : round((2 * matchedEvents) / total),
    frameKappa: frameKappa(first, second, durationSeconds),
    onsetToleranceSeconds,
  };
}

export type SessionValidation = {
  sessionId: string;
  declaredAt: string;
  /** Each declared rater's current revision marked as their reference, if saved. */
  ratings: [AnnotationRevision | null, AnnotationRevision | null];
  /** Whether each rating was made in blind review. */
  blind: [boolean | null, boolean | null];
  adjudication: AnnotationRevision | null;
  comparison: RaterComparison | null;
};

export function sessionValidation(record: SessionRecord): SessionValidation | null {
  const declared = record.validation;
  if (!declared) return null;
  const current = currentAnnotations(record);
  const ratings = declared.raters.map(
    (rater) =>
      current
        .filter((revision) => sameRater(revision.author, rater) && revision.status === "accepted")
        .at(-1) ?? null,
  ) as [AnnotationRevision | null, AnnotationRevision | null];
  const adjudication =
    current.filter((revision) => revision.adjudicates && revision.status === "accepted").at(-1) ??
    null;
  return {
    sessionId: record.id,
    declaredAt: declared.declaredAt,
    ratings,
    blind: ratings.map((rating) => (rating ? rating.basedOnRunId === null : null)) as [
      boolean | null,
      boolean | null,
    ],
    adjudication,
    comparison:
      ratings[0] && ratings[1]
        ? compareRaters(ratings[0].events, ratings[1].events, {
            durationSeconds: record.report.totalDurationSeconds,
          })
        : null,
  };
}

export type ValidationReport = {
  declared: number;
  bothRated: number;
  adjudicated: number;
  /** Pooled over sessions rated by both: 2 × matched events / all events. */
  positiveAgreement: number | null;
  /** Mean frame kappa over sessions where it is defined. */
  meanFrameKappa: number | null;
  disagreementCount: number;
  sessions: SessionValidation[];
};

export function validationReport(records: SessionRecord[]): ValidationReport {
  const sessions = records.flatMap((record) => sessionValidation(record) ?? []);
  const compared = sessions.flatMap((session) => session.comparison ?? []);
  const events = compared.reduce((sum, item) => sum + item.eventCounts[0] + item.eventCounts[1], 0);
  const matched = compared.reduce(
    (sum, item) => sum + item.matches.filter((match) => isDisfluencyLabel(match.first.kind)).length,
    0,
  );
  const kappas = compared.flatMap((item) => (item.frameKappa === null ? [] : [item.frameKappa]));
  return {
    declared: sessions.length,
    bothRated: compared.length,
    adjudicated: sessions.filter((session) => session.adjudication).length,
    positiveAgreement: events === 0 ? null : round((2 * matched) / events),
    meanFrameKappa: kappas.length ? round(kappas.reduce((a, b) => a + b, 0) / kappas.length) : null,
    disagreementCount: compared.reduce((sum, item) => sum + item.disagreements.length, 0),
    sessions,
  };
}

/** Starting point for an adjudication: agreed spans once, then every disputed span of both. */
export function adjudicationStart(comparison: RaterComparison): AnnotatedEvent[] {
  return [
    ...comparison.matches.map((match) => match.first),
    ...comparison.disagreements.flatMap((item) =>
      item.kind === "labelMismatch"
        ? [item.first, item.second]
        : item.kind === "onlyFirst"
          ? [item.first]
          : [item.second],
    ),
  ];
}

function frameKappa(first: AnnotatedEvent[], second: AnnotatedEvent[], durationSeconds: number) {
  const end = Math.max(
    durationSeconds,
    ...first.map((event) => event.endSeconds),
    ...second.map((event) => event.endSeconds),
  );
  const frames = Math.round(end / AGREEMENT_FRAME_SECONDS);
  if (frames <= 0) return null;
  const a = presence(first, frames);
  const b = presence(second, frames);
  let both = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    if (a[frame] && b[frame]) both += 1;
    else if (a[frame]) onlyA += 1;
    else if (b[frame]) onlyB += 1;
  }
  const neither = frames - both - onlyA - onlyB;
  const observed = (both + neither) / frames;
  const pa = (both + onlyA) / frames;
  const pb = (both + onlyB) / frames;
  const expected = pa * pb + (1 - pa) * (1 - pb);
  return expected === 1 ? null : round((observed - expected) / (1 - expected));
}

function presence(events: AnnotatedEvent[], frames: number) {
  const marked = new Uint8Array(frames);
  for (const event of events) {
    if (!isDisfluencyLabel(event.kind)) continue;
    const from = Math.max(0, Math.round(event.startSeconds / AGREEMENT_FRAME_SECONDS));
    const to = Math.min(
      frames,
      Math.max(from + 1, Math.round(event.endSeconds / AGREEMENT_FRAME_SECONDS)),
    );
    marked.fill(1, from, to);
  }
  return marked;
}

function onset(item: SpanDisagreement) {
  return item.kind === "onlySecond" ? item.second.startSeconds : item.first.startSeconds;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
