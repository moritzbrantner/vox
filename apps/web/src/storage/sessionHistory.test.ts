import { migrateSessionRecord, reanalyzeSession } from "@stutter-tracker/shared";
import { describe, expect, it } from "vitest";
import type { AnalysisReport, SavedSession } from "../types";
import {
  buildSessionHistory,
  cohortKey,
  historyCohorts,
  languageBreakdown,
  progressComparability,
} from "./sessionHistory";

describe("buildSessionHistory", () => {
  it("returns the newest requested sessions in chronological order", () => {
    const sessions = [
      savedSession("newest", "2026-09-08T12:00:00.000Z", 96, 1.5, 132),
      savedSession("oldest", "2026-09-01T12:00:00.000Z", 88, 4.5, 118),
      savedSession("middle", "2026-09-05T12:00:00.000Z", 92, 3, 124),
    ];

    expect(buildSessionHistory(sessions, 2).map((session) => session.id)).toEqual([
      "middle",
      "newest",
    ]);
  });

  it("excludes invalid timestamps and handles an empty limit", () => {
    const sessions = [
      savedSession("valid", "2026-09-08T12:00:00.000Z", 90, 2, 120),
      savedSession("invalid", "not-a-date", 90, 2, 120),
    ];

    expect(buildSessionHistory(sessions).map((session) => session.id)).toEqual(["valid"]);
    expect(buildSessionHistory(sessions, 0)).toEqual([]);
  });

  it("normalizes legacy or malformed metrics without inventing fluency data", () => {
    const session = savedSession("legacy", "2026-09-08T12:00:00.000Z", 90, 2, 120);
    session.report.totalDurationSeconds = 120;
    session.report.stutterCount = 4;
    session.report.stuttersPerMinute = Number.NaN;
    (session.report as Partial<AnalysisReport>).speechStats = undefined;

    expect(buildSessionHistory([session])).toEqual([
      {
        id: "legacy",
        startedAt: "2026-09-08T12:00:00.000Z",
        durationSeconds: 120,
        stutterCount: 4,
        stuttersPerMinute: 2,
        fluencyPercentage: null,
        wordsPerMinute: null,
        analyzerKey: "unknown",
        verified: false,
        usedAudio: null,
        spokenLanguage: "unknown",
        task: "unknown",
        condition: "unknown",
      },
    ]);
  });

  it("clamps persisted percentages and negative rates to display-safe values", () => {
    const session = savedSession("bounded", "2026-09-08T12:00:00.000Z", 130, -4, -20);

    expect(buildSessionHistory([session])[0]).toMatchObject({
      fluencyPercentage: 100,
      stuttersPerMinute: 0,
      wordsPerMinute: 0,
    });
  });

  it("marks progress with mixed analyzer versions as not directly comparable", () => {
    const verifiedRun = (session: SavedSession, version: string): SavedSession =>
      reanalyzeSession(
        { ...session, context: { ...session.context, spokenLanguage: "en" } },
        {
          id: `run-${version}-${session.id}`,
          createdAt: "2026-10-01T00:00:00.000Z",
          analyzer: { producer: "onDevice", algorithm: "shared-fallback", version },
          usedAudio: false,
          audioId: null,
        },
        session.report,
      );
    const first = verifiedRun(savedSession("a", "2026-09-01T12:00:00.000Z", 90, 2, 120), "1");
    const second = verifiedRun(savedSession("b", "2026-09-02T12:00:00.000Z", 92, 1, 120), "1");
    const newer = verifiedRun(savedSession("c", "2026-09-03T12:00:00.000Z", 95, 1, 120), "2");

    expect(progressComparability(buildSessionHistory([first, second]))).toEqual({
      comparable: true,
      reasons: [],
      reanalysisHelps: false,
      contextDiffers: false,
      taskUnrecorded: true,
      conditionUnrecorded: true,
    });
    const variant = { ...second, context: { ...second.context, spokenLanguage: "en-US" } };
    const sameLanguage = progressComparability(
      buildSessionHistory([
        { ...first, context: { ...first.context, spokenLanguage: "en" } },
        variant,
      ]),
    );
    expect(sameLanguage.comparable).toBe(true);
    const mixed = progressComparability(buildSessionHistory([first, second, newer]));
    expect(mixed.comparable).toBe(false);
    expect(mixed.reasons).toEqual(["2 different analyzer versions produced these results"]);

    const legacy = progressComparability(
      buildSessionHistory([savedSession("d", "2026-09-04T12:00:00.000Z", 90, 2, 120)]),
    );
    expect(legacy.reasons).toEqual([
      "the analyzer version was not recorded for these sessions",
      "whether audio was analyzed was not recorded for these sessions",
      "the spoken language was not recorded for these sessions",
      "1 session's analysis is not verified for the saved transcript",
    ]);
    const inGerman = { ...second, context: { ...second.context, spokenLanguage: "de" } };
    const languages = progressComparability(buildSessionHistory([first, inGerman]));
    expect(languages.reasons).toEqual(["they span 2 different languages"]);
    expect(languages.contextDiffers).toBe(true);
    expect(languages.reanalysisHelps).toBe(false);
    const assisted = {
      ...second,
      context: { ...second.context, condition: { kind: "assisted" as const, aidId: "daf" } },
    };
    expect(progressComparability(buildSessionHistory([first, assisted])).reasons).toEqual([
      "they span 2 different assistance conditions",
    ]);
    const withSettings = (session: SavedSession, settings: Record<string, number>) => ({
      ...session,
      context: {
        ...session.context,
        condition: { kind: "assisted" as const, aidId: "daf", settings },
      },
    });
    expect(
      progressComparability(
        buildSessionHistory([
          withSettings(first, { delayMs: 80, wetMix: 0.5 }),
          withSettings(second, { wetMix: 0.5, delayMs: 80 }),
        ]),
      ).comparable,
    ).toBe(true);
    const unknownAudio = (session: SavedSession) => ({
      ...session,
      analysis: { ...session.analysis, usedAudio: null },
    });
    expect(
      progressComparability(buildSessionHistory([unknownAudio(first), unknownAudio(second)]))
        .reasons,
    ).toEqual(["whether audio was analyzed was not recorded for these sessions"]);

    const withAudio = { ...first, analysis: { ...first.analysis, usedAudio: true } };
    expect(progressComparability(buildSessionHistory([withAudio, second])).reasons).toEqual([
      "some were analyzed with audio and some without",
    ]);
    const unversioned = {
      ...second,
      analysis: {
        ...second.analysis,
        analyzer: {
          producer: "computeServer" as const,
          algorithm: "compute-server",
          version: null,
        },
      },
    };
    expect(progressComparability(buildSessionHistory([first, unversioned])).reasons).toEqual([
      "the analyzer version was not recorded for 1 of them",
    ]);
  });
});

function savedSession(
  id: string,
  startedAt: string,
  fluencyPercentage: number,
  stuttersPerMinute: number,
  wordsPerMinute: number,
): SavedSession {
  return migrateSessionRecord({
    id,
    startedAt,
    segments: [],
    pauses: [],
    report: {
      totalDurationSeconds: 60,
      wordCount: 100,
      stutterCount: 2,
      stuttersPerMinute,
      severity: "mild",
      speechStats: {
        speakingDurationSeconds: 50,
        pauseDurationSeconds: 10,
        wordsPerMinute,
        articulationRateWpm: wordsPerMinute,
        meanChunkWords: 10,
        meanChunkDurationSeconds: 5,
        eventDensityPer100Words: 2,
        fluencyPercentage,
      },
      blockerStats: {
        blockCount: 0,
        totalBlockSeconds: 0,
        averageBlockSeconds: 0,
        longestBlockSeconds: 0,
        blocksPerMinute: 0,
        blockedTimePercentage: 0,
      },
      chunks: [],
      events: [],
      byKind: {},
    },
  });
}

describe("history cohorts", () => {
  const tagged = (
    id: string,
    language: string,
    task: SavedSession["context"]["task"],
    condition: SavedSession["context"]["condition"],
  ) => {
    const session = savedSession(id, "2026-09-08T12:00:00.000Z", 90, 2, 120);
    return { ...session, context: { spokenLanguage: language, task, condition } };
  };
  const reading = { kind: "reading" as const, trained: false };

  it("groups sessions by language, task and condition, largest group first", () => {
    const sessions = [
      tagged("a", "en", reading, { kind: "unassisted" }),
      tagged("b", "en-US", reading, { kind: "unassisted" }),
      tagged("c", "de", reading, { kind: "unassisted" }),
      tagged("d", "en", reading, { kind: "assisted", aidId: "daf", settings: { delayMs: 80 } }),
      tagged("e", "en", null, null),
    ];
    const cohorts = historyCohorts(sessions);
    expect(cohorts[0]).toEqual({
      key: "en|reading:untrained|unassisted",
      spokenLanguage: "en",
      task: "reading:untrained",
      condition: "unassisted",
      count: 2,
    });
    expect(cohorts).toHaveLength(4);
    expect(cohortKey(sessions[3])).toBe('en|reading:untrained|assisted:daf:[["delayMs",80]]');
    expect(languageBreakdown(sessions)).toEqual([
      ["en", 4],
      ["de", 1],
    ]);
    // One cohort is comparable on context.
    const cohort = sessions.filter((session) => cohortKey(session) === cohorts[0].key);
    expect(progressComparability(buildSessionHistory(cohort)).contextDiffers).toBe(false);
    expect(progressComparability(buildSessionHistory(sessions)).contextDiffers).toBe(true);
  });
});
