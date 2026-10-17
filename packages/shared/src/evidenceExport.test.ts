import { describe, expect, test } from "bun:test";

import {
  buildEvidenceExport,
  EVIDENCE_EXPORT_VERSION,
  renderEvidenceReport,
  transcriptSpeakersOf,
} from "./evidenceExport";
import { fallbackAnalyze } from "./index";
import { annotateSession, createSessionRecord, type SessionRecord } from "./sessions";

function session(id: string, startedAt: string, texts: [string, string, string][]): SessionRecord {
  const segments = texts.map(([text, speakerId, speakerLabel], index) => ({
    text,
    startSeconds: index * 2,
    endSeconds: index * 2 + 1.5,
    isFinal: true,
    speakerId,
    speakerLabel,
  }));
  return createSessionRecord({
    id,
    startedAt,
    segments,
    pauses: [],
    report: fallbackAnalyze({ segments, pauses: [] }),
    run: {
      id: `${id}-run`,
      createdAt: startedAt,
      analyzer: { producer: "onDevice", algorithm: "shared-fallback", version: "1" },
      usedAudio: false,
      audioId: null,
    },
    context: { spokenLanguage: "en", task: { kind: "reading", trained: false }, condition: null },
    recordings: [
      {
        sessionId: id,
        runId: `${id}-capture`,
        origin: "browser",
        role: "appInput",
        sampleRate: 48_000,
        channelCount: 1,
        deviceRoute: "Secret Headset Model",
        startOffsetSeconds: 0,
        preprocessing: {
          echoCancellation: { requested: true },
          noiseSuppression: { requested: true },
          autoGainControl: { requested: false },
        },
        discontinuities: [],
        speakerAssessment: "unknown",
      },
    ],
  });
}

const chosen = session("internal-chosen-id", "2026-10-01T09:00:00.000Z", [
  ["I I want to order", "me", "Robin Private"],
  ["What would you like", "barista", "Cafe Staffer"],
]);
const excluded = session("internal-excluded-id", "2026-10-02T09:00:00.000Z", [
  ["Excluded secret sentence", "me", "Robin Private"],
]);
const all = [chosen, excluded];
const exportedAt = new Date("2026-10-08T12:00:00.000Z");

describe("evidence export", () => {
  test("includes only the selected sessions and never internal ids, voiceprints or devices", () => {
    const evidence = buildEvidenceExport(all, {
      sessionIds: [chosen.id],
      includeTranscripts: true,
      transcriptSpeakers: "all",
      includeSpeakerNames: true,
      exportedAt,
    });
    const json = JSON.stringify(evidence);

    expect(evidence.version).toBe(EVIDENCE_EXPORT_VERSION);
    expect(evidence.sessions.map((item) => item.ref)).toEqual(["S1"]);
    for (const leaked of [
      "internal-chosen-id",
      "internal-excluded-id",
      "Excluded secret sentence",
      "Secret Headset Model",
      '"embeddings"',
      '"severity"',
      '"audioId"',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  test("redacts transcripts, speaker names and unselected speakers on request", () => {
    const noTranscript = JSON.stringify(
      buildEvidenceExport(all, {
        sessionIds: [chosen.id],
        includeTranscripts: false,
        transcriptSpeakers: "all",
        includeSpeakerNames: true,
        exportedAt,
      }),
    );
    expect(noTranscript).not.toContain("I I want to order");
    expect(noTranscript).not.toContain("Robin Private");

    const pseudonymous = buildEvidenceExport(all, {
      sessionIds: [chosen.id],
      includeTranscripts: true,
      transcriptSpeakers: ["id:me"],
      includeSpeakerNames: false,
      exportedAt,
    });
    const json = JSON.stringify(pseudonymous);
    expect(pseudonymous.sessions[0].transcript).toEqual([
      { speaker: "Speaker 1", startSeconds: 0, endSeconds: 1.5, text: "I I want to order" },
    ]);
    expect(json).not.toContain("Robin Private");
    expect(json).not.toContain("Cafe Staffer");
    expect(json).not.toContain("What would you like");
  });

  test("lists the speakers present in the selection for the preview", () => {
    expect(transcriptSpeakersOf([chosen])).toEqual([
      { id: "id:me", label: "Robin Private" },
      { id: "id:barista", label: "Cafe Staffer" },
    ]);
  });

  test("keeps automated estimates, denominators and human references distinct", () => {
    const reviewed = annotateSession(chosen, {
      id: "ann-1",
      createdAt: "2026-10-03T10:00:00.000Z",
      author: { role: "clinician" },
      basedOnRunId: null,
      events: [
        { kind: "wordRepetition", startSeconds: 0, endSeconds: 0.5, certainty: "certain" },
        { kind: "block", startSeconds: 1, endSeconds: 1.4, certainty: "possible" },
        // Span conditions are not disfluency events and are not counted.
        { kind: "noSpeech", startSeconds: 2, endSeconds: 3, certainty: "certain" },
        { kind: "unusable", startSeconds: 3, endSeconds: 4, certainty: "possible" },
      ],
      status: "accepted",
      supersedes: null,
    });
    const [item] = buildEvidenceExport([reviewed], {
      sessionIds: [reviewed.id],
      includeTranscripts: false,
      transcriptSpeakers: "all",
      includeSpeakerNames: false,
      exportedAt,
    }).sessions;

    expect(item.sample.durationSeconds).toBeGreaterThan(0);
    expect(item.automatedEstimate.eventsPerMinute).toBe(reviewed.report.stuttersPerMinute);
    expect(item.automatedEstimate.verifiedForSavedSession).toBe(true);
    expect(item.automatedEstimate.analyzer).toBe("onDevice:shared-fallback:1");
    expect(item.humanReference).toEqual({
      authorRole: "clinician",
      annotatedAt: "2026-10-03T10:00:00.000Z",
      eventCount: 1,
      possibleEventCount: 1,
    });
  });

  test("renders a readable report without diagnostic or improvement claims", () => {
    const report = renderEvidenceReport(
      buildEvidenceExport(all, {
        sessionIds: [chosen.id, excluded.id],
        includeTranscripts: false,
        transcriptSpeakers: "all",
        includeSpeakerNames: false,
        exportedAt,
      }),
    );
    expect(report).toContain("Automated estimate (model, not a judgment)");
    expect(report).toContain("Human reference: none");
    expect(report).toContain("not a diagnosis");
    expect(report).toContain("a single change is not evidence of improvement");
    expect(report.toLowerCase()).not.toMatch(/severity: |cured|improved by/);
  });

  test("states each session's capture quality and withholds an unknown-quality estimate", () => {
    const clipped: SessionRecord = {
      ...chosen,
      report: {
        ...chosen.report,
        captureQuality: {
          state: "unknown",
          issues: ["clipping"],
          explanation: "Result unknown: the input is clipping (too loud).",
          coverage: { measuredSeconds: 90, captureSeconds: 600 },
        },
      },
    };
    const usable: SessionRecord = {
      ...excluded,
      report: { ...excluded.report, captureQuality: { state: "usable", issues: [] } },
    };
    const evidence = buildEvidenceExport([clipped, usable], {
      sessionIds: [clipped.id, usable.id],
      includeTranscripts: false,
      transcriptSpeakers: "all",
      includeSpeakerNames: false,
      exportedAt,
    });
    const [first, second] = evidence.sessions;
    expect(first.captureQuality).toEqual({
      state: "unknown",
      issues: ["clipping"],
      explanation: "Result unknown: the input is clipping (too loud).",
      coverage: { measuredSeconds: 90, captureSeconds: 600 },
    });
    // The JSON keeps the estimate, qualified by the verdict next to it.
    expect(first.automatedEstimate.eventCount).toBe(clipped.report.stutterCount);
    expect(second.captureQuality).toEqual({
      state: "usable",
      issues: [],
      explanation: null,
      coverage: null,
    });
    const legacy = buildEvidenceExport([chosen], {
      sessionIds: [chosen.id],
      includeTranscripts: false,
      transcriptSpeakers: "all",
      includeSpeakerNames: false,
      exportedAt,
    }).sessions[0];
    expect(legacy.captureQuality.state).toBe("not recorded");

    const report = renderEvidenceReport(evidence);
    expect(report).toContain(
      "Capture quality: unknown (Result unknown: the input is clipping (too loud).). Capture quality was checked for the last 1 min 30 s of 10 min of recorded audio; earlier audio was not checked.",
    );
    expect(report).toContain(
      "Automated estimate: withheld, because the capture quality is unknown",
    );
    expect(report).toContain("Capture quality: usable");
    expect(report.match(/Automated estimate \(model, not a judgment\)/g)).toHaveLength(1);
  });

  test("keeps trained-task and aid settings, orders by instant, and marks filtered transcripts", () => {
    const practised = {
      ...session("p", "2026-01-01T01:00:00+02:00", [["Hello there", "me", "Robin"]]),
      context: {
        spokenLanguage: "en",
        task: { kind: "reading" as const, trained: true },
        condition: { kind: "assisted" as const, aidId: "daf", settings: { delayMs: 80 } },
      },
    };
    const later = session("l", "2025-12-31T23:30:00Z", [
      ["Later words", "me", "Robin"],
      ["Other words", "friend", "Kim"],
    ]);
    const evidence = buildEvidenceExport([later, practised], {
      sessionIds: ["p", "l"],
      includeTranscripts: true,
      transcriptSpeakers: ["id:me"],
      includeSpeakerNames: true,
      exportedAt,
    });

    expect(evidence.sessions.map((item) => item.startedAt)).toEqual([
      "2026-01-01T01:00:00+02:00",
      "2025-12-31T23:30:00Z",
    ]);
    expect(evidence.sessions[0].context).toMatchObject({
      trainedTask: true,
      condition: "assisted",
      aid: "daf",
      aidSettings: { delayMs: 80 },
    });
    expect(evidence.included.transcriptSpeakers).toBe("selected");
    const report = renderEvidenceReport(evidence);
    expect(report).toContain("task reading (practised)");
    expect(report).toContain("assisted (daf; delayMs 80)");
    expect(report).toContain(
      "only the selected speakers' words; other speakers removed; the counts above still cover all speakers",
    );
  });

  test("names unlabeled speakers distinctly and drops speaker metadata without transcripts", () => {
    const unlabeled = createSessionRecord({
      id: "u",
      startedAt: "2026-10-01T09:00:00.000Z",
      segments: [
        { text: "First", startSeconds: 0, endSeconds: 1, isFinal: true, speakerId: "x" },
        { text: "Second", startSeconds: 1, endSeconds: 2, isFinal: true, speakerId: "y" },
      ],
      pauses: [],
      report: fallbackAnalyze({ segments: [], pauses: [] }),
      run: { id: "r", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    });
    const named = buildEvidenceExport([unlabeled], {
      sessionIds: ["u"],
      includeTranscripts: true,
      transcriptSpeakers: "all",
      includeSpeakerNames: true,
      exportedAt,
    });
    expect(named.sessions[0].transcript?.map((line) => line.speaker)).toEqual([
      "Speaker 1",
      "Speaker 2",
    ]);

    const withoutTranscripts = buildEvidenceExport([unlabeled], {
      sessionIds: ["u"],
      includeTranscripts: false,
      transcriptSpeakers: ["id:x"],
      includeSpeakerNames: true,
      exportedAt,
    });
    expect(withoutTranscripts.included).toEqual({
      transcripts: false,
      speakerNames: false,
      transcriptSpeakers: null,
    });
  });

  test("keeps label-only speakers separately selectable and indents multiline text", () => {
    const labelOnly = createSessionRecord({
      id: "lo",
      startedAt: "2026-10-01T09:00:00.000Z",
      segments: [
        { text: "Mine", startSeconds: 0, endSeconds: 1, isFinal: true, speakerLabel: "Robin" },
        { text: "Not mine", startSeconds: 1, endSeconds: 2, isFinal: true, speakerLabel: "Kim" },
        {
          text: "hello\nS2 · fake metric",
          startSeconds: 2,
          endSeconds: 3,
          isFinal: true,
          speakerLabel: "Robin",
        },
      ],
      pauses: [],
      report: fallbackAnalyze({ segments: [], pauses: [] }),
      run: { id: "r", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    });
    expect(transcriptSpeakersOf([labelOnly])).toEqual([
      { id: "label:lo:Robin", label: "Robin" },
      { id: "label:lo:Kim", label: "Kim" },
    ]);
    const evidence = buildEvidenceExport([labelOnly], {
      sessionIds: ["lo"],
      includeTranscripts: true,
      transcriptSpeakers: ["label:lo:Robin"],
      includeSpeakerNames: true,
      exportedAt,
    });
    expect(JSON.stringify(evidence)).not.toContain("Not mine");
    const report = renderEvidenceReport(evidence);
    expect(report).toContain("    [2.0s] Robin: hello\n      S2 · fake metric");
    expect(report.split("\n").some((line) => line.startsWith("S2 ·"))).toBe(false);
  });

  test("keeps one name per speaker when labels are sparse and exports task descriptions", () => {
    const sparse = createSessionRecord({
      id: "sp",
      startedAt: "2026-10-01T09:00:00.000Z",
      segments: [
        { text: "One", startSeconds: 0, endSeconds: 1, isFinal: true, speakerId: "me" },
        {
          text: "Two",
          startSeconds: 1,
          endSeconds: 2,
          isFinal: true,
          speakerId: "me",
          speakerLabel: "Robin",
        },
      ],
      pauses: [],
      report: fallbackAnalyze({ segments: [], pauses: [] }),
      run: { id: "r", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
      context: {
        spokenLanguage: "en",
        task: { kind: "other", trained: false, description: "Ordering at a cafe" },
        condition: null,
      },
    });
    const evidence = buildEvidenceExport([sparse], {
      sessionIds: ["sp"],
      includeTranscripts: true,
      transcriptSpeakers: "all",
      includeSpeakerNames: true,
      exportedAt,
    });
    expect(evidence.sessions[0].transcript?.map((line) => line.speaker)).toEqual([
      "Robin",
      "Robin",
    ]);
    expect(evidence.sessions[0].context.taskDescription).toBe("Ordering at a cafe");
    expect(renderEvidenceReport(evidence)).toContain(
      'task other ("Ordering at a cafe", not practised)',
    );
  });

  test("never merges an id with a label or the fallback group, and folds context line breaks", () => {
    const tricky = createSessionRecord({
      id: "t",
      startedAt: "2026-10-01T09:00:00.000Z",
      segments: [
        { text: "By id", startSeconds: 0, endSeconds: 1, isFinal: true, speakerId: "label:Kim" },
        { text: "By label", startSeconds: 1, endSeconds: 2, isFinal: true, speakerLabel: "Kim" },
        {
          text: "By group id",
          startSeconds: 2,
          endSeconds: 3,
          isFinal: true,
          speakerId: "unattributed",
        },
        { text: "Nobody", startSeconds: 3, endSeconds: 4, isFinal: true },
      ],
      pauses: [],
      report: fallbackAnalyze({ segments: [], pauses: [] }),
      run: { id: "r", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
      context: {
        spokenLanguage: "en",
        task: null,
        condition: { kind: "assisted", aidId: "daf\n  Human reference: none" },
      },
    });
    expect(transcriptSpeakersOf([tricky]).map((speaker) => speaker.id)).toEqual([
      "id:label:Kim",
      "label:t:Kim",
      "id:unattributed",
      "unattributed:t",
    ]);
    const report = renderEvidenceReport(
      buildEvidenceExport([tricky], {
        sessionIds: ["t"],
        includeTranscripts: false,
        transcriptSpeakers: "all",
        includeSpeakerNames: false,
        exportedAt,
      }),
    );
    expect(report.split("\n").filter((line) => line.trim().startsWith("Human reference"))).toEqual([
      "  Human reference: none",
    ]);
  });

  test("scopes label-only speakers per session, lists only exportable segments, folds every line break", () => {
    const guestSession = (id: string, startedAt: string, text: string) =>
      createSessionRecord({
        id,
        startedAt,
        segments: [
          { text, startSeconds: 0, endSeconds: 1, isFinal: true, speakerLabel: "Guest" },
          { text: "  ", startSeconds: 1, endSeconds: 2, isFinal: true, speakerLabel: "Silent" },
          {
            text: "interim",
            startSeconds: 2,
            endSeconds: 3,
            isFinal: false,
            speakerLabel: "Draft",
          },
        ],
        pauses: [],
        report: fallbackAnalyze({ segments: [], pauses: [] }),
        run: { id: `${id}-r`, createdAt: null, analyzer: null, usedAudio: null, audioId: null },
      });
    const first = guestSession("g1", "2026-10-01T09:00:00.000Z", "hello\rZ9 · fake\u2028tail");
    const second = guestSession("g2", "2026-10-02T09:00:00.000Z", "Other guest");
    expect(transcriptSpeakersOf([first, second])).toEqual([
      { id: "label:g1:Guest", label: "Guest (Speaker 1)" },
      { id: "label:g2:Guest", label: "Guest (Speaker 2)" },
    ]);
    const evidence = buildEvidenceExport([first, second], {
      sessionIds: ["g1", "g2"],
      includeTranscripts: true,
      transcriptSpeakers: ["label:g1:Guest"],
      includeSpeakerNames: true,
      exportedAt,
    });
    expect(JSON.stringify(evidence)).not.toContain("Other guest");
    const lines = renderEvidenceReport(evidence).split(/\r\n|[\n\r\u2028\u2029]/);
    expect(lines.some((line) => line.startsWith("Z9 ·") || line.startsWith("tail"))).toBe(false);
    expect(lines).toContain("      Z9 · fake");
  });
});

describe("review regressions", () => {
  test("keeps delimiter-containing session and speaker labels independently selectable", () => {
    const first = session("a", chosen.startedAt, [["First", "", "b:c"]]);
    const second = session("a:b", excluded.startedAt, [["Second", "", "c"]]);
    const speakers = transcriptSpeakersOf([first, second]);
    expect(speakers[0]?.id).not.toBe(speakers[1]?.id);
    const evidence = buildEvidenceExport([first, second], {
      sessionIds: [first.id, second.id],
      includeTranscripts: true,
      transcriptSpeakers: [speakers[0]!.id],
      includeSpeakerNames: true,
      exportedAt,
    });
    expect(evidence.sessions[0]?.transcript?.map((segment) => segment.text)).toEqual(["First"]);
    expect(evidence.sessions[1]?.transcript).toEqual([]);
  });

  test("speaker controls resolve labels that appear after an unlabeled segment", () => {
    const sparse = session("sparse", chosen.startedAt, [
      ["Hello", "me", ""],
      ["Again", "me", "Robin"],
    ]);
    delete sparse.segments[0]!.speakerLabel;
    expect(transcriptSpeakersOf([sparse])).toEqual([{ id: "id:me", label: "Robin" }]);
  });

  test("report marks only transcripts with removed words as filtered", () => {
    const evidence = buildEvidenceExport(all, {
      sessionIds: all.map((item) => item.id),
      includeTranscripts: true,
      transcriptSpeakers: ["id:me"],
      includeSpeakerNames: true,
      exportedAt,
    });
    const report = renderEvidenceReport(evidence);
    expect(report.split("other speakers removed")).toHaveLength(2);
    expect(report.split("S2 ·")[1]).toContain("  Transcript:\n");
  });

  test("report folds analyzer metadata line breaks", () => {
    const evidence = buildEvidenceExport([chosen], {
      sessionIds: [chosen.id],
      includeTranscripts: false,
      transcriptSpeakers: "all",
      includeSpeakerNames: false,
      exportedAt,
    });
    evidence.sessions[0]!.automatedEstimate.analyzer = "model\n  Human reference: forged";
    expect(renderEvidenceReport(evidence)).not.toContain("\n  Human reference: forged");
  });
});

test("preserves the stored automated rate for sub-second and restored sessions", () => {
  const short = session("short", chosen.startedAt, [["I I", "me", "Robin"]]);
  short.report.totalDurationSeconds = 0.5;
  short.report.stutterCount = 1;
  short.report.stuttersPerMinute = 60;
  const options = {
    sessionIds: [short.id],
    includeTranscripts: false,
    transcriptSpeakers: "all" as const,
    includeSpeakerNames: false,
    exportedAt,
  };
  expect(buildEvidenceExport([short], options).sessions[0]?.automatedEstimate.eventsPerMinute).toBe(
    60,
  );
  short.report.stuttersPerMinute = 17.25;
  expect(buildEvidenceExport([short], options).sessions[0]?.automatedEstimate.eventsPerMinute).toBe(
    17.25,
  );
});

test("distinguishes speakers with the same saved label in controls and named exports", () => {
  const saved = session("same-labels", chosen.startedAt, [
    ["first", "a", "Alex"],
    ["second", "b", "Alex"],
  ]);
  const controls = transcriptSpeakersOf([saved]);
  expect(new Set(controls.map((item) => item.label)).size).toBe(2);
  const evidence = buildEvidenceExport([saved], {
    sessionIds: [saved.id],
    includeTranscripts: true,
    transcriptSpeakers: "all",
    includeSpeakerNames: true,
    exportedAt,
  });
  expect(evidence.sessions[0]?.transcript?.map((item) => item.speaker)).toEqual(
    controls.map((item) => item.label),
  );
});

test("folds restored timestamp lines in report headings", () => {
  const saved = { ...chosen, startedAt: "2026-10-01\nInjected heading" };
  const evidence = buildEvidenceExport([saved], {
    sessionIds: [saved.id],
    includeTranscripts: false,
    transcriptSpeakers: "all",
    includeSpeakerNames: false,
    exportedAt,
  });
  const reference = {
    authorRole: "clinician" as const,
    annotatedAt: "2026-10-01\nInjected reference",
    eventCount: 1,
    possibleEventCount: 0,
  };
  evidence.sessions[0]!.humanReference = reference;
  const report = renderEvidenceReport(evidence);
  expect(report).not.toContain("\nInjected");
  expect(report).toContain("2026-10-01 Injected heading");
  expect(report).toContain("2026-10-01 Injected reference");
});

test("normalizes blank labels and reserves saved names against pseudonyms", () => {
  const saved = session("blank-labels", chosen.startedAt, [
    ["named", "a", "Speaker 1"],
    ["unnamed", "b", "   "],
  ]);
  const evidence = buildEvidenceExport([saved], {
    sessionIds: [saved.id],
    includeTranscripts: true,
    transcriptSpeakers: "all",
    includeSpeakerNames: true,
    exportedAt,
  });
  expect(evidence.sessions[0]?.transcript?.map((item) => item.speaker)).toEqual([
    "Speaker 1",
    "Speaker 2",
  ]);
  expect(transcriptSpeakersOf([saved]).every((item) => item.label.trim().length > 0)).toBe(true);
});

test("shared display names distinguish raw-ID collisions and whitespace-only IDs", () => {
  const saved = session("restored-ids", chosen.startedAt, [
    ["unnamed", "Alex", ""],
    ["named", "other", "Alex"],
    ["separate", " Alex ", "Different person"],
    ["Robin words", " ", "Robin"],
    ["Kim words", " ", "Kim"],
  ]);
  const controls = transcriptSpeakersOf([saved]);
  expect(new Set(controls.map((item) => item.id)).size).toBe(5);
  expect(new Set(controls.map((item) => item.label)).size).toBe(5);
  expect(controls.map((item) => item.id)).toContain("id: Alex ");
  const evidence = buildEvidenceExport([saved], {
    sessionIds: [saved.id],
    includeTranscripts: true,
    transcriptSpeakers: "all",
    includeSpeakerNames: true,
    exportedAt,
  });
  expect(evidence.sessions[0]?.transcript?.map((item) => item.speaker)).toEqual(
    controls.map((item) => item.label),
  );
});
