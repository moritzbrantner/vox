import { describe, expect, test } from "bun:test";

import { compareSessions } from "./comparison";
import { fallbackAnalyze } from "./index";
import {
  type AnnotatedEvent,
  annotateSession,
  migrateSessionRecord,
  type SessionRecord,
  tagSessionContext,
} from "./sessions";

const reading = { kind: "reading" as const, trained: false };

function session(
  id: string,
  speakingSeconds: number,
  events: AnnotatedEvent[],
  language = "en",
): SessionRecord {
  const segments = [
    {
      text: "words ".repeat(20).trim(),
      startSeconds: 0,
      endSeconds: speakingSeconds,
      isFinal: true,
    },
  ];
  const base = migrateSessionRecord({
    id,
    startedAt: "2026-10-17T10:00:00.000Z",
    segments,
    pauses: [],
    report: fallbackAnalyze({ segments, pauses: [] }),
  });
  const tagged = tagSessionContext(base, {
    task: reading,
    condition: { kind: "unassisted" },
    spokenLanguage: language,
  });
  return annotateSession(tagged, {
    id: `${id}-ref`,
    createdAt: "2026-10-17T11:00:00.000Z",
    author: { role: "clinician", id: "SLT" },
    basedOnRunId: null,
    events,
    status: "accepted",
    supersedes: null,
  });
}

const event = (
  start: number,
  end: number,
  kind: AnnotatedEvent["kind"] = "block",
  certainty: AnnotatedEvent["certainty"] = "certain",
) => ({
  kind,
  startSeconds: start,
  endSeconds: end,
  certainty,
});

describe("matched session comparison", () => {
  test("compares reviewed events per speaking minute, durations and fillers separately", () => {
    const first = session("a", 60, [
      event(1, 2),
      event(5, 5.5),
      event(9, 12, "prolongation", "possible"),
      event(20, 20.3, "filler"),
      event(30, 40, "noSpeech"),
    ]);
    const second = session("b", 60, [event(3, 3.4)]);
    const result = compareSessions(first, second);
    expect(result.comparable).toBe(true);
    if (!result.comparable) return;
    expect(result.first).toMatchObject({
      events: 3,
      possibleEvents: 1,
      fillers: 1,
      eventsPerSpeakingMinute: 3,
      medianEventSeconds: 1,
      longestEventSeconds: 3,
      condition: "unassisted",
      reviewedBy: "SLT (clinician)",
    });
    expect(result.second.eventsPerSpeakingMinute).toBe(1);
    expect(result).toMatchObject({
      language: "en",
      task: "reading (not practised)",
      verdict: "lower",
    });
    expect(result.limitations.at(-1)).toContain("not evidence of treatment effect");
  });

  test("fewer events while speaking much less is mixed, not an improvement", () => {
    const first = session("a", 60, [event(1, 2), event(5, 6), event(9, 10), event(13, 14)]);
    const second = session("b", 20, [event(1, 1.5)]);
    const result = compareSessions(first, second);
    expect(result.comparable && result.verdict).toBe("mixed");
    expect(
      compareSessions(session("a", 60, []), session("b", 60, [])).comparable && "noEvents",
    ).toBe("noEvents");
    const close = compareSessions(
      session("a", 60, [
        event(1, 2),
        event(3, 4),
        event(5, 6),
        event(7, 8),
        event(9, 10),
        event(11, 12),
        event(13, 14),
        event(15, 16),
        event(17, 18),
        event(19, 20),
      ]),
      session("b", 60, [
        event(1, 2),
        event(3, 4),
        event(5, 6),
        event(7, 8),
        event(9, 10),
        event(11, 12),
        event(13, 14),
        event(15, 16),
        event(17, 18),
      ]),
    );
    expect(close.comparable && close.verdict).toBe("unchanged");
  });

  test("refuses unmatched pairs and says why", () => {
    const english = session("a", 60, []);
    const german = session("b", 60, [], "de");
    expect(compareSessions(english, german)).toEqual({
      comparable: false,
      reasons: ["they are in different languages (en and de)"],
    });
    const otherTask = tagSessionContext(session("c", 60, []), {
      task: { kind: "conversation", trained: false },
      condition: null,
    });
    expect(compareSessions(english, otherTask)).toMatchObject({
      comparable: false,
      reasons: [expect.stringContaining("different speaking tasks")],
    });
    const unreviewed = { ...session("d", 60, []), annotations: [] };
    expect(compareSessions(english, unreviewed)).toMatchObject({
      reasons: [expect.stringContaining("no reviewed labels")],
    });
    const withheld = {
      ...english,
      id: "e",
      report: {
        ...english.report,
        captureQuality: { state: "unknown" as const, issues: [], explanation: "" },
      },
    };
    expect(compareSessions(withheld, session("f", 60, []))).toMatchObject({
      reasons: [expect.stringContaining("capture-quality")],
    });
    expect(compareSessions(english, english)).toMatchObject({ comparable: false });
  });

  test("labels conditions and non-English languages as limitations", () => {
    const unassisted = session("a", 60, [event(1, 2)], "de");
    const assisted = tagSessionContext(session("b", 60, [event(1, 2)], "de"), {
      task: reading,
      condition: { kind: "assisted", aidId: "delayedAuditoryFeedback" },
    });
    const result = compareSessions(unassisted, assisted);
    expect(result.comparable && result.limitations.slice(0, 2)).toEqual([
      'Speech analysis is not prepared for "de" yet; only the reviewed labels are compared.',
      "Different assistance conditions: unassisted and assisted (delayedAuditoryFeedback).",
    ]);
  });
});

describe("session context tags", () => {
  test("tags task and condition, sets an unknown language once and never changes a recorded one", () => {
    const segments = [{ text: "hello", startSeconds: 0, endSeconds: 1, isFinal: true }];
    const legacy = migrateSessionRecord({
      id: "s",
      startedAt: "2026-10-17T10:00:00.000Z",
      segments,
      pauses: [],
      report: fallbackAnalyze({ segments, pauses: [] }),
    });
    const tagged = tagSessionContext(legacy, {
      task: reading,
      condition: { kind: "unassisted" },
      spokenLanguage: "en-GB",
    });
    expect(tagged.context).toEqual({
      spokenLanguage: "en",
      task: reading,
      condition: { kind: "unassisted" },
    });
    expect(tagged.segments).toBe(legacy.segments);
    expect(tagged.analysis).toBe(legacy.analysis);
    expect(() =>
      tagSessionContext(tagged, { task: null, condition: null, spokenLanguage: "de" }),
    ).toThrow("cannot be changed");
    expect(
      tagSessionContext(tagged, { task: null, condition: null, spokenLanguage: "en" }).context
        .spokenLanguage,
    ).toBe("en");
    expect(() =>
      tagSessionContext(tagged, { task: null, condition: { kind: "assisted", aidId: " " } }),
    ).toThrow("aid");
  });
});
