// Fast check of the browser workflows' proportional work (vox#43) on synthetic recordings; the
// real-corpus run is scripts/runtime-budgets.ts.
import { afterEach, describe, expect, it } from "vitest";
import { type KeptSessionAudio, setSessionAudioStore } from "../storage/sessionAudio";
import { type BenchRecording, recordViolations, runBrowserWorkflows } from "./runtimeBudgets";

/** 3-second segments, a one-second silence in each; a repetition every 4th, a filler every 7th. */
function synthetic(id: string, seconds: number): BenchRecording {
  const sampleRate = 16_000;
  const samples = new Float32Array(seconds * sampleRate);
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    if (time % 3 >= 1.9 && time % 3 < 2.9) continue;
    samples[index] =
      Math.sin(time * 180 * 2 * Math.PI) * (Math.sin(time * 3 * 2 * Math.PI) * 0.08 + 0.22);
  }
  const segments = Array.from({ length: seconds / 3 }, (_, index) => ({
    text:
      index % 4 === 0
        ? "I I want to explain this clearly"
        : index % 7 === 0
          ? "um this is a synthetic speaking sample"
          : "this is a synthetic speaking sample",
    startSeconds: index * 3,
    endSeconds: index * 3 + 1.9,
  }));
  return { id, sampleRate, samples, segments };
}

function memoryAudioStore() {
  const kept = new Map<string, KeptSessionAudio>();
  return {
    async put(audio: KeptSessionAudio) {
      kept.set(audio.sessionId, audio);
    },
    async get(sessionId: string) {
      return kept.get(sessionId) ?? null;
    },
    async delete(sessionId: string) {
      kept.delete(sessionId);
    },
    async retain(sessionIds: string[]) {
      for (const id of kept.keys()) if (!sessionIds.includes(id)) kept.delete(id);
    },
  };
}

afterEach(() => setSessionAudioStore(null));

describe("browser workflow budgets", () => {
  it("does work proportional to each recording, not to its history", async () => {
    setSessionAudioStore(memoryAudioStore());
    // 28 segments repeat the text pattern exactly, so 168 s is twice 84 s.
    const recordings = [synthetic("short", 84), synthetic("long", 168)];
    const marks: string[] = [];
    const report = await runBrowserWorkflows(2, async (index) => recordings[index], {
      chunkSeconds: 8,
      backupIterations: 100_000,
      mark: (name) => {
        marks.push(name);
      },
    });
    expect(report.violations).toEqual([]);
    expect(marks).toEqual([
      "record:start",
      "record:end",
      "review:start",
      "review:end",
      "import:start",
      "import:end",
    ]);
    const [short, long] = report.recordings.map((item) => item.counters);
    expect(long.tokens).toBe(2 * short.tokens);
    expect(long.stream.tokensAnalyzed).toBe(2 * short.stream.tokensAnalyzed);
    expect(long.stream.segmentsAnalyzed).toBe(2 * short.stream.segmentsAnalyzed);
    expect(long.stream.pausesAnalyzed).toBe(2 * short.stream.pausesAnalyzed);
    expect(long.stream.fullRebuilds + short.stream.fullRebuilds).toBeLessThanOrEqual(2);
    // The batch is sent at most the last 90 s.
    expect(short.acousticSamples).toBe(84 * 16_000);
    expect(long.acousticSamples).toBe(90 * 16_000);
    expect(long.savedSessionsInList).toBe(2);

    const [review] = report.review;
    expect(review.sessionsLoaded).toBe(2);
    expect(review.audioOpened).toBe(2);
    expect(review.audioSamplesRead).toBe(short.audioSamples + long.audioSamples);
    const [imported] = report.import;
    expect(imported.sessions).toBe(2);
    expect(imported.kdfIterations).toBe(100_000);
  });

  it("reports disproportionate work as a violation", async () => {
    setSessionAudioStore(memoryAudioStore());
    const report = await runBrowserWorkflows(1, async () => synthetic("one", 30), {
      chunkSeconds: 8,
      backupIterations: 100_000,
    });
    const counters = structuredClone(report.recordings[0].counters);
    expect(recordViolations("one", counters)).toEqual([]);
    counters.stream.fullRebuilds = 2;
    counters.stream.tokensAnalyzed += 1;
    counters.stream.chunkEventReads = counters.stream.reportChunks * 40;
    expect(recordViolations("one", counters)).toHaveLength(3);
  });
});
