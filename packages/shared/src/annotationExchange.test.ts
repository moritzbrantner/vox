import { describe, expect, test } from "bun:test";

import {
  ANNOTATION_EXCHANGE_RIGHTS,
  buildAnnotationExchange,
  decodeSamples,
  encodeSamples,
  exchangeSummary,
  mergeAnnotationExchange,
  parseAnnotationExchange,
  reviewCopyFromExchange,
} from "./annotationExchange";
import { fallbackAnalyze } from "./index";
import {
  annotateSession,
  declareValidation,
  migrateSessionRecord,
  observationFingerprint,
  reanalyzeSession,
} from "./sessions";

const segments = [
  {
    text: "I I want",
    startSeconds: 0,
    endSeconds: 1,
    confidence: 0.9,
    speakerLabel: "Me",
    isFinal: true,
  },
];
const pauses = [{ startSeconds: 1, endSeconds: 1.5, afterText: "want" }];
const report = fallbackAnalyze({ segments, pauses });
const origin = migrateSessionRecord({
  id: "s-1",
  startedAt: "2026-10-17T09:00:00.000Z",
  segments,
  pauses,
  report,
});
const raterA = { role: "clinician" as const, id: "A" };
const raterB = { role: "clinician" as const, id: "B" };
const exportedAt = new Date("2026-10-17T10:00:00.000Z");
const options = { exportedAt, consentGrantedAt: "2026-10-17T09:30:00.000Z" };
const roundtrip = (value: unknown) => parseAnnotationExchange(JSON.parse(JSON.stringify(value)));
const emptyReport = { ...report, events: [], stutterCount: 0 };

function revision(id: string, author: typeof raterA, extra = {}) {
  return {
    id,
    createdAt: "2026-10-17T10:30:00.000Z",
    author,
    basedOnRunId: null,
    events: [
      {
        kind: "block" as const,
        startSeconds: 0.2,
        endSeconds: 0.6,
        certainty: "possible" as const,
      },
    ],
    status: "accepted" as const,
    supersedes: null,
    ...extra,
  };
}

describe("annotation exchange", () => {
  test("carries transcript, revisions, validation and fixed rights, never analysis, dates or conditions", () => {
    const declared = declareValidation(origin, {
      declaredAt: "2026-10-17T09:45:00.000Z",
      raters: [raterA, raterB],
    });
    const file = buildAnnotationExchange(declared, options);
    const json = JSON.stringify(file);
    expect(file.rights).toEqual(ANNOTATION_EXCHANGE_RIGHTS);
    expect(file.consent).toEqual({
      purpose: "clinicianSharing",
      grantedAt: "2026-10-17T09:30:00.000Z",
    });
    for (const hidden of [
      "report",
      "startedAt",
      "context",
      "priorAnalyses",
      "stutterCount",
      "2026-10-17T09:00",
    ]) {
      expect(json).not.toContain(hidden);
    }
    expect(roundtrip(file)).toEqual(file);
  });

  test("a rater on another device annotates a review copy and the origin merges it back", () => {
    const declared = declareValidation(origin, {
      declaredAt: "2026-10-17T09:45:00.000Z",
      raters: [raterA, raterB],
    });
    const sent = roundtrip(buildAnnotationExchange(declared, options));

    let copy = reviewCopyFromExchange(sent, {
      importedAt: new Date("2026-10-17T10:10:00.000Z"),
      emptyReport,
    });
    copy = mergeAnnotationExchange(copy, sent).record;
    expect(copy.reviewCopy).toEqual({
      exportedAt: sent.exportedAt,
      importedAt: "2026-10-17T10:10:00.000Z",
    });
    expect(copy.startedAt).toBe("2026-10-17T10:10:00.000Z");
    expect(copy.validation).toEqual(declared.validation);
    copy = annotateSession(copy, revision("rA", raterA));

    const back = roundtrip(
      buildAnnotationExchange(copy, {
        ...options,
        exportedAt: new Date("2026-10-17T11:00:00.000Z"),
      }),
    );
    const merged = mergeAnnotationExchange(declared, back);
    expect(merged).toMatchObject({ added: 1, alreadyPresent: 0 });
    expect(merged.record.annotations[0].inputId).toBe(observationFingerprint(segments, pauses));
    // Importing the same file again adds nothing.
    expect(mergeAnnotationExchange(merged.record, back)).toMatchObject({
      added: 0,
      alreadyPresent: 1,
    });
    expect(exchangeSummary(back)).toMatchObject({
      segments: 1,
      revisions: 1,
      events: 1,
      raters: [raterA],
      audioSeconds: null,
    });
  });

  test("rejects a different transcript, a changed revision, conflicting raters and tampered rights", () => {
    const file = buildAnnotationExchange(annotateSession(origin, revision("rA", raterA)), options);
    const edited = { ...origin, segments: [{ ...segments[0], text: "I want" }] };
    expect(() => mergeAnnotationExchange(edited, file)).toThrow("different version");
    const changed = annotateSession(origin, { ...revision("rA", raterA), events: [] });
    expect(() => mergeAnnotationExchange(changed, file)).toThrow(
      "differs from the one already here",
    );
    const declaredHere = declareValidation(origin, {
      declaredAt: "2026-10-17T09:45:00.000Z",
      raters: [raterB, raterA],
    });
    const declaredThere = buildAnnotationExchange(
      declareValidation(origin, {
        declaredAt: "2026-10-17T09:45:00.000Z",
        raters: [raterA, raterB],
      }),
      options,
    );
    expect(() => mergeAnnotationExchange(declaredHere, declaredThere)).toThrow(
      "different validation raters",
    );
    expect(() => roundtrip({ ...file, rights: { ...file.rights, modelTraining: true } })).toThrow(
      "permitted-use",
    );
    expect(() =>
      roundtrip({
        ...file,
        consent: { purpose: "researchContribution", grantedAt: options.consentGrantedAt },
      }),
    ).toThrow("clinician-sharing");
    expect(() =>
      roundtrip({
        ...file,
        session: { ...file.session, segments: [{ ...segments[0], text: "edited" }] },
      }),
    ).toThrow("does not match its fingerprint");
    expect(() => roundtrip({ ...file, format: "other" })).toThrow(
      "not an annotation exchange file",
    );
  });

  test("an origin revision made against an analysis run merges back only where that run exists", () => {
    const rerun = reanalyzeSession(
      origin,
      { id: "run-2", createdAt: null, analyzer: null, usedAudio: false, audioId: null },
      report,
    );
    const shown = annotateSession(
      rerun,
      revision("rS", { role: "self" } as never, { basedOnRunId: "run-2" }),
    );
    const file = roundtrip(buildAnnotationExchange(shown, options));
    const copy = reviewCopyFromExchange(file, { importedAt: exportedAt, emptyReport });
    expect(mergeAnnotationExchange(copy, file).added).toBe(1);
    expect(() => mergeAnnotationExchange(origin, file)).toThrow(
      "analysis this session does not have",
    );
  });

  test("encodes float32 samples exactly", () => {
    const samples = Float32Array.from([0, 0.5, -1, 1e-7, 0.123456789]);
    expect(Array.from(decodeSamples(encodeSamples(samples)))).toEqual(Array.from(samples));
    expect(decodeSamples(encodeSamples(new Float32Array(70000).fill(0.25)))).toHaveLength(70000);
  });
});
