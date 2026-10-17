import { describe, expect, test } from "bun:test";

import {
  annotatedEventError,
  createAnnotationEditor,
  currentRevisionBy,
  editAnnotation,
  redoAnnotation,
  sameEvents,
  undoAnnotation,
} from "./annotations";
import { fallbackAnalyze } from "./index";
import { type AnnotatedEvent, annotateSession, migrateSessionRecord } from "./sessions";

const block: AnnotatedEvent = {
  kind: "block",
  startSeconds: 1.2,
  endSeconds: 1.8,
  certainty: "possible",
};
const repetition: AnnotatedEvent = {
  kind: "wordRepetition",
  startSeconds: 0.4,
  endSeconds: 1.5,
  certainty: "certain",
};

function edit(
  state: ReturnType<typeof createAnnotationEditor>,
  ...args: Parameters<typeof editAnnotation>[1][]
) {
  return args.reduce((current, next) => {
    const result = editAnnotation(current, next);
    expect(result.error).toBeNull();
    return result.state;
  }, state);
}

describe("annotation editor", () => {
  test("keeps overlapping spans ordered by start and end", () => {
    const state = edit(
      createAnnotationEditor(),
      { type: "add", event: block },
      { type: "add", event: repetition },
    );
    expect(state.events).toEqual([repetition, block]);
  });

  test("stores exact boundaries to the millisecond and nudges without drift", () => {
    let state = edit(createAnnotationEditor(), {
      type: "add",
      event: { ...block, startSeconds: 1.23456, endSeconds: 2 },
    });
    expect(state.events[0].startSeconds).toBe(1.235);
    for (let step = 0; step < 10; step += 1) {
      state = edit(state, { type: "nudge", index: 0, edge: "end", deltaSeconds: 0.01 });
    }
    expect(state.events[0].endSeconds).toBe(2.1);
    state = edit(state, { type: "nudge", index: 0, edge: "start", deltaSeconds: -0.1 });
    expect(state.events[0].startSeconds).toBe(1.135);
  });

  test("rejects a boundary past the other edge or before the session and keeps the state", () => {
    const state = edit(createAnnotationEditor(), { type: "add", event: block });
    const crossed = editAnnotation(state, { type: "update", index: 0, patch: { endSeconds: 1 } });
    expect(crossed.error).toBe("End must not be before start.");
    expect(crossed.state).toBe(state);
    const early = editAnnotation(state, {
      type: "nudge",
      index: 0,
      edge: "start",
      deltaSeconds: -2,
    });
    expect(early.error).toBe("Start cannot be before the session start.");
    expect(annotatedEventError({ ...block, startSeconds: Number.NaN })).toContain("numbers");
    // A zero-length span marks an instant, which is allowed.
    expect(annotatedEventError({ ...block, endSeconds: block.startSeconds })).toBeNull();
  });

  test("undoes and redoes add, update, nudge and delete one step at a time", () => {
    const added = edit(createAnnotationEditor(), { type: "add", event: block });
    const changed = edit(added, {
      type: "update",
      index: 0,
      patch: { kind: "prolongation", note: "  long  " },
    });
    expect(changed.events[0]).toEqual({ ...block, kind: "prolongation", note: "long" });
    const removed = edit(changed, { type: "remove", index: 0 });
    expect(removed.events).toEqual([]);

    const back = undoAnnotation(undoAnnotation(removed));
    expect(back.events).toEqual([block]);
    expect(redoAnnotation(back).events).toEqual(changed.events);
    // A new edit after undo drops the redo branch.
    const branched = edit(back, { type: "nudge", index: 0, edge: "end", deltaSeconds: 0.01 });
    expect(redoAnnotation(branched)).toBe(branched);
    expect(undoAnnotation(createAnnotationEditor())).toEqual(createAnnotationEditor());
  });

  test("an edit that changes nothing adds no undo step", () => {
    const state = edit(createAnnotationEditor(), { type: "add", event: block });
    expect(
      editAnnotation(state, { type: "update", index: 0, patch: { kind: "block" } }).state,
    ).toBe(state);
    expect(sameEvents([block, repetition], [repetition, block])).toBe(true);
  });

  test("finds only the rater's own current revision", () => {
    const segments = [{ text: "I I want", startSeconds: 0, endSeconds: 2, isFinal: true }];
    let record = migrateSessionRecord({
      id: "s-1",
      startedAt: "2026-10-17T10:00:00.000Z",
      segments,
      pauses: [],
      report: fallbackAnalyze({ segments, pauses: [] }),
    });
    const base = {
      createdAt: "2026-10-17T10:05:00.000Z",
      basedOnRunId: null,
      status: "draft" as const,
      supersedes: null,
    };
    record = annotateSession(record, {
      ...base,
      id: "r1-a",
      author: { role: "self" },
      events: [block],
    });
    record = annotateSession(record, {
      ...base,
      id: "r2-a",
      author: { role: "clinician", id: "slt-1" },
      events: [repetition],
    });
    record = annotateSession(record, {
      ...base,
      id: "r1-b",
      author: { role: "self" },
      events: [],
      supersedes: "r1-a",
    });

    expect(currentRevisionBy(record, { role: "self" })?.id).toBe("r1-b");
    expect(currentRevisionBy(record, { role: "clinician", id: "slt-1" })?.events).toEqual([
      repetition,
    ]);
    expect(currentRevisionBy(record, { role: "clinician" })).toBeNull();
  });
});
