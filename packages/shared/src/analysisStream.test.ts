import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  AnalysisStream,
  AnalysisStreamHost,
  type AnalyzeSpeechRequest,
  type AnalysisReport,
  type LiveAnalysisWork,
  MAX_STREAM_PAUSES,
  type PauseSpan,
  type StreamUpdate,
  type TranscriptSegment,
  compareReports,
  fallbackAnalyze,
} from "./index";

// The property tests of the desktop stream (apps/desktop/src-tauri/src/analysis_stream/tests.rs),
// run over the shared stream with the shared batch analysis as the oracle.

const RUN = "run";
const STARTED = "fixture";

function oracle(segments: TranscriptSegment[], pauses: PauseSpan[]) {
  return fallbackAnalyze({ segments, pauses, sessionStartedAt: STARTED });
}

function expectSame(live: AnalysisReport, segments: TranscriptSegment[], pauses: PauseSpan[]) {
  const parity = compareReports(live, oracle(segments, pauses));
  expect(parity, `after ${segments.length} segments and ${pauses.length} pauses`).toMatchObject({
    state: "match",
  });
}

const start = () => new AnalysisStream({ runId: RUN, sessionStartedAt: STARTED });

const finish = (stream: AnalysisStream, segments: TranscriptSegment[], pauses: PauseSpan[]) =>
  stream.finish({ runId: RUN, segments, pauses, sessionStartedAt: STARTED });

function sameSegment(left: TranscriptSegment, right: TranscriptSegment) {
  return (
    left.text === right.text &&
    Object.is(left.startSeconds, right.startSeconds) &&
    Object.is(left.endSeconds, right.endSeconds) &&
    left.isFinal === right.isFinal &&
    Object.is(left.confidence, right.confidence) &&
    Object.is(left.speakerScore, right.speakerScore) &&
    left.alignment === right.alignment
  );
}

function samePause(left: PauseSpan, right: PauseSpan) {
  return (
    Object.is(left.startSeconds, right.startSeconds) &&
    Object.is(left.endSeconds, right.endSeconds) &&
    left.afterText === right.afterText
  );
}

function commonPrefix<T>(left: T[], right: T[], same: (a: T, b: T) => boolean) {
  let index = 0;
  while (index < left.length && index < right.length && same(left[index], right[index])) index++;
  return index;
}

/** A client that sends what changed since its last update, as the web app does. */
class Client {
  stream = start();
  seq = 0;
  sentSegments: TranscriptSegment[] = [];
  sentPauses: PauseSpan[] = [];
  /** Compare every report with the batch report of exactly its input. */
  constructor(private readonly checkEvery = true) {}

  sync(segments: TranscriptSegment[], pauses: PauseSpan[]): StreamUpdate {
    const segmentsFrom = commonPrefix(this.sentSegments, segments, sameSegment);
    const pausesFrom = commonPrefix(this.sentPauses, pauses, samePause);
    const update = this.stream.push({
      runId: RUN,
      seq: this.seq,
      segmentsFrom,
      segments: segments.slice(segmentsFrom),
      pausesFrom,
      pauses: pauses.slice(pausesFrom),
    });
    this.seq += 1;
    this.sentSegments = segments;
    this.sentPauses = pauses;
    expect(update.status, update.reason).toBe("live");
    if (update.report && this.checkEvery) expectSame(update.report, segments, pauses);
    return update;
  }
}

/** Deterministic xorshift32, so every chunking is reproducible. */
class Rng {
  constructor(private state: number) {
    this.state = state >>> 0 || 1;
  }
  next() {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
  below(bound: number) {
    return this.next() % bound;
  }
  unit() {
    return this.next() / 4_294_967_296;
  }
}

const WORDS = [
  "the",
  "the",
  "ball",
  "b",
  "b-b-ball",
  "um",
  "uh",
  "like",
  "sooooo",
  "went",
  "home",
  "I",
  "I",
  "I",
  "wanted",
  "to",
  "go",
  "c",
  "cat",
  "and",
  "then",
  "ähm",
  "Ähm,",
  "mmmmilk",
  "",
];

function segment(text: string, startSeconds: number, endSeconds: number, isFinal = true) {
  return { text, startSeconds, endSeconds, isFinal, confidence: 0.9 } as TranscriptSegment;
}

/**
 * A session with every event kind, events spanning segment boundaries, near-duplicate events in
 * neighbouring segments, unaligned and non-final segments, and pauses inside, between and across
 * segments (some shorter than a block, some reversed).
 */
function session(seed: number, segmentCount: number) {
  const rng = new Rng(seed);
  const segments: TranscriptSegment[] = [];
  const pauses: PauseSpan[] = [];
  let clock = rng.unit() * 0.5;
  for (let index = 0; index < segmentCount; index += 1) {
    const words = Array.from({ length: 1 + rng.below(9) }, () => WORDS[rng.below(WORDS.length)]);
    const text = words.join(rng.below(9) === 0 ? "  " : " ");
    const length = 0.2 + rng.unit() * 4;
    // Some segments overlap the previous one, some start exactly at its end.
    const choice = rng.below(6);
    const begin =
      choice === 0
        ? Math.max(0, clock - rng.unit())
        : choice === 1
          ? clock
          : clock + rng.unit() * 1.5;
    const item = segment(text, begin, begin + length, rng.below(9) !== 0);
    if (rng.below(7) === 0) item.alignment = "unaligned";
    if (rng.below(5) === 0) item.speakerScore = rng.unit();
    if (rng.below(11) === 0) delete item.confidence;
    segments.push(item);
    if (index > 0 && rng.below(8) === 0) {
      // A near-duplicate of the previous event text, starting within 0.08 s.
      segments.push({
        text: "um",
        startSeconds: begin + 0.01,
        endSeconds: begin + 0.3,
        isFinal: true,
      });
    }
    clock = begin + length;
    for (let count = rng.below(5); count > 0; count -= 1) {
      const pauseStart = begin + rng.unit() * (length + 1.5) - 0.5;
      const pauseLength = rng.below(15) === 0 ? -rng.unit() : rng.unit() * 2.4;
      const pause: PauseSpan = { startSeconds: pauseStart, endSeconds: pauseStart + pauseLength };
      if (rng.below(2) === 0) pause.afterText = text;
      pauses.push(pause);
    }
  }
  return { segments, pauses };
}

/** Feeds the final input as appends of `segmentStep` segments and `pauseStep` pauses. */
function appendInSteps(
  segments: TranscriptSegment[],
  pauses: PauseSpan[],
  segmentStep: number,
  pauseStep: number,
) {
  const client = new Client();
  let s = 0;
  let p = 0;
  while (s < segments.length || p < pauses.length) {
    s = Math.min(segments.length, s + segmentStep);
    p = Math.min(pauses.length, p + pauseStep);
    client.sync(segments.slice(0, s), pauses.slice(0, p));
  }
  return client;
}

const CHUNKINGS: Array<[number, number]> = [
  [1, 1],
  [1, 0],
  [2, 3],
  [3, 1],
  [5, 2],
  [7, 7],
  [1, 5],
  [11, 4],
  [40, 40],
];

describe("incremental shared analysis (vox#154)", () => {
  test("every prefix in every chunking equals the batch report", () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      const { segments, pauses } = session(seed * 7_919, 40);
      for (const [segmentStep, step] of CHUNKINGS) {
        const pauseStep = step === 0 ? pauses.length || 1 : step;
        const client = appendInSteps(segments, pauses, segmentStep, pauseStep);
        const finished = finish(client.stream, segments, pauses);
        expect(finished.parity, `seed ${seed} steps ${segmentStep}/${pauseStep}`).toMatchObject({
          state: "match",
        });
        expect(finished.work.segmentsRevisited).toBe(0);
        expect(finished.work.fullRebuilds).toBe(0);
      }
    }
  });

  test("random chunkings of segments and pauses match at every update", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const { segments, pauses } = session(seed * 15_485_863, 30);
      const rng = new Rng(seed * 31);
      const client = new Client();
      let s = 0;
      let p = 0;
      while (s < segments.length || p < pauses.length) {
        s = Math.min(segments.length, s + rng.below(4));
        p = Math.min(pauses.length, p + rng.below(4));
        client.sync(segments.slice(0, s), pauses.slice(0, p));
      }
      expect(finish(client.stream, segments, pauses).parity).toMatchObject({ state: "match" });
    }
  });

  test("the reference cases match in every chunking", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../fixtures/analysis-parity.json", import.meta.url), "utf8"),
    ) as { cases: Array<{ name: string; request: AnalyzeSpeechRequest }> };
    const edgeCases: Array<{ name: string; request: AnalyzeSpeechRequest }> = [
      { name: "empty", request: { segments: [], pauses: [] } },
      {
        name: "zero, negative and reversed spans",
        request: {
          segments: [
            segment("um um the the", -0, -0),
            segment("sssso", 2, 1),
            segment("", 3, 4),
            segment("like like", -2, -1),
          ],
          pauses: [
            { startSeconds: -0, endSeconds: 0.8 },
            { startSeconds: 2, endSeconds: 1 },
            { startSeconds: 0.5, endSeconds: 0.5 },
          ],
        },
      },
      {
        // Each is within 0.08 s of the one before it, the third not of the first.
        name: "a chain of near-duplicates",
        request: {
          segments: [segment("um", 0, 0.3), segment("um", 0.05, 0.35), segment("um", 0.1, 0.4)],
          pauses: [],
        },
      },
      {
        name: "equal starts across segments and pauses",
        request: {
          segments: [segment("um", 1, 2), segment("um", 1, 2), segment("the the", 1, 1.5)],
          pauses: [
            { startSeconds: 1, endSeconds: 2, afterText: "um" },
            { startSeconds: 1, endSeconds: 2.5, afterText: "um" },
          ],
        },
      },
    ];
    for (const { name, request } of [...fixture.cases, ...edgeCases]) {
      for (let step = 1; step <= 3; step += 1) {
        const client = appendInSteps(request.segments, request.pauses, step, step);
        const finished = finish(client.stream, request.segments, request.pauses);
        expect(finished.parity, `${name} step ${step}`).toMatchObject({ state: "match" });
      }
    }
  });

  test("revisions of recent segments and partial-to-final corrections converge", () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const { segments, pauses } = session(seed * 104_729, 30);
      const rng = new Rng(seed);
      const client = new Client();
      for (let count = 1; count <= segments.length; count += 1) {
        const shown = segments.slice(0, count);
        // The newest segment first arrives as a partial, sometimes with other words.
        const truth = shown[count - 1];
        shown[count - 1] = {
          ...truth,
          isFinal: false,
          text: rng.below(2) === 0 ? `${truth.text} um um` : truth.text,
        };
        const visiblePauses = pauses.slice(
          0,
          Math.floor((count * pauses.length) / segments.length),
        );
        client.sync(shown, visiblePauses);
        // Then a correction of the last few segments: merged, split or shifted text.
        if (count > 3 && rng.below(3) === 0) {
          const corrected = segments.slice(0, count);
          const at = count - 1 - rng.below(3);
          corrected[at] = {
            ...corrected[at],
            text: `${corrected[at].text} the the`,
            startSeconds: corrected[at].startSeconds + 0.05,
          };
          client.sync(corrected, visiblePauses);
        }
        client.sync(segments.slice(0, count), visiblePauses);
      }
      client.sync(segments, pauses);
      const finished = finish(client.stream, segments, pauses);
      expect(finished.parity).toMatchObject({ state: "match" });
      expect(finished.work.segmentsRevisited).toBeGreaterThan(0);
      expect(finished.work.segmentsRevisited).toBeLessThanOrEqual(4 * 2 * segments.length);
      expect(finished.work.fullRebuilds).toBeLessThanOrEqual(1);
    }
  });

  test("removed segments and pauses leave no trace", () => {
    const { segments, pauses } = session(99, 25);
    const client = new Client();
    client.sync(segments, pauses);
    // Shrinking (a recognizer withdrew results) and growing back.
    client.sync(segments.slice(0, 10), pauses.slice(0, Math.floor(pauses.length / 3)));
    client.sync(segments.slice(0, 10), []);
    client.sync([], []);
    client.sync(segments, pauses);
    const finished = finish(client.stream, segments, pauses);
    expect(finished.parity).toMatchObject({ state: "match" });
    expect(finished.work.fullRebuilds).toBeGreaterThanOrEqual(1);
  });

  test("no-input updates do no work and build no report", () => {
    const { segments, pauses } = session(5, 20);
    const client = appendInSteps(segments, pauses, 1, 1);
    const before = { ...client.stream.work };
    for (let index = 0; index < 50; index += 1) {
      const update = client.sync(segments, pauses);
      expect(update.changed).toBe(false);
      expect(update.report).toBeUndefined();
    }
    const after: LiveAnalysisWork = { ...client.stream.work };
    expect(after.noOpUpdates).toBe(before.noOpUpdates + 50);
    expect({ ...after, noOpUpdates: before.noOpUpdates }).toEqual(before);
  });

  test("duplicate and reordered updates change nothing", () => {
    const { segments } = session(17, 12);
    const stream = start();
    const push = (seq: number, segmentsFrom: number, items: TranscriptSegment[]) =>
      stream.push({ runId: RUN, seq, segmentsFrom, segments: items, pausesFrom: 0, pauses: [] });
    push(0, 0, segments.slice(0, 4));
    const applied = push(1, 4, segments.slice(4, 8));
    const repeat = push(1, 4, segments.slice(4, 8));
    const late = push(0, 0, segments.slice(0, 2));
    expect(repeat.changed || late.changed).toBe(false);
    expect(repeat.status).toBe("live");
    expect(stream.work.duplicateUpdates).toBe(2);
    expectSame(applied.report!, segments.slice(0, 8), []);
    expect(finish(stream, segments.slice(0, 8), []).parity).toMatchObject({ state: "match" });
  });

  test("a missing update interrupts until a full resync", () => {
    const { segments, pauses } = session(23, 15);
    const stream = start();
    const request = (
      seq: number,
      segmentsFrom: number,
      items: TranscriptSegment[],
      pausesFrom: number,
      spans: PauseSpan[],
    ) => ({ runId: RUN, seq, segmentsFrom, segments: items, pausesFrom, pauses: spans });
    stream.push(request(0, 0, segments.slice(0, 5), 0, pauses.slice(0, 2)));
    // Update 1 is lost; update 2 builds on content the stream never saw.
    const gap = stream.push(request(2, 9, segments.slice(9, 12), 2, pauses.slice(2, 3)));
    expect(gap.status).toBe("interrupted");
    expect(gap.changed).toBe(false);
    expect(gap.report).toBeUndefined();
    const refused = stream.push(request(3, 12, segments.slice(12), 3, pauses.slice(3)));
    expect(refused.status).toBe("interrupted");
    // An interrupted run is never compared as if it were complete.
    const probe = start();
    probe.push(request(1, 1, [], 0, []));
    expect(finish(probe, segments, pauses).parity).toMatchObject({ state: "notComparable" });
    // Recovery: everything again from position 0.
    const resync = stream.push(request(4, 0, segments, 0, pauses));
    expect(resync.status).toBe("live");
    expectSame(resync.report!, segments, pauses);
    const finished = finish(stream, segments, pauses);
    expect(finished.parity).toMatchObject({ state: "match" });
    expect(finished.work.fullRebuilds).toBe(1);
    expect(finished.work.rejectedUpdates).toBe(2);
  });

  test("an update beyond the held input interrupts", () => {
    const { segments } = session(31, 6);
    const update = start().push({
      runId: RUN,
      seq: 0,
      segmentsFrom: 2,
      segments,
      pausesFrom: 0,
      pauses: [],
    });
    expect(update.status).toBe("interrupted");
    expect(update.reason).toContain("beyond");
  });

  test("input beyond the bound is refused as overloaded, not analyzed", () => {
    const stream = start();
    const many = Array.from({ length: MAX_STREAM_PAUSES + 1 }, (_, index) => ({
      startSeconds: index,
      endSeconds: index + 0.1,
    }));
    const update = stream.push({
      runId: RUN,
      seq: 0,
      segmentsFrom: 0,
      segments: [],
      pausesFrom: 0,
      pauses: many,
    });
    expect(update.status).toBe("overloaded");
    expect(update.report).toBeUndefined();
    expect(update.work.pausesAnalyzed).toBe(0);
    expect(finish(stream, [], many).parity).toMatchObject({ state: "notComparable" });
  });

  test("non-finite times are refused", () => {
    expect(() =>
      start().push({
        runId: RUN,
        seq: 0,
        segmentsFrom: 0,
        segments: [segment("a", 0, Number.NaN)],
        pausesFrom: 0,
        pauses: [],
      }),
    ).toThrow("segment and pause times must be finite");
  });

  test("a finished or replaced run cannot change the active one", () => {
    const host = new AnalysisStreamHost();
    host.start({ runId: "old" });
    host.start({ runId: "new" });
    const request = {
      seq: 0,
      segmentsFrom: 0,
      segments: [segment("a", 0, 1)],
      pausesFrom: 0,
      pauses: [],
    };
    expect(() => host.push({ ...request, runId: "old" })).toThrow("no analysis stream run old");
    expect(host.push({ ...request, runId: "new" }).changed).toBe(true);
    expect(() => host.finish({ runId: "old", segments: [], pauses: [] })).toThrow();
    expect(
      host.finish({ runId: "new", segments: request.segments, pauses: [] }).parity,
    ).toMatchObject({ state: "match" });
    expect(() => host.push({ ...request, runId: "new", seq: 1 })).toThrow();
  });

  test("work grows with new input, not with history", () => {
    const { segments, pauses } = session(4_242, 2_000);
    const stream = start();
    let seq = 0;
    let s = 0;
    let p = 0;
    while (s < segments.length) {
      const nextS = s + 1;
      const nextP = Math.max(p, Math.floor((nextS * pauses.length) / segments.length));
      stream.push({
        runId: RUN,
        seq: seq++,
        segmentsFrom: s,
        segments: segments.slice(s, nextS),
        pausesFrom: p,
        pauses: pauses.slice(p, nextP),
      });
      s = nextS;
      p = nextP;
    }
    stream.push({
      runId: RUN,
      seq,
      segmentsFrom: s,
      segments: [],
      pausesFrom: p,
      pauses: pauses.slice(p),
    });
    const work = stream.work;
    const finals = segments.filter((item) => item.isFinal);
    expect(work.tokensAnalyzed).toBe(
      finals.reduce((sum, item) => sum + item.text.split(/\s+/).filter(Boolean).length, 0),
    );
    expect(work.segmentsAnalyzed).toBe(finals.length);
    expect(work.pausesAnalyzed).toBe(pauses.length);
    expect(work.segmentsRevisited + work.pausesRevisited + work.fullRebuilds).toBe(0);
    // Counting a chunk's events reads only the events near it, not the history.
    expect(work.chunkEventReads / work.reportChunks).toBeLessThan(12);
    expect(finish(stream, segments, pauses).parity).toMatchObject({ state: "match" });
  });

  test("a mismatch is reported with its differences", () => {
    const segments = [segment("the the ball", 0, 1)];
    const live = oracle(segments, []);
    live.wordCount += 1;
    live.speechStats.wordsPerMinute += 1e-12;
    const parity = compareReports(live, oracle(segments, []));
    expect(parity).toMatchObject({ state: "mismatch", differenceCount: 2 });
    if (parity.state !== "mismatch") throw new Error("expected a mismatch");
    expect(parity.differences.some((item) => item.includes("wordCount"))).toBe(true);
    expect(parity.differences.some((item) => item.includes("wordsPerMinute"))).toBe(true);
  });
});
