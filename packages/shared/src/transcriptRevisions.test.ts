import { describe, expect, test } from "bun:test";

import { fallbackAnalyze, type TranscriptSegment } from "./index";
import { createSessionRecord, observationFingerprint } from "./sessions";
import {
  applyLiveTranscriptUpdate,
  type LiveTranscriptUpdate,
  liveTranscriptPartialText,
  liveTranscriptSegments,
  markUnalignedTiming,
  reconcileTranscripts,
  referenceTranscriptModels,
  reviseTranscript,
  sessionTranscriptRevisions,
  startLiveTranscript,
  transcriptObservationIds,
  transcriptProvenance,
} from "./transcriptRevisions";

const final = (text: string, startSeconds: number, endSeconds = startSeconds + 1) => ({
  text,
  startSeconds,
  endSeconds,
  isFinal: true,
});

function replay(runId: string, updates: LiveTranscriptUpdate[]) {
  return updates.reduce(applyLiveTranscriptUpdate, startLiveTranscript(runId));
}

describe("live partial-to-final identity", () => {
  test("a late partial after its final never reappears", () => {
    const state = replay("run-a", [
      { kind: "partial", runId: "run-a", unitId: "0", sequence: 1, text: "I I" },
      { kind: "final", runId: "run-a", unitId: "0", segments: [final("I I want", 0)] },
      { kind: "partial", runId: "run-a", unitId: "0", sequence: 2, text: "I I wa" },
    ]);
    expect(liveTranscriptSegments(state).map((segment) => segment.text)).toEqual(["I I want"]);
    expect(liveTranscriptPartialText(state)).toBe("");
  });

  test("an out-of-order partial does not overwrite newer interim text", () => {
    const state = replay("run-a", [
      { kind: "partial", runId: "run-a", unitId: "1", sequence: 3, text: "b-b-but the" },
      { kind: "partial", runId: "run-a", unitId: "1", sequence: 2, text: "b-b" },
    ]);
    expect(liveTranscriptPartialText(state)).toBe("b-b-but the");
  });

  test("cancellation drops pending partials and ignores everything after it", () => {
    const state = replay("run-a", [
      { kind: "final", runId: "run-a", unitId: "0", segments: [final("kept", 0)] },
      { kind: "partial", runId: "run-a", unitId: "1", sequence: 1, text: "pending" },
      { kind: "cancel", runId: "run-a" },
      { kind: "final", runId: "run-a", unitId: "1", segments: [final("too late", 1)] },
      { kind: "partial", runId: "run-a", unitId: "2", sequence: 1, text: "also late" },
    ]);
    expect(liveTranscriptSegments(state).map((segment) => segment.text)).toEqual(["kept"]);
    expect(liveTranscriptPartialText(state)).toBe("");
  });

  test("results of recording A never land in recording B (selection race)", () => {
    let state = startLiveTranscript("file-a");
    state = applyLiveTranscriptUpdate(state, {
      kind: "final",
      runId: "file-a",
      unitId: "chunk:1",
      segments: [final("file a", 0)],
    });
    // The user selects file B while A's second chunk is still being transcribed.
    state = startLiveTranscript("file-b");
    const lateA = applyLiveTranscriptUpdate(state, {
      kind: "final",
      runId: "file-a",
      unitId: "chunk:2",
      segments: [final("file a late", 8)],
    });
    expect(lateA).toBe(state);
    state = applyLiveTranscriptUpdate(state, {
      kind: "final",
      runId: "file-b",
      unitId: "chunk:1",
      segments: [final("file b", 0)],
    });
    expect(liveTranscriptSegments(state).map((segment) => segment.text)).toEqual(["file b"]);
  });

  test("repeated finalization adds no duplicate tokens or events", () => {
    const once = replay("run-a", [
      { kind: "final", runId: "run-a", unitId: "0", segments: [final("I I want um water", 0, 3)] },
    ]);
    const repeated = [
      { kind: "final", runId: "run-a", unitId: "0", segments: [final("I I want um water", 0, 3)] },
      // A redelivered final with different text (e.g. after a recognizer restart) is ignored too.
      { kind: "final", runId: "run-a", unitId: "0", segments: [final("I want water", 0, 3)] },
    ] satisfies LiveTranscriptUpdate[];
    const twice = repeated.reduce(applyLiveTranscriptUpdate, once);
    expect(twice).toBe(once);
    const analyze = (segments: TranscriptSegment[]) => fallbackAnalyze({ segments, pauses: [] });
    expect(liveTranscriptSegments(twice)).toEqual(liveTranscriptSegments(once));
    expect(analyze(liveTranscriptSegments(twice)).events).toEqual(
      analyze(liveTranscriptSegments(once)).events,
    );
    expect(analyze(liveTranscriptSegments(twice)).wordCount).toBe(4);
  });

  test("chunks finalized out of order are ordered by time", () => {
    const state = replay("run-a", [
      { kind: "final", runId: "run-a", unitId: "chunk:2", segments: [final("second", 8)] },
      { kind: "final", runId: "run-a", unitId: "chunk:1", segments: [final("first", 0)] },
    ]);
    expect(liveTranscriptSegments(state).map((segment) => segment.text)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("unaligned spans", () => {
  test("an unaligned segment produces no prolongation timing", () => {
    const aligned = fallbackAnalyze({ segments: [final("sssso far", 0, 2)], pauses: [] });
    expect(aligned.events.map((event) => event.kind)).toContain("prolongation");
    const unaligned = fallbackAnalyze({
      segments: [{ ...final("sssso far", 0, 2), alignment: "unaligned" }],
      pauses: [],
    });
    expect(unaligned.events.map((event) => event.kind)).not.toContain("prolongation");
  });

  test("segments without usable timing are marked unaligned", () => {
    const [kept, zero] = markUnalignedTiming([final("a", 0, 1), final("b", 2, 2)]);
    expect(kept.alignment).toBeUndefined();
    expect(zero.alignment).toBe("unaligned");
  });

  test("the alignment mark is part of the observation, and absent marks keep old fingerprints", () => {
    const plain = [final("a", 0, 1)];
    expect(observationFingerprint(plain, [])).toBe(observationFingerprint([{ ...plain[0] }], []));
    expect(observationFingerprint([{ ...plain[0], alignment: "unaligned" }], [])).not.toBe(
      observationFingerprint(plain, []),
    );
  });
});

describe("provenance", () => {
  const preprocessing = { captureSampleRate: 48000, modelSampleRate: 16000, chunkSeconds: 8 };

  test("records honest limitations", () => {
    expect(
      transcriptProvenance({
        engine: "browser",
        model: "default",
        language: "en-US",
        preprocessing,
      }).limitations,
    ).toEqual(["noTiming", "recognizerAudioUnknown"]);
    expect(
      transcriptProvenance({
        engine: "whisperCpp",
        model: "base.en",
        language: "de-DE",
        detectedLanguage: "en",
        preprocessing,
      }).limitations,
    ).toEqual(["englishOnlyModel", "languageMismatch"]);
    expect(
      transcriptProvenance({
        engine: "whisperCpp",
        model: "small",
        language: "de-DE",
        preprocessing,
      }).limitations,
    ).toEqual([]);
  });

  test("reference models are larger whisper.cpp models suited to the language", () => {
    expect(referenceTranscriptModels({ engine: "whisperCpp", model: "small.en" }, "en-US")).toEqual(
      ["medium.en", "medium", "large-v3-turbo", "large-v3"],
    );
    expect(referenceTranscriptModels({ engine: "browser", model: "default" }, "de-DE")).toEqual([
      "tiny",
      "base",
      "small",
      "medium",
      "large-v3-turbo",
      "large-v3",
    ]);
    expect(referenceTranscriptModels({ engine: "whisperCpp", model: "large-v3" }, "en-US")).toEqual(
      [],
    );
  });
});

describe("transcript revisions and reconciliation", () => {
  const provisional = [final("I I w-want water", 0, 2), final("um yes", 2, 3)];
  const reference = [final("I I I w-want wa- water", 0, 2.2), final("yes", 2.4, 3)];
  const record = createSessionRecord({
    id: "s1",
    startedAt: "2026-10-25T10:00:00.000Z",
    segments: provisional,
    pauses: [],
    report: fallbackAnalyze({ segments: provisional, pauses: [] }),
    run: { id: "run-1", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
  });
  const provenance = transcriptProvenance({
    engine: "whisperCpp",
    model: "large-v3-turbo",
    language: "en-US",
    preprocessing: { captureSampleRate: 16000, modelSampleRate: 16000, chunkSeconds: 30 },
  });

  test("reconciliation counts unchanged, substituted, inserted and deleted words", () => {
    const { operations, counts } = reconcileTranscripts(provisional, reference);
    expect(counts).toEqual({
      unchangedWords: 5,
      substitutedWords: 0,
      insertedWords: 2,
      deletedWords: 1,
    });
    expect(operations).toEqual([
      { op: "equal", words: ["I", "I"] },
      { op: "insert", words: ["I"] },
      { op: "equal", words: ["w-want"] },
      { op: "insert", words: ["wa-"] },
      { op: "equal", words: ["water"] },
      { op: "delete", words: ["um"] },
      { op: "equal", words: ["yes"] },
    ]);
    expect(reconcileTranscripts([final("the cat", 0)], [final("The bat", 0)]).operations).toEqual([
      { op: "equal", words: ["The"] },
      { op: "replace", before: ["cat"], after: ["bat"] },
    ]);
  });

  test("a reference revision becomes current and keeps the provisional one", () => {
    const revised = reviseTranscript(
      record,
      { id: "ref-1", createdAt: "2026-10-25T10:05:00.000Z", kind: "reference", provenance },
      reference,
    );
    expect(revised.segments).toEqual(reference);
    expect(revised.transcript).toMatchObject({
      id: "ref-1",
      kind: "reference",
      supersedes: "s1:transcript",
      reconciliation: { against: "s1:transcript", unchangedWords: 5, insertedWords: 2 },
    });
    const revisions = sessionTranscriptRevisions(revised);
    expect(revisions.map((revision) => [revision.kind, revision.segments])).toEqual([
      ["provisional", provisional],
      ["reference", reference],
    ]);
    // The analysis still names the provisional observation, so it reads as unverified.
    expect(revised.analysis).toEqual(record.analysis);
    expect(transcriptObservationIds(revised)).toEqual([
      observationFingerprint(provisional, []),
      observationFingerprint(reference, []),
    ]);
    expect(() =>
      reviseTranscript(
        revised,
        { id: "ref-1", createdAt: "2026-10-25T10:06:00.000Z", kind: "reference", provenance },
        reference,
      ),
    ).toThrow(/already recorded/);
  });
});
