import { describe, expect, test } from "bun:test";

import { fallbackAnalyze } from "./index";
import {
  acceptedAnnotation,
  analysisSource,
  analyzerKey,
  isAnalysisVerified,
  isReplayable,
  annotateSession,
  audioFingerprint,
  currentAnnotations,
  createSessionRecord,
  type LegacySessionRecord,
  migrateSessionRecord,
  observationFingerprint,
  reanalyzeSession,
  SESSION_SCHEMA_VERSION,
  SHARED_ANALYSIS_VERSION,
  UNKNOWN_INPUT_ID,
  sessionAnalysisRuns,
} from "./sessions";

const segments = [{ text: "hello hello world", startSeconds: 0, endSeconds: 1.5, isFinal: true }];
const pauses = [{ startSeconds: 1.5, endSeconds: 2.25 }];
const report = fallbackAnalyze({ segments, pauses });

const legacy: LegacySessionRecord = {
  id: "session-1",
  startedAt: "2026-09-09T06:00:00.000Z",
  segments,
  pauses,
  report,
};

const onDevice = {
  producer: "onDevice" as const,
  algorithm: "shared-fallback",
  version: SHARED_ANALYSIS_VERSION,
};

describe("session records", () => {
  test("migrates a legacy record with visibly unknown provenance", () => {
    const migrated = migrateSessionRecord(legacy);

    expect(migrated).toEqual({
      schemaVersion: SESSION_SCHEMA_VERSION,
      ...legacy,
      context: { spokenLanguage: "unknown", task: null, condition: null },
      recordings: [],
      analysis: {
        id: "session-1:legacy",
        createdAt: null,
        analyzer: null,
        inputId: UNKNOWN_INPUT_ID,
        usedAudio: null,
        audioId: null,
      },
      priorAnalyses: [],
      annotations: [],
    });
  });

  test("keeps current records and rejects unknown schema versions", () => {
    const current = migrateSessionRecord(legacy);
    expect(migrateSessionRecord(current)).toBe(current);
    expect(() => migrateSessionRecord({ ...current, schemaVersion: 3 as 2 })).toThrow(
      "Unsupported session schema version 3",
    );
  });

  test("stores analyzer identity, timestamp and input identity once per run", () => {
    const record = createSessionRecord({
      ...legacy,
      run: {
        id: "run-1",
        createdAt: "2026-09-09T06:01:00.000Z",
        analyzer: onDevice,
        usedAudio: true,
        audioId: null,
      },
    });

    expect(record.analysis).toEqual({
      id: "run-1",
      createdAt: "2026-09-09T06:01:00.000Z",
      analyzer: onDevice,
      inputId: observationFingerprint(segments, pauses),
      usedAudio: true,
      audioId: null,
    });
    expect(record.priorAnalyses).toEqual([]);
  });

  test("keeps the analyzed input identity when the report predates the saved observation", () => {
    const staleInput = observationFingerprint([], []);
    const record = createSessionRecord({
      ...legacy,
      run: {
        id: "run-1",
        createdAt: null,
        analyzer: onDevice,
        usedAudio: false,
        audioId: null,
        inputId: staleInput,
      },
    });

    expect(record.analysis.inputId).toBe(staleInput);
    expect(record.analysis.inputId).not.toBe(observationFingerprint(segments, pauses));
  });

  test("reanalysis appends a run and preserves the observation and earlier results", () => {
    const original = migrateSessionRecord(legacy);
    const nextReport = { ...report, stutterCount: report.stutterCount + 1 };

    const rerun = reanalyzeSession(
      original,
      {
        id: "run-2",
        createdAt: "2026-10-01T00:00:00.000Z",
        analyzer: onDevice,
        usedAudio: false,
        audioId: null,
      },
      nextReport,
    );

    expect(rerun.segments).toBe(original.segments);
    expect(rerun.pauses).toBe(original.pauses);
    expect(rerun.report).toBe(nextReport);
    expect(rerun.analysis.id).toBe("run-2");
    expect(original.analysis.inputId).toBe(UNKNOWN_INPUT_ID);
    expect(rerun.analysis.inputId).toBe(observationFingerprint(segments, pauses));
    expect(sessionAnalysisRuns(rerun).map((run) => [run.id, run.report])).toEqual([
      ["session-1:legacy", report],
      ["run-2", nextReport],
    ]);
    expect(original.priorAnalyses).toEqual([]);
    expect(original.report).toBe(report);
  });

  test("a rerun without audio keeps the capture quality of the recorded capture", () => {
    const captureQuality = {
      state: "unknown" as const,
      issues: ["noInput" as const],
      explanation: "Result unknown: the microphone delivered no input.",
    };
    const original = migrateSessionRecord({ ...legacy, report: { ...report, captureQuality } });
    const run = {
      id: "run-2",
      createdAt: "2026-10-01T00:00:00.000Z",
      analyzer: onDevice,
      usedAudio: false,
      audioId: null,
    };

    expect(reanalyzeSession(original, run, report).report.captureQuality).toEqual(captureQuality);
    const remeasured = {
      ...report,
      captureQuality: { state: "usable" as const, issues: [] as [] },
    };
    expect(reanalyzeSession(original, run, remeasured).report).toBe(remeasured);
  });

  test("rejects recording the same run twice", () => {
    const original = migrateSessionRecord(legacy);
    expect(() => reanalyzeSession(original, { ...original.analysis }, report)).toThrow(
      "already recorded",
    );
  });

  test("fingerprints analyzed audio by sample rate and exact samples", () => {
    const samples = [0, 0.25, -0.5, 1];
    expect(audioFingerprint(samples, 16_000)).toBe(audioFingerprint(samples, 16_000));
    expect(audioFingerprint(samples, 16_000)).toMatch(/^pcm-[0-9a-f]{16}$/);
    expect(audioFingerprint(samples, 48_000)).not.toBe(audioFingerprint(samples, 16_000));
    expect(audioFingerprint([0, 0.25, -0.5, 0.9], 16_000)).not.toBe(
      audioFingerprint(samples, 16_000),
    );
    expect(audioFingerprint([...samples, 0], 16_000)).not.toBe(audioFingerprint(samples, 16_000));
  });

  test("fingerprints the observation deterministically", () => {
    expect(observationFingerprint(segments, pauses)).toBe(observationFingerprint(segments, pauses));
    expect(observationFingerprint(segments, pauses)).toMatch(/^obs-[0-9a-f]{16}$/);
    expect(observationFingerprint([{ ...segments[0], text: "hello world" }], pauses)).not.toBe(
      observationFingerprint(segments, pauses),
    );
    expect(observationFingerprint(segments, [])).not.toBe(observationFingerprint(segments, pauses));
    for (const changed of [
      { ...segments[0], confidence: 0.4 },
      { ...segments[0], speakerScore: 0.9 },
      { ...segments[0], speakerLabel: "Guest" },
    ]) {
      expect(observationFingerprint([changed], pauses)).not.toBe(
        observationFingerprint(segments, pauses),
      );
    }
    expect(observationFingerprint(segments, [{ ...pauses[0], afterText: "world" }])).not.toBe(
      observationFingerprint(segments, pauses),
    );
  });
});

describe("annotation revisions", () => {
  const record = migrateSessionRecord(legacy);
  const event = {
    kind: "wordRepetition" as const,
    startSeconds: 0,
    endSeconds: 0.6,
    certainty: "certain" as const,
  };
  const revision = (id: string, patch: Partial<Parameters<typeof annotateSession>[1]> = {}) => ({
    id,
    createdAt: "2026-10-08T10:00:00.000Z",
    author: { role: "clinician" as const },
    basedOnRunId: record.analysis.id,
    events: [event],
    status: "accepted" as const,
    supersedes: null,
    ...patch,
  });

  test("migrated version-2 records without annotations read as having none", () => {
    const { annotations: _dropped, ...older } = record;
    expect(migrateSessionRecord(older as typeof record).annotations).toEqual([]);
  });

  test("appends revisions with the observation they describe and keeps replaced ones", () => {
    const first = annotateSession(record, revision("a-1", { status: "draft" }));
    const second = annotateSession(first, revision("a-2", { supersedes: "a-1" }));

    expect(second.annotations.map((item) => item.id)).toEqual(["a-1", "a-2"]);
    expect(second.annotations[1].inputId).toBe(observationFingerprint(segments, pauses));
    expect(currentAnnotations(second).map((item) => item.id)).toEqual(["a-2"]);
    expect(acceptedAnnotation(second)?.id).toBe("a-2");
    expect(acceptedAnnotation(first)).toBeNull();
  });

  test("reanalysis keeps an accepted annotation and the run it was made against", () => {
    const annotated = annotateSession(record, revision("a-1"));
    const rerun = reanalyzeSession(
      annotated,
      {
        id: "run-2",
        createdAt: "2026-10-09T00:00:00.000Z",
        analyzer: onDevice,
        usedAudio: false,
        audioId: null,
      },
      { ...report, stutterCount: 0 },
    );

    expect(rerun.annotations).toEqual(annotated.annotations);
    expect(acceptedAnnotation(rerun)?.basedOnRunId).toBe(record.analysis.id);
    expect(rerun.analysis.id).toBe("run-2");
  });

  test("rejects duplicate ids, unknown references and invalid event times", () => {
    const annotated = annotateSession(record, revision("a-1"));
    expect(() => annotateSession(annotated, revision("a-1"))).toThrow("already recorded");
    expect(() => annotateSession(record, revision("a-2", { supersedes: "missing" }))).toThrow(
      "does not exist",
    );
    expect(() => annotateSession(record, revision("a-3", { basedOnRunId: "run-x" }))).toThrow(
      "not part of session",
    );
    expect(() =>
      annotateSession(record, revision("a-4", { events: [{ ...event, endSeconds: -1 }] })),
    ).toThrow("end >= start");
    expect(() =>
      annotateSession(
        annotated,
        revision("a-7", { author: { role: "clinician", id: "rater-2" }, supersedes: "a-1" }),
      ),
    ).toThrow("belongs to another rater");
    expect(() =>
      annotateSession(annotated, revision("a-8", { author: { role: "self" }, supersedes: "a-1" })),
    ).toThrow("belongs to another rater");
    expect(() => annotateSession(record, revision(""))).toThrow("non-empty id");
    expect(() => annotateSession(record, revision("a-6", { createdAt: "soon" }))).toThrow(
      "valid createdAt",
    );
    expect(
      annotateSession(record, revision("a-5", { basedOnRunId: null })).annotations,
    ).toHaveLength(1);
  });
});

describe("analysis comparability", () => {
  test("identifies the analyzer, verification and source of a session's analysis", () => {
    const legacyRecord = migrateSessionRecord(legacy);
    expect(analyzerKey(legacyRecord)).toBe("unknown");
    expect(isAnalysisVerified(legacyRecord)).toBe(false);
    expect(analysisSource(legacyRecord)).toBe("automated");
    expect(isReplayable(legacyRecord)).toBe(true);
    expect(isReplayable({ ...legacyRecord, segments: [], pauses: [] })).toBe(false);

    const rerun = reanalyzeSession(
      legacyRecord,
      { id: "run-2", createdAt: null, analyzer: onDevice, usedAudio: false, audioId: null },
      report,
    );
    expect(analyzerKey(rerun)).toBe(`onDevice:shared-fallback:${SHARED_ANALYSIS_VERSION}`);
    expect(isAnalysisVerified(rerun)).toBe(true);
    const unversioned = {
      ...rerun,
      analysis: { ...rerun.analysis, analyzer: { ...onDevice, version: null } },
    };
    expect(analyzerKey(unversioned)).toBe("unknown");

    const reviewed = annotateSession(rerun, {
      id: "a-1",
      createdAt: "2026-10-08T10:00:00.000Z",
      author: { role: "clinician" },
      basedOnRunId: null,
      events: [],
      status: "accepted",
      supersedes: null,
    });
    expect(analysisSource(reviewed)).toBe("humanReference");
  });
});
