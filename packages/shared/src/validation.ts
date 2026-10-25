// Two-rater validation: how far two independent human raters agree, measured rather than
// assumed. Agreement comes first: spans both raters marked alike are accepted automatically, and
// only the remaining disagreements are referred to a third person, who decides each one. Neither
// rater's revision is ever edited.
import { roundAnnotationSeconds } from "./annotations";
import type {
  AdjudicationDecision,
  AnnotatedEvent,
  AnnotationRater,
  AnnotationRevision,
  SessionRecord,
} from "./sessions";
import { currentAnnotations, isDisfluencyLabel, sameRater } from "./sessions";

/**
 * Provisional, not empirically validated (vox#131): two spans agree when label and certainty
 * match and both onset and offset differ by at most this much.
 */
export const BOUNDARY_TOLERANCE_SECONDS = 0.25;
/** Names the agreement rule in each adjudication, so a later rule cannot be confused with it. */
export const AGREEMENT_RULE = "provisional-boundaries-250ms-v1";
/** Frame length of the time-based agreement (any disfluency present or not). */
export const AGREEMENT_FRAME_SECONDS = 0.01;

/** How a paired span of the two raters differs. */
export type SpanDifference = "label" | "certainty" | "boundaries";

/**
 * A referred item. `key` names it by the spans' positions in the two rating revisions
 * ("first/second", "-" for a span only one rater marked), so decisions bind to exact spans.
 */
export type SpanDisagreement =
  | {
      kind: "pair";
      key: string;
      first: AnnotatedEvent;
      second: AnnotatedEvent;
      differences: SpanDifference[];
    }
  | { kind: "onlyFirst"; key: string; first: AnnotatedEvent }
  | { kind: "onlySecond"; key: string; second: AnnotatedEvent };

export type RaterComparison = {
  /** Automatically accepted agreements, with the span they contribute to the reference. */
  matches: Array<{ first: AnnotatedEvent; second: AnnotatedEvent; accepted: AnnotatedEvent }>;
  /** Everything else, each referred to the adjudicator. */
  disagreements: SpanDisagreement[];
  /** Disfluency events each rater marked. */
  eventCounts: [number, number];
  /** 2 × agreed disfluency events / all disfluency events; null when neither marked any. */
  positiveAgreement: number | null;
  /** Cohen's kappa over 10 ms frames for "a disfluency is present"; null when undefined. */
  frameKappa: number | null;
  toleranceSeconds: number;
};

export function compareRaters(
  first: AnnotatedEvent[],
  second: AnnotatedEvent[],
  { toleranceSeconds = BOUNDARY_TOLERANCE_SECONDS, durationSeconds = 0 } = {},
): RaterComparison {
  // Candidate pairs: spans that overlap or start within the tolerance describe the same moment.
  const pairs: Array<{ i: number; j: number; score: number; differences: SpanDifference[] }> = [];
  first.forEach((a, i) =>
    second.forEach((b, j) => {
      const overlap =
        Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds);
      const close = within(a.startSeconds, b.startSeconds, toleranceSeconds);
      if (overlap > 0 || close) {
        const differences: SpanDifference[] = [];
        if (a.kind !== b.kind) differences.push("label");
        if (a.certainty !== b.certainty) differences.push("certainty");
        if (
          !within(a.startSeconds, b.startSeconds, toleranceSeconds) ||
          !within(a.endSeconds, b.endSeconds, toleranceSeconds)
        ) {
          differences.push("boundaries");
        }
        pairs.push({ i, j, score: Math.max(0, overlap) + (close ? 1e-6 : 0), differences });
      }
    }),
  );
  // Agreeing pairs first, then same-label pairs, then the largest overlap; each span used once.
  pairs.sort(
    (x, y) =>
      Number(y.differences.length === 0) - Number(x.differences.length === 0) ||
      Number(!y.differences.includes("label")) - Number(!x.differences.includes("label")) ||
      y.score - x.score ||
      x.i - y.i ||
      x.j - y.j,
  );
  const usedFirst = new Set<number>();
  const usedSecond = new Set<number>();
  const matches: RaterComparison["matches"] = [];
  const disagreements: SpanDisagreement[] = [];
  for (const pair of pairs) {
    if (usedFirst.has(pair.i) || usedSecond.has(pair.j)) continue;
    usedFirst.add(pair.i);
    usedSecond.add(pair.j);
    const a = first[pair.i];
    const b = second[pair.j];
    if (pair.differences.length === 0) {
      matches.push({
        first: a,
        second: b,
        accepted: {
          kind: a.kind,
          startSeconds: roundAnnotationSeconds((a.startSeconds + b.startSeconds) / 2),
          endSeconds: roundAnnotationSeconds((a.endSeconds + b.endSeconds) / 2),
          certainty: a.certainty,
        },
      });
    } else {
      disagreements.push({
        kind: "pair",
        key: `${pair.i}/${pair.j}`,
        first: a,
        second: b,
        differences: pair.differences,
      });
    }
  }
  first.forEach(
    (a, i) =>
      usedFirst.has(i) || disagreements.push({ kind: "onlyFirst", key: `${i}/-`, first: a }),
  );
  second.forEach(
    (b, j) =>
      usedSecond.has(j) || disagreements.push({ kind: "onlySecond", key: `-/${j}`, second: b }),
  );
  matches.sort((x, y) => x.accepted.startSeconds - y.accepted.startSeconds);
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
    toleranceSeconds,
  };
}

/** Decisions the adjudicator may take for a referred item. */
export function allowedOutcomes(item: SpanDisagreement): AdjudicationDecision["outcome"][] {
  return [
    ...(item.kind !== "onlySecond" ? (["first"] as const) : []),
    ...(item.kind !== "onlyFirst" ? (["second"] as const) : []),
    "adjusted",
    "noEvent",
    "uncertain",
  ];
}

/**
 * The human reference of an adjudication: every accepted agreement plus the outcome of each
 * referred item. Throws unless every referred item has exactly one allowed decision.
 */
export function adjudicatedEvents(
  comparison: RaterComparison,
  decisions: AdjudicationDecision[],
): AnnotatedEvent[] {
  const byItem = new Map<string, AdjudicationDecision>();
  for (const decision of decisions) {
    if (byItem.has(decision.item)) {
      throw new Error(`Referred item ${decision.item} has more than one decision.`);
    }
    byItem.set(decision.item, decision);
  }
  const events = comparison.matches.map((match) => match.accepted);
  for (const item of comparison.disagreements) {
    const decision = byItem.get(item.key);
    if (!decision) throw new Error(`Referred item ${item.key} has no decision.`);
    byItem.delete(item.key);
    if (!allowedOutcomes(item).includes(decision.outcome)) {
      throw new Error(`Referred item ${item.key} cannot be decided as "${decision.outcome}".`);
    }
    if ((decision.outcome === "adjusted") !== (decision.event !== undefined)) {
      throw new Error("Only an adjusted decision carries its own span.");
    }
    const outcome = decisionEvent(item, decision);
    if (outcome) events.push(outcome);
  }
  const unknown = [...byItem.keys()];
  if (unknown.length) throw new Error(`Decision for unknown item ${unknown[0]}.`);
  return events.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

function decisionEvent(item: SpanDisagreement, decision: AdjudicationDecision) {
  const first = item.kind === "onlySecond" ? null : item.first;
  const second = item.kind === "onlyFirst" ? null : item.second;
  switch (decision.outcome) {
    case "first":
      return first;
    case "second":
      return second;
    case "adjusted": {
      const event = decision.event!;
      if (
        !Number.isFinite(event.startSeconds) ||
        !Number.isFinite(event.endSeconds) ||
        event.startSeconds < 0 ||
        event.endSeconds < event.startSeconds
      ) {
        throw new Error("An adjusted span needs finite times with end >= start.");
      }
      return event;
    }
    case "noEvent":
      return null;
    case "uncertain": {
      // Kept as "possible" over both raters' spans; a label disagreement keeps both labels.
      const spans = [first, second].filter((span): span is AnnotatedEvent => span !== null);
      const [a, b] = [spans[0], spans.at(-1)!];
      return {
        kind: a.kind,
        startSeconds: Math.min(a.startSeconds, b.startSeconds),
        endSeconds: Math.max(a.endSeconds, b.endSeconds),
        certainty: "possible" as const,
        ...(a.kind !== b.kind
          ? { candidateLabels: [a.kind, b.kind] as [typeof a.kind, typeof b.kind] }
          : {}),
      };
    }
  }
}

/**
 * Builds the adjudicator's revision for the session's current ratings. The adjudicator is a
 * named Clinician who is neither rater; `annotateSession` enforces that when it is recorded.
 */
export function adjudicationRevision(
  record: SessionRecord,
  input: {
    id: string;
    createdAt: string;
    author: AnnotationRater;
    qualification: string;
    decisions: AdjudicationDecision[];
  },
): Omit<AnnotationRevision, "inputId"> {
  const validation = sessionValidation(record);
  const [first, second] = validation?.ratings ?? [null, null];
  if (!validation?.comparison || !first || !second) {
    throw new Error("Both declared raters must save a reference before adjudication.");
  }
  const previous = currentAnnotations(record).find((revision) =>
    sameRater(revision.author, input.author),
  );
  return {
    id: input.id,
    createdAt: input.createdAt,
    author: input.author,
    basedOnRunId: null,
    events: adjudicatedEvents(validation.comparison, input.decisions),
    status: "accepted",
    supersedes: previous?.id ?? null,
    adjudicates: [first.id, second.id],
    adjudication: {
      qualification: input.qualification.trim(),
      rule: AGREEMENT_RULE,
      decisions: input.decisions,
    },
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
  /** False when a rater saved a new reference after the adjudication, so it needs revising. */
  adjudicationCurrent: boolean;
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
    adjudicationCurrent:
      adjudication !== null &&
      adjudication.adjudicates?.join() === ratings.map((rating) => rating?.id).join(),
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

function within(a: number, b: number, tolerance: number) {
  // Rounded to the annotation resolution, so 1.00 vs 1.25 counts as exactly 250 ms.
  return roundAnnotationSeconds(Math.abs(a - b)) <= tolerance;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
