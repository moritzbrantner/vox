import { describe, expect, test } from "bun:test";

import { fallbackAnalyze } from "./index";
import { createSessionRecord, migrateSessionRecord, observationFingerprint } from "./sessions";
import { readableTranscript, verbatimTranscript } from "./transcriptText";

/**
 * Repetition-preservation fixtures: what a speaker actually said. Analysis must see these words
 * unchanged; only the display may tidy them.
 */
export const DISFLUENCY_FIXTURES = [
  { verbatim: "I I I want to go", readable: "I want to go", kinds: ["wordRepetition"] },
  // The shared fallback does not detect hyphenated sound repetitions yet (#27); the words survive.
  { verbatim: "b-b-but the train", readable: "but the train", kinds: [] },
  { verbatim: "um can I have wa- water", readable: "can I have water", kinds: ["filler"] },
  { verbatim: "w-want a well-known song", readable: "want a well-known song", kinds: [] },
  { verbatim: "sssso far so good", readable: "sssso far so good", kinds: ["prolongation"] },
] as const;

const segmentsOf = (text: string) => [{ text, startSeconds: 0, endSeconds: 3, isFinal: true }];

describe("verbatim and readable transcripts", () => {
  test.each(DISFLUENCY_FIXTURES)(
    "keeps '$verbatim' verbatim for analysis",
    ({ verbatim, readable, kinds }) => {
      const segments = segmentsOf(verbatim);
      expect(verbatimTranscript(segments)).toBe(verbatim);
      expect(readableTranscript(segments)).toBe(readable);
      const report = fallbackAnalyze({ segments, pauses: [] });
      for (const kind of kinds) {
        expect(report.events.map((event) => event.kind)).toContain(kind);
      }
    },
  );

  test("rendering the readable transcript changes neither the saved evidence nor its identity", () => {
    const segments = segmentsOf(DISFLUENCY_FIXTURES[0].verbatim);
    const record = createSessionRecord({
      id: "s",
      startedAt: "2026-10-17T10:00:00.000Z",
      segments,
      pauses: [],
      report: fallbackAnalyze({ segments, pauses: [] }),
      run: { id: "r", createdAt: null, analyzer: null, usedAudio: false, audioId: null },
    });
    const before = observationFingerprint(record.segments, record.pauses);
    readableTranscript(record.segments);
    const reloaded = migrateSessionRecord(JSON.parse(JSON.stringify(record)));
    expect(reloaded.segments[0].text).toBe("I I I want to go");
    expect(observationFingerprint(reloaded.segments, reloaded.pauses)).toBe(before);
  });
});
