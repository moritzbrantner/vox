import { describe, expect, test } from "bun:test";

import { fallbackAnalyze } from "./index";
import {
  type AnnotatedEvent,
  acceptedAnnotation,
  annotateSession,
  declareValidation,
  migrateSessionRecord,
} from "./sessions";
import {
  adjudicationStart,
  compareRaters,
  sessionValidation,
  validationReport,
} from "./validation";

const span = (
  kind: AnnotatedEvent["kind"],
  startSeconds: number,
  endSeconds: number,
): AnnotatedEvent => ({
  kind,
  startSeconds,
  endSeconds,
  certainty: "certain",
});

describe("rater comparison", () => {
  test("matches same-label spans by overlap or onset tolerance and records each disagreement", () => {
    const first = [
      span("block", 1, 1.5),
      span("wordRepetition", 3, 3.4),
      span("prolongation", 5, 5.6),
      span("noSpeech", 7, 8),
    ];
    const second = [
      span("block", 1.1, 1.6),
      span("soundRepetition", 3.1, 3.3),
      span("filler", 9, 9.2),
      span("noSpeech", 7, 8),
    ];
    const comparison = compareRaters(first, second);

    expect(comparison.matches.map((match) => match.first.kind)).toEqual(["block", "noSpeech"]);
    expect(comparison.disagreements).toEqual([
      { kind: "labelMismatch", first: first[1], second: second[1] },
      { kind: "onlyFirst", first: first[2] },
      { kind: "onlySecond", second: second[2] },
    ]);
    // noSpeech is a span condition: matched, but not counted as an agreed event.
    expect(comparison.eventCounts).toEqual([3, 3]);
    expect(comparison.positiveAgreement).toBe(0.333);
    expect(adjudicationStart(comparison)).toHaveLength(6);
  });

  test("an onset within tolerance matches without overlap; identical spans give kappa 1", () => {
    expect(compareRaters([span("block", 1, 1)], [span("block", 1.2, 1.2)]).matches).toHaveLength(1);
    expect(compareRaters([span("block", 1, 1)], [span("block", 1.3, 1.3)]).matches).toHaveLength(0);
    const same = compareRaters([span("block", 1, 2)], [span("block", 1, 2)], {
      durationSeconds: 4,
    });
    expect(same.frameKappa).toBe(1);
    expect(same.positiveAgreement).toBe(1);
    expect(compareRaters([], [], { durationSeconds: 4 })).toMatchObject({
      positiveAgreement: null,
      frameKappa: null,
    });
  });

  test("frame kappa reflects chance-corrected agreement", () => {
    // 0-1 s both, 1-2 s only the first, 2-4 s neither: po 0.75, pe 0.5 → 0.5.
    const comparison = compareRaters([span("block", 0, 2)], [span("block", 0, 1)], {
      durationSeconds: 4,
    });
    expect(comparison.frameKappa).toBe(0.5);
  });
});

describe("declared validation and adjudication", () => {
  const segments = [{ text: "I I want", startSeconds: 0, endSeconds: 4, isFinal: true }];
  const base = migrateSessionRecord({
    id: "s-1",
    startedAt: "2026-10-17T10:00:00.000Z",
    segments,
    pauses: [],
    report: fallbackAnalyze({ segments, pauses: [] }),
  });
  const raterA = { role: "clinician" as const, id: "A" };
  const raterB = { role: "researcher" as const, id: "B" };
  const declared = declareValidation(base, {
    declaredAt: "2026-10-17T10:01:00.000Z",
    raters: [raterA, raterB],
  });
  const revision = (
    id: string,
    author: typeof raterA | typeof raterB | { role: "clinician"; id: string },
    events: AnnotatedEvent[],
    extra = {},
  ) => ({
    id,
    createdAt: "2026-10-17T10:05:00.000Z",
    author,
    basedOnRunId: null,
    events,
    status: "accepted" as const,
    supersedes: null,
    ...extra,
  });

  test("must be declared before either rater annotates, with two different raters", () => {
    expect(() => declareValidation(declared, declared.validation!)).toThrow("already has");
    expect(() =>
      declareValidation(base, {
        declaredAt: "2026-10-17T10:01:00.000Z",
        raters: [raterA, { ...raterA }],
      }),
    ).toThrow("two different raters");
    const annotated = annotateSession(base, revision("r", raterA, []));
    expect(() =>
      declareValidation(annotated, {
        declaredAt: "2026-10-17T10:01:00.000Z",
        raters: [raterA, raterB],
      }),
    ).toThrow("already annotated");
  });

  test("reports agreement and makes the adjudication the reference without changing ratings", () => {
    let record = annotateSession(
      declared,
      revision("a", raterA, [span("block", 1, 1.5), span("prolongation", 2, 2.5)]),
    );
    expect(sessionValidation(record)?.comparison).toBeNull();
    record = annotateSession(record, revision("b", raterB, [span("block", 1.05, 1.5)]));
    const validation = sessionValidation(record)!;
    expect(validation.blind).toEqual([true, true]);
    expect(validation.comparison?.disagreements).toHaveLength(1);

    const adjudicator = { role: "clinician" as const, id: "C" };
    expect(() =>
      annotateSession(record, revision("x", raterA, [], { adjudicates: ["a", "b"] })),
    ).toThrow("cannot adjudicate their own");
    expect(() =>
      annotateSession(record, revision("x", adjudicator, [], { adjudicates: ["b", "a"] })),
    ).toThrow("not a revision of declared rater 1");
    expect(() =>
      annotateSession(base, revision("x", adjudicator, [], { adjudicates: ["a", "b"] })),
    ).toThrow("no declared two-rater validation");
    record = annotateSession(
      record,
      revision("c", adjudicator, [span("block", 1, 1.5)], { adjudicates: ["a", "b"] }),
    );
    // A later rater save does not displace the adjudicated reference.
    expect(acceptedAnnotation(record)?.id).toBe("c");
    expect(record.annotations.find((item) => item.id === "a")?.events).toHaveLength(2);

    const report = validationReport([record, base]);
    expect(report).toMatchObject({
      declared: 1,
      bothRated: 1,
      adjudicated: 1,
      positiveAgreement: 0.667,
      disagreementCount: 1,
    });
  });
});
