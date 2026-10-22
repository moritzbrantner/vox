import { assessRunCaptureQuality } from "@stutter-tracker/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
  startAuditoryFeedbackSession,
} from "./auditoryFeedback";

type RecorderMode = "normal" | "hang" | "throw" | "errorThenStop";
let recorderStartThrows = false;

class FakeParam {
  constructor(public value = 1) {}
  setTargetAtTime(value: number) {
    this.value = value;
  }
  cancelScheduledValues() {}
}

class FakeNode {
  readonly connections = new Set<unknown>();
  connect(target: unknown) {
    this.connections.add(target);
  }
  disconnect(target?: unknown) {
    if (target === undefined) {
      this.connections.clear();
    } else {
      this.connections.delete(target);
    }
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeTrack extends EventTarget {
  stopped = false;
  readyState: "live" | "ended" = "live";
  label = "Built-in microphone";
  getSettings() {
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
  }
  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[] = [new FakeTrack()]) {}
  getTracks() {
    return this.tracks;
  }
}

let recorderMode: RecorderMode = "normal";
const recorders: FakeRecorder[] = [];

class FakeRecorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  constructor() {
    super();
    recorders.push(this);
  }
  start() {
    if (recorderStartThrows) {
      throw new DOMException("inactive stream", "InvalidStateError");
    }
    this.state = "recording";
    const event = new Event("dataavailable") as Event & { data: Blob };
    event.data = new Blob(["chunk"]);
    this.dispatchEvent(event);
  }
  stop() {
    if (recorderMode === "throw") {
      throw new Error("recorder failed");
    }
    if (recorderMode === "hang") {
      return;
    }
    if (recorderMode === "errorThenStop") {
      // Spec order on an asynchronous failure: error, a final dataavailable, then stop.
      queueMicrotask(() => {
        this.dispatchEvent(new Event("error"));
        setTimeout(() => {
          const event = new Event("dataavailable") as Event & { data: Blob };
          event.data = new Blob(["final"]);
          this.dispatchEvent(event);
          this.state = "inactive";
          this.dispatchEvent(new Event("stop"));
        }, 0);
      });
      return;
    }
    this.state = "inactive";
    queueMicrotask(() => this.dispatchEvent(new Event("stop")));
  }
}

let context: FakeContext;
let pitchWorklet = false;
let duringWorkletLoad: () => void | Promise<void> = () => undefined;

class FakeContext {
  state: "running" | "closed" = "running";
  currentTime = 0;
  sampleRate = 48_000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly nodes: FakeNode[] = [];
  audioWorklet = {
    addModule: vi.fn(async () => {
      await duringWorkletLoad();
      if (!pitchWorklet) {
        throw new Error("no worklet");
      }
    }),
  };
  destinationStream = new FakeStream();
  constructor() {
    context = this;
  }
  async resume() {}
  async close() {
    this.state = "closed";
  }
  private track<T extends FakeNode>(node: T) {
    this.nodes.push(node);
    return node;
  }
  createMediaStreamSource() {
    return this.track(new FakeNode());
  }
  createGain() {
    const gain = this.track(new FakeGain());
    this.gains.push(gain);
    return gain;
  }
  createDelay() {
    return Object.assign(this.track(new FakeNode()), { delayTime: new FakeParam(0) });
  }
  createDynamicsCompressor() {
    return Object.assign(this.track(new FakeNode()), {
      threshold: new FakeParam(),
      knee: new FakeParam(),
      ratio: new FakeParam(),
      attack: new FakeParam(),
      release: new FakeParam(),
    });
  }
  createMediaStreamDestination() {
    return Object.assign(this.track(new FakeNode()), { stream: this.destinationStream });
  }
  // The output gain is the last gain node created and the only one wired to the speakers.
  get output() {
    return this.gains.at(-1)!;
  }
  get audible() {
    return this.output.connections.has(this.destination) && this.output.gain.value > 0;
  }
}

let stream: FakeStream;
let mediaDevices: EventTarget & { getUserMedia: ReturnType<typeof vi.fn> };
const originals = {
  mediaDevices: navigator.mediaDevices,
  AudioContext: window.AudioContext,
  MediaRecorder: globalThis.MediaRecorder,
  AudioWorkletNode: globalThis.AudioWorkletNode,
};

beforeEach(() => {
  recorderMode = "normal";
  recorderStartThrows = false;
  recorders.length = 0;
  pitchWorklet = false;
  duringWorkletLoad = () => undefined;
  stream = new FakeStream();
  mediaDevices = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn(async () => stream),
  });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
  window.AudioContext = FakeContext as unknown as typeof AudioContext;
  globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
  globalThis.AudioWorkletNode = class extends FakeNode {
    parameters = new Map([["semitones", new FakeParam(0)]]);
  } as unknown as typeof AudioWorkletNode;
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originals.mediaDevices,
  });
  window.AudioContext = originals.AudioContext;
  globalThis.MediaRecorder = originals.MediaRecorder;
  globalThis.AudioWorkletNode = originals.AudioWorkletNode;
});

function expectReleased() {
  expect(stream.tracks.every((track) => track.stopped)).toBe(true);
  expect(context.destinationStream.tracks.every((track) => track.stopped)).toBe(true);
  expect(context.state).toBe("closed");
  expect(context.nodes.every((node) => node.connections.size === 0)).toBe(true);
}

describe("auditory feedback session lifecycle", () => {
  it("silences output synchronously on stop, before recorder finalization", async () => {
    const session = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);
    expect(context.audible).toBe(true);

    const stopping = session.stop();
    expect(context.audible).toBe(false);

    const recording = await stopping;
    expect(recording.raw?.blob).toBeInstanceOf(Blob);
    expect(recording.processed?.blob).toBeInstanceOf(Blob);
    expectReleased();
  });

  it("keeps distinct provenance for the raw input and the processed monitor capture", async () => {
    const session = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);
    const { raw, processed } = await session.stop();

    expect(raw?.descriptor).toMatchObject({
      role: "appInput",
      origin: "browser",
      sampleRate: 48_000,
    });
    expect(processed?.descriptor).toMatchObject({
      role: "interventionOutput",
      origin: "browser",
      sampleRate: 48_000,
    });
    expect(raw?.descriptor.runId).toBe(processed?.descriptor.runId);
    expect(raw?.descriptor.preprocessing.echoCancellation).toEqual({
      requested: true,
      applied: true,
    });
    expect(() => assessRunCaptureQuality(processed!.descriptor, undefined)).toThrow(
      /interventionOutput, not the speaker's input/,
    );
    expect(() => assessRunCaptureQuality(raw!.descriptor, undefined)).not.toThrow();
  });

  it("bounds teardown when a recorder never emits stop", async () => {
    vi.useFakeTimers();
    recorderMode = "hang";
    const session = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS, {
      finalizeTimeoutMs: 500,
    });

    const stopping = session.stop();
    expect(context.audible).toBe(false);
    await vi.advanceTimersByTimeAsync(500);

    const recording = await stopping;
    expect(recording.raw?.blob).toBeInstanceOf(Blob);
    expectReleased();
  });

  it("releases everything when the recorder throws on stop", async () => {
    recorderMode = "throw";
    const session = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);

    await expect(session.stop()).resolves.toMatchObject({ raw: { blob: expect.any(Blob) } });
    expectReleased();
  });

  it("keeps the final chunk a recorder delivers after an error", async () => {
    recorderMode = "errorThenStop";
    const session = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);

    const recording = await session.stop();

    expect(recording.raw?.blob.size).toBe("chunkfinal".length);
    expectReleased();
  });

  it("refuses to start when the microphone ends during setup", async () => {
    duringWorkletLoad = () => {
      stream.tracks[0].dispatchEvent(new Event("ended"));
    };
    const onInterrupted = vi.fn();

    await expect(
      startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS, { onInterrupted }),
    ).rejects.toThrow(/input ended/);
    expect(onInterrupted).not.toHaveBeenCalled();
    expect(stream.tracks[0].stopped).toBe(true);
    expect(context.state).toBe("closed");
    expect(recorders).toHaveLength(0);
  });

  it("refuses to start when audio devices change during setup", async () => {
    duringWorkletLoad = () => {
      mediaDevices.dispatchEvent(new Event("devicechange"));
    };

    await expect(startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS)).rejects.toThrow(
      /devices changed/,
    );
    expect(stream.tracks[0].stopped).toBe(true);
    expect(recorders).toHaveLength(0);
  });

  it("refuses to start with an input track that already ended", async () => {
    stream.tracks[0].readyState = "ended";

    await expect(startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS)).rejects.toThrow(
      /input ended/,
    );
  });

  it("makes stop idempotent and ignores settings changes during teardown", async () => {
    vi.useFakeTimers();
    recorderMode = "hang";
    const session = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);

    const first = session.stop();
    session.update({ ...DEFAULT_AUDITORY_FEEDBACK_SETTINGS, outputGain: 0.8 });
    expect(session.stop()).toBe(first);
    expect(context.output.gain.value).toBe(0);

    await vi.runAllTimersAsync();
    await first;
    expectReleased();
  });

  it("stops and reports when microphone input ends", async () => {
    const onInterrupted = vi.fn();
    await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS, { onInterrupted });

    stream.tracks[0].dispatchEvent(new Event("ended"));
    stream.tracks[0].dispatchEvent(new Event("ended"));

    expect(context.audible).toBe(false);
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(onInterrupted.mock.calls[0][0]).toMatch(/input ended/);
    await vi.waitFor(expectReleased);
  });

  it("stops when audio devices change, because output may have left the headphones", async () => {
    const onInterrupted = vi.fn();
    await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS, { onInterrupted });

    mediaDevices.dispatchEvent(new Event("devicechange"));

    expect(context.audible).toBe(false);
    expect(onInterrupted.mock.calls[0][0]).toMatch(/devices changed/);
    await vi.waitFor(expectReleased);
  });

  it("does not report an interruption after a deliberate stop", async () => {
    const onInterrupted = vi.fn();
    const session = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS, {
      onInterrupted,
    });

    await session.stop();
    mediaDevices.dispatchEvent(new Event("devicechange"));
    stream.tracks[0].dispatchEvent(new Event("ended"));

    expect(onInterrupted).not.toHaveBeenCalled();
  });

  it("releases the microphone when the start is cancelled while permission is pending", async () => {
    const controller = new AbortController();
    let grant = (_: FakeStream) => {};
    mediaDevices.getUserMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );

    const starting = startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS, {
      signal: controller.signal,
    });
    controller.abort();

    // Settles while the permission prompt is still open.
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    grant(stream);
    await vi.waitFor(() => expect(stream.tracks[0].stopped).toBe(true));
    expect(recorders).toHaveLength(0);
  });

  it("releases the microphone and context when cancelled during graph setup", async () => {
    const controller = new AbortController();
    const resume = FakeContext.prototype.resume;
    FakeContext.prototype.resume = async function () {
      controller.abort();
    };
    try {
      await expect(
        startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      FakeContext.prototype.resume = resume;
    }
    expect(stream.tracks[0].stopped).toBe(true);
    expect(context.state).toBe("closed");
    expect(recorders).toHaveLength(0);
  });

  it("settles a cancelled start while worklet loading hangs", async () => {
    const controller = new AbortController();
    duringWorkletLoad = () => new Promise(() => undefined);
    const starting = startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(context.audioWorklet.addModule).toHaveBeenCalled());

    controller.abort();

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.tracks[0].stopped).toBe(true);
    expect(context.state).toBe("closed");
    expect(recorders).toHaveLength(0);
  });

  it("settles when the microphone ends while resume hangs", async () => {
    const resume = FakeContext.prototype.resume;
    const hangingResume = vi.fn(() => new Promise<void>(() => undefined));
    FakeContext.prototype.resume = hangingResume;
    try {
      const starting = startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);
      await vi.waitFor(() => expect(hangingResume).toHaveBeenCalled());
      stream.tracks[0].dispatchEvent(new Event("ended"));
      await expect(starting).rejects.toThrow(/input ended/);
    } finally {
      FakeContext.prototype.resume = resume;
    }
    expect(stream.tracks[0].stopped).toBe(true);
    expect(context.state).toBe("closed");
  });

  it("reports local capture unavailable when recorders cannot start", async () => {
    recorderStartThrows = true;
    const session = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);

    expect(session.capabilities.localCapture).toBe(false);
    expect(await session.stop()).toEqual({ raw: null, processed: null });
  });

  it("refuses to start when audio devices change while permission is pending", async () => {
    let grant = (_: FakeStream) => {};
    mediaDevices.getUserMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const starting = startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);

    mediaDevices.dispatchEvent(new Event("devicechange"));
    grant(stream);

    await expect(starting).rejects.toThrow(/devices changed/);
    expect(stream.tracks[0].stopped).toBe(true);
    expect(recorders).toHaveLength(0);
  });

  it("surfaces permission rejection without creating an audio context", async () => {
    mediaDevices.getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const contextsBefore = context;

    await expect(
      startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS),
    ).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(context).toBe(contextsBefore);
  });

  it("reports pitch shifting as unsupported when the worklet cannot load", async () => {
    const session = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);
    expect(session.capabilities.pitchShift).toBe(false);
    await session.stop();

    pitchWorklet = true;
    stream = new FakeStream();
    const withPitch = await startAuditoryFeedbackSession(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);
    expect(withPitch.capabilities.pitchShift).toBe(true);
    await withPitch.stop();
  });
});
