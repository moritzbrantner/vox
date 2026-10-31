import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_CHECKPOINT_PREFIX,
  type CaptureCheckpoint,
  captureCheckpointKey,
  claimCapture,
  hasCheckpointedObservation,
  heldCaptureIds,
  listCaptureCheckpoints,
  readCaptureCheckpoint,
  removeCaptureCheckpoint,
  writeCaptureCheckpoint,
} from "./captureCheckpoint";

function checkpoint(overrides: Partial<CaptureCheckpoint> = {}): CaptureCheckpoint {
  return {
    version: 1,
    id: "capture-1",
    startedAt: "2026-10-09T10:00:00.000Z",
    updatedAt: "2026-10-09T10:01:00.000Z",
    language: "en-US",
    segments: [
      { text: "I I want", startSeconds: 0, endSeconds: 1.5, confidence: 0.9, isFinal: true },
    ],
    pauses: [{ startSeconds: 1.5, endSeconds: 2.4, afterText: "want" }],
    analysis: null,
    recording: null,
    ...overrides,
  };
}

const analysis: NonNullable<CaptureCheckpoint["analysis"]> = {
  report: {
    totalDurationSeconds: 2,
    wordCount: 0,
    stutterCount: 1,
    stuttersPerMinute: 30,
    severity: "mild",
    speechStats: {
      speakingDurationSeconds: 2,
      pauseDurationSeconds: 0,
      wordsPerMinute: 0,
      articulationRateWpm: 0,
      meanChunkWords: 0,
      meanChunkDurationSeconds: 0,
      eventDensityPer100Words: 0,
      fluencyPercentage: 100,
    },
    blockerStats: {
      blockCount: 1,
      totalBlockSeconds: 0.7,
      averageBlockSeconds: 0.7,
      longestBlockSeconds: 0.7,
      blocksPerMinute: 30,
      blockedTimePercentage: 35,
    },
    chunks: [],
    events: [
      {
        kind: "block",
        startSeconds: 0.5,
        endSeconds: 1.2,
        text: "",
        detail: "Acoustic block",
        confidence: 0.7,
      },
    ],
    byKind: { block: 1 },
  },
  run: {
    id: "run-1",
    createdAt: "2026-10-09T10:01:00.000Z",
    analyzer: null,
    usedAudio: true,
    audioId: "audio-1",
    inputId: "input-1",
  },
};

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("capture checkpoints", () => {
  it("round-trips checkpoints under per-capture keys", () => {
    writeCaptureCheckpoint(checkpoint());
    writeCaptureCheckpoint(
      checkpoint({ id: "capture-0", startedAt: "2026-10-09T09:00:00.000Z", analysis }),
    );
    localStorage.setItem("unrelated", "1");
    expect(listCaptureCheckpoints()).toEqual([
      {
        key: captureCheckpointKey("capture-0"),
        kind: "checkpoint",
        checkpoint: checkpoint({
          id: "capture-0",
          startedAt: "2026-10-09T09:00:00.000Z",
          analysis,
        }),
      },
      { key: captureCheckpointKey("capture-1"), kind: "checkpoint", checkpoint: checkpoint() },
    ]);
  });

  it("keeps the capture's recording descriptor and reads older checkpoints without one", () => {
    const recording = {
      sessionId: "capture-1",
      runId: "run-1",
      origin: "browser" as const,
      role: "appInput" as const,
      sampleRate: 48_000,
      channelCount: 1,
      startOffsetSeconds: 0,
      preprocessing: {
        echoCancellation: { requested: true, applied: true },
        noiseSuppression: { requested: true },
        autoGainControl: { requested: false, applied: false },
      },
      discontinuities: [],
      speakerAssessment: "singleSpeakerDeclared" as const,
    };
    writeCaptureCheckpoint(checkpoint({ recording }));
    const key = captureCheckpointKey("capture-1");
    expect(readCaptureCheckpoint(key)).toEqual({
      key,
      kind: "checkpoint",
      checkpoint: checkpoint({ recording }),
    });

    const { recording: _omitted, ...legacy } = checkpoint();
    localStorage.setItem(key, JSON.stringify(legacy));
    expect(readCaptureCheckpoint(key)).toEqual({
      key,
      kind: "checkpoint",
      checkpoint: checkpoint(),
    });

    // A descriptor of another capture is not this capture's provenance.
    writeCaptureCheckpoint(checkpoint({ recording: { ...recording, sessionId: "other" } }));
    expect(readCaptureCheckpoint(key)).toEqual({ key, kind: "unreadable" });

    // Crash recovery keeps each participant's confirmation and migrates a single legacy one.
    const otherParticipants = [
      {
        label: "Robin",
        confirmedAt: "2026-10-31T10:00:00.000Z",
        statement: "Robin has agreed to be recorded.",
      },
    ];
    writeCaptureCheckpoint(checkpoint({ recording: { ...recording, otherParticipants } }));
    expect(readCaptureCheckpoint(key)).toEqual({
      key,
      kind: "checkpoint",
      checkpoint: checkpoint({ recording: { ...recording, otherParticipants } }),
    });
    const legacyConfirmation = {
      confirmedAt: "2026-10-30T09:00:00.000Z",
      statement: "Everyone else in this recording has agreed to be recorded.",
    };
    localStorage.setItem(
      key,
      JSON.stringify(
        checkpoint({
          recording: { ...recording, otherParticipants: legacyConfirmation as never },
        }),
      ),
    );
    expect(readCaptureCheckpoint(key)).toEqual({
      key,
      kind: "checkpoint",
      checkpoint: checkpoint({
        recording: {
          ...recording,
          otherParticipants: [
            { label: "Everyone else (before per-participant consent)", ...legacyConfirmation },
          ],
        },
      }),
    });
  });

  it("reports nothing when no checkpoint is stored", () => {
    expect(listCaptureCheckpoints()).toEqual([]);
  });

  it.each([
    ["truncated JSON", '{"version":1,"id":"capture-1"'],
    ["an unsupported version", JSON.stringify({ ...checkpoint(), version: 2 })],
    ["a blank id", JSON.stringify(checkpoint({ id: " " }))],
    ["an id that does not match its key", JSON.stringify(checkpoint({ id: "other" }))],
    ["an invalid date", JSON.stringify(checkpoint({ startedAt: "yesterday" }))],
    ["a malformed segment", JSON.stringify({ ...checkpoint(), segments: [{ text: 1 }] })],
    ["a malformed pause", JSON.stringify({ ...checkpoint(), pauses: [{}] })],
    ["a malformed analysis", JSON.stringify({ ...checkpoint(), analysis: { report: {} } })],
  ])("keeps %s as unreadable instead of dropping it", (_label, raw) => {
    localStorage.setItem(captureCheckpointKey("capture-1"), raw);
    expect(listCaptureCheckpoints()).toEqual([
      { key: captureCheckpointKey("capture-1"), kind: "unreadable" },
    ]);
    expect(localStorage.getItem(captureCheckpointKey("capture-1"))).toBe(raw);
  });

  it("reports nothing when storage cannot be read", () => {
    writeCaptureCheckpoint(checkpoint());
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(listCaptureCheckpoints()).toEqual([]);
  });

  it("surfaces a full storage on write and keeps the previous checkpoint", () => {
    writeCaptureCheckpoint(checkpoint());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => writeCaptureCheckpoint(checkpoint({ segments: [] }))).toThrow("full");
    vi.restoreAllMocks();
    expect(listCaptureCheckpoints()).toEqual([
      { key: captureCheckpointKey("capture-1"), kind: "checkpoint", checkpoint: checkpoint() },
    ]);
  });

  it("removes only the given capture and reports a refused removal", () => {
    writeCaptureCheckpoint(checkpoint());
    writeCaptureCheckpoint(checkpoint({ id: "capture-2" }));
    expect(removeCaptureCheckpoint(captureCheckpointKey("capture-1"))).toBe(true);
    expect(listCaptureCheckpoints().map((item) => item.key)).toEqual([
      captureCheckpointKey("capture-2"),
    ]);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(removeCaptureCheckpoint(captureCheckpointKey("capture-2"))).toBe(false);
  });

  it("counts segments, pauses or analyzed events as an observation", () => {
    const empty = checkpoint({ segments: [], pauses: [] });
    expect(hasCheckpointedObservation(empty)).toBe(false);
    expect(hasCheckpointedObservation(checkpoint({ segments: [] }))).toBe(true);
    expect(hasCheckpointedObservation(checkpoint({ pauses: [] }))).toBe(true);
    expect(hasCheckpointedObservation({ ...empty, analysis })).toBe(true);
    expect(
      hasCheckpointedObservation({
        ...empty,
        analysis: { ...analysis, report: { ...analysis.report, events: [] } },
      }),
    ).toBe(false);
  });
});

describe("capture ownership", () => {
  it("lets every claim succeed without Web Locks", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: undefined });
    expect(await claimCapture("capture-1")).toBeTypeOf("function");
    expect(await heldCaptureIds()).toEqual(new Set());
  });

  it("treats a failed lock request as owned elsewhere", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: async () => {
          throw new DOMException("inactive", "InvalidStateError");
        },
        query: async () => ({ held: [] }),
      },
    });
    expect(await claimCapture("capture-1")).toBeNull();
  });

  it("refuses a capture another window holds and lists held captures", async () => {
    const held = new Set<string>();
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: async (
          name: string,
          _options: unknown,
          callback: (lock: { name: string } | null) => unknown,
        ) => {
          if (held.has(name)) {
            return callback(null);
          }
          held.add(name);
          await callback({ name });
          held.delete(name);
        },
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
      },
    });

    const release = await claimCapture("capture-1");
    expect(release).toBeTypeOf("function");
    expect(await claimCapture("capture-1")).toBeNull();
    expect(await heldCaptureIds()).toEqual(new Set(["capture-1"]));
    release!();
    await Promise.resolve();
    await Promise.resolve();
    expect(await heldCaptureIds()).toEqual(new Set());
    expect(CAPTURE_CHECKPOINT_PREFIX).toBe("stutter-tracker:capture-checkpoint:");
  });
});
