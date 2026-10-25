import { describe, expect, test } from "bun:test";

import { fallbackAnalyze } from "./index";
import {
  type AnnotatedEvent,
  type AnnotationRater,
  acceptedAnnotation,
  annotateSession,
  declareValidation,
  migrateSessionRecord,
} from "./sessions";
import {
  AGREEMENT_RULE,
  adjudicatedEvents,
  adjudicationRevision,
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
  test("accepts only full agreement and refers every other difference", () => {
    const first = [
      span("block", 1, 1.5),
      span("wordRepetition", 3, 3.4),
      span("prolongation", 5, 5.6),
      span("noSpeech", 7, 8),
      span("block", 10, 11),
      { ...span("block", 13, 13.5), certainty: "possible" as const },
    ];
    const second = [
      span("block", 1.1, 1.6),
      span("soundRepetition", 3.1, 3.3),
      span("filler", 9, 9.2),
      span("noSpeech", 7, 8),
      span("block", 10, 11.4),
      span("block", 13, 13.5),
    ];
    const comparison = compareRaters(first, second);

    expect(comparison.matches.map((match) => match.accepted)).toEqual([
      // The mean of both raters' boundaries.
      span("block", 1.05, 1.55),
      span("noSpeech", 7, 8),
    ]);
    expect(comparison.disagreements).toEqual([
      {
        kind: "pair",
        key: "1/1",
        first: first[1],
        second: second[1],
        differences: ["label"],
      },
      { kind: "onlyFirst", key: "2/-", first: first[2] },
      { kind: "onlySecond", key: "-/2", second: second[2] },
      { kind: "pair", key: "4/4", first: first[4], second: second[4], differences: ["boundaries"] },
      { kind: "pair", key: "5/5", first: first[5], second: second[5], differences: ["certainty"] },
    ]);
    // noSpeech is a span condition: accepted, but not counted as an agreed event.
    expect(comparison.eventCounts).toEqual([5, 5]);
    expect(comparison.positiveAgreement).toBe(0.2);
  });

  test("onset and offset each agree up to 250 ms; identical spans give kappa 1", () => {
    expect(compareRaters([span("block", 1, 2)], [span("block", 1.25, 2.25)]).matches).toHaveLength(
      1,
    );
    expect(compareRaters([span("block", 1, 2)], [span("block", 1, 2.26)]).matches).toHaveLength(0);
    expect(compareRaters([span("block", 1, 1)], [span("block", 1.3, 1.3)]).disagreements).toEqual([
      expect.objectContaining({ kind: "onlyFirst" }),
      expect.objectContaining({ kind: "onlySecond" }),
    ]);
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

  const adjudicator = { role: "clinician" as const, id: "C" };
  const qualification = "SLT, stuttering specialist";
  const rated = () => {
    let record = annotateSession(
      declared,
      revision("a", raterA, [
        span("block", 1, 1.5),
        span("prolongation", 2, 2.5),
        span("wordRepetition", 3, 3.4),
      ]),
    );
    expect(sessionValidation(record)?.comparison).toBeNull();
    record = annotateSession(
      record,
      revision("b", raterB, [span("block", 1.1, 1.6), span("soundRepetition", 3, 3.4)]),
    );
    return record;
  };

  test("decides each referred item and leaves both ratings unchanged", () => {
    let record = rated();
    const validation = sessionValidation(record)!;
    expect(validation.blind).toEqual([true, true]);
    expect(validation.comparison?.disagreements.map((item) => item.key)).toEqual(["1/-", "2/1"]);

    const decide = (decisions: Parameters<typeof adjudicationRevision>[1]["decisions"]) =>
      adjudicationRevision(record, {
        id: "c",
        createdAt: "2026-10-17T10:06:00.000Z",
        author: adjudicator,
        qualification: ` ${qualification} `,
        decisions,
      });
    expect(() => decide([{ item: "1/-", outcome: "noEvent" }])).toThrow("2/1 has no decision");
    expect(() =>
      decide([
        { item: "1/-", outcome: "second" },
        { item: "2/1", outcome: "first" },
      ]),
    ).toThrow('cannot be decided as "second"');

    const adjudication = decide([
      { item: "1/-", outcome: "noEvent" },
      { item: "2/1", outcome: "uncertain" },
    ]);
    expect(adjudication).toMatchObject({
      adjudicates: ["a", "b"],
      adjudication: { qualification, rule: AGREEMENT_RULE },
      events: [
        span("block", 1.05, 1.55),
        {
          ...span("wordRepetition", 3, 3.4),
          certainty: "possible",
          candidateLabels: ["wordRepetition", "soundRepetition"],
        },
      ],
    });
    record = annotateSession(record, adjudication);
    expect(acceptedAnnotation(record)?.id).toBe("c");
    expect(sessionValidation(record)?.adjudicationCurrent).toBe(true);
    expect(record.annotations.find((item) => item.id === "a")?.events).toHaveLength(3);
    expect(record.annotations.find((item) => item.id === "b")?.events).toHaveLength(2);

    // A later rater save does not displace the reference, but marks it for revision.
    record = annotateSession(record, {
      ...revision("a2", raterA, [span("block", 1, 1.5)]),
      supersedes: "a",
    });
    expect(acceptedAnnotation(record)?.id).toBe("c");
    expect(sessionValidation(record)?.adjudicationCurrent).toBe(false);
    // The adjudicator cannot overwrite the adjudication with a plain annotation.
    expect(() =>
      annotateSession(record, { ...revision("x", adjudicator, []), supersedes: "c" }),
    ).toThrow("Revise an adjudication");

    expect(validationReport([record, base])).toMatchObject({
      declared: 1,
      bothRated: 1,
      adjudicated: 1,
    });
  });

  test("rater 1, rater 2 and adjusted decisions; union span for an uncertain single-rater item", () => {
    const comparison = sessionValidation(rated())!.comparison!;
    const adjusted = { ...span("soundRepetition", 2.9, 3.5), certainty: "possible" as const };
    expect(
      adjudicatedEvents(comparison, [
        { item: "1/-", outcome: "first" },
        { item: "2/1", outcome: "adjusted", event: adjusted },
      ]),
    ).toEqual([span("block", 1.05, 1.55), span("prolongation", 2, 2.5), adjusted]);
    expect(
      adjudicatedEvents(comparison, [
        { item: "1/-", outcome: "uncertain" },
        { item: "2/1", outcome: "second" },
      ]),
    ).toEqual([
      span("block", 1.05, 1.55),
      { ...span("prolongation", 2, 2.5), certainty: "possible" },
      span("soundRepetition", 3, 3.4),
    ]);
    expect(() =>
      adjudicatedEvents(comparison, [
        { item: "1/-", outcome: "adjusted" },
        { item: "2/1", outcome: "second" },
      ]),
    ).toThrow("Only an adjusted decision");
  });

  test("only a named, qualified Clinician who is neither rater may adjudicate", () => {
    const record = rated();
    const decisions = [
      { item: "1/-", outcome: "noEvent" as const },
      { item: "2/1", outcome: "first" as const },
    ];
    const attempt = (author: AnnotationRater, statement = qualification) =>
      annotateSession(
        record,
        adjudicationRevision(record, {
          id: "x",
          createdAt: "2026-10-17T10:06:00.000Z",
          author,
          qualification: statement,
          decisions,
        }),
      );
    expect(() => attempt(raterA)).toThrow("cannot adjudicate their own");
    expect(() => attempt({ role: "researcher", id: "C" })).toThrow("named person in the Clinician");
    expect(() => attempt({ role: "clinician" })).toThrow("named person in the Clinician");
    expect(() => attempt(adjudicator, "  ")).toThrow("qualification statement");
    expect(() =>
      annotateSession(record, {
        ...revision("x", adjudicator, [], { adjudicates: ["b", "a"] }),
        adjudication: { qualification, rule: AGREEMENT_RULE, decisions: [] },
      }),
    ).toThrow("not a revision of declared rater 1");
    expect(() =>
      annotateSession(base, revision("x", adjudicator, [], { adjudicates: ["a", "b"] })),
    ).toThrow("no declared two-rater validation");
    expect(attempt(adjudicator).annotations.at(-1)?.author).toEqual(adjudicator);
  });
});
