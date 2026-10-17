import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clockSecondsAt,
  deleteSessionAudio,
  getSessionAudio,
  type KeptSessionAudio,
  putSessionAudio,
  resetSessionAudioConnection,
  retainSessionAudio,
  sampleIndexAt,
} from "./sessionAudio";

function kept(sessionId: string, patch: Partial<KeptSessionAudio> = {}): KeptSessionAudio {
  return {
    sessionId,
    sampleRate: 10,
    samples: new Float32Array(50).fill(0.25),
    startOffsetSeconds: 0,
    discontinuities: [],
    droppedSeconds: 0,
    audioId: "pcm-test",
    keptAt: "2026-10-17T10:00:00.000Z",
    ...patch,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetSessionAudioConnection();
});

describe("kept session audio storage", () => {
  it("stores samples exactly and removes them per session or by retention", async () => {
    await putSessionAudio(kept("a"));
    await putSessionAudio(kept("b"));
    await putSessionAudio(kept("c"));
    const read = await getSessionAudio("a");
    expect(Array.from(read?.samples ?? [])).toEqual(Array.from(new Float32Array(50).fill(0.25)));

    await deleteSessionAudio("a");
    expect(await getSessionAudio("a")).toBeNull();
    await retainSessionAudio(["c", "unknown"]);
    expect(await getSessionAudio("b")).toBeNull();
    expect(await getSessionAudio("c")).not.toBeNull();
    await retainSessionAudio([]);
    expect(await getSessionAudio("c")).toBeNull();
  });
});

describe("session clock to samples", () => {
  const audio = kept("a", {
    startOffsetSeconds: 1,
    // 2 s missing at clock 2..4; the first 0.5 s of capture was dropped from the rolling window.
    discontinuities: [{ startSeconds: 2, endSeconds: 4, reason: "dropout" }],
    droppedSeconds: 0.5,
  });

  it("accounts for the start offset, gaps and dropped samples", () => {
    expect(sampleIndexAt(audio, 0.5)).toBeNull();
    expect(sampleIndexAt(audio, 1.2)).toBeNull();
    expect(sampleIndexAt(audio, 1.5)).toBe(0);
    expect(sampleIndexAt(audio, 1.9)).toBe(4);
    expect(sampleIndexAt(audio, 3)).toBeNull();
    expect(sampleIndexAt(audio, 4)).toBe(5);
    expect(sampleIndexAt(audio, 8.4)).toBe(49);
    expect(sampleIndexAt(audio, 9)).toBeNull();
  });

  it("maps sample indices back to the session clock", () => {
    expect(clockSecondsAt(audio, 0)).toBe(1.5);
    expect(clockSecondsAt(audio, 5)).toBe(4);
    for (const index of [0, 3, 5, 20, 49]) {
      expect(sampleIndexAt(audio, clockSecondsAt(audio, index))).toBe(index);
    }
  });
});
