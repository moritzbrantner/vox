import type { RecordingDescriptor } from "@stutter-tracker/shared";
import { describeCapture, REQUESTED_PREPROCESSING } from "./browserRecorder";

export type AuditoryFeedbackSettings = {
  delayMs: number;
  pitchShiftSemitones: number;
  wetMix: number;
  outputGain: number;
};

/** One lab capture with its provenance: which stream it is and what processing it carries. */
export type LabCapture = {
  blob: Blob;
  descriptor: RecordingDescriptor;
};

/**
 * `raw` is the microphone stream the app received (role "appInput"); `processed` is the
 * delayed/pitch-shifted monitor mix (role "interventionOutput"), which assessment never scores.
 */
export type AuditoryFeedbackRecording = {
  raw: LabCapture | null;
  processed: LabCapture | null;
};

export type AuditoryFeedbackCapabilities = {
  pitchShift: boolean;
  localCapture: boolean;
};

export type AuditoryFeedbackSession = {
  capabilities: AuditoryFeedbackCapabilities;
  update: (settings: AuditoryFeedbackSettings) => void;
  stop: () => Promise<AuditoryFeedbackRecording>;
};

export type AuditoryFeedbackSessionOptions = {
  // Aborting before the session is returned releases everything acquired so far.
  signal?: AbortSignal;
  // Called once when the session stops itself (input ended, audio devices changed).
  onInterrupted?: (reason: string) => void;
  // Upper bound for recorder finalization after Stop; output is already silent by then.
  finalizeTimeoutMs?: number;
};

export const DEFAULT_AUDITORY_FEEDBACK_SETTINGS: AuditoryFeedbackSettings = {
  delayMs: 100,
  pitchShiftSemitones: 0,
  wetMix: 1,
  outputGain: 0.5,
};

const MAX_DELAY_MS = 200;
const MAX_PITCH_SHIFT_SEMITONES = 6;
const MAX_OUTPUT_GAIN = 0.8;
const PITCH_SHIFT_PROCESSOR_NAME = "stutter-tracker-pitch-shift";
const DEFAULT_FINALIZE_TIMEOUT_MS = 2_000;
const TRACK_ENDED_REASON = "Microphone input ended, so feedback stopped.";
// A device change can move output from headphones to a loudspeaker; stop rather than guess.
const DEVICE_CHANGE_REASON =
  "Audio devices changed, so feedback stopped. Check your headphones and start again.";

export function normalizeAuditoryFeedbackSettings(
  settings: AuditoryFeedbackSettings,
): AuditoryFeedbackSettings {
  return {
    delayMs: clamp(settings.delayMs, 0, MAX_DELAY_MS),
    pitchShiftSemitones: clamp(
      settings.pitchShiftSemitones,
      -MAX_PITCH_SHIFT_SEMITONES,
      MAX_PITCH_SHIFT_SEMITONES,
    ),
    wetMix: clamp(settings.wetMix, 0, 1),
    outputGain: clamp(settings.outputGain, 0, MAX_OUTPUT_GAIN),
  };
}

export function calculateMixGains(wetMix: number) {
  const wet = clamp(wetMix, 0, 1);
  return {
    dry: Math.sqrt(1 - wet),
    wet: Math.sqrt(wet),
  };
}

export function semitonesToPlaybackRatio(semitones: number) {
  return 2 ** (semitones / 12);
}

export async function startAuditoryFeedbackSession(
  initialSettings: AuditoryFeedbackSettings,
  options: AuditoryFeedbackSessionOptions = {},
): Promise<AuditoryFeedbackSession> {
  const { signal, onInterrupted } = options;
  const finalizeTimeoutMs = options.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS;
  throwIfAborted(signal);
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is unavailable in this browser");
  }
  if (!window.AudioContext) {
    throw new Error("Live audio feedback is unavailable in this browser");
  }

  // Interruptions are watched before the permission prompt opens: a route change while it is
  // open must still stop the start. Until the session exists they only record why setup must not
  // continue; afterwards they stop the session.
  let interruption: string | null = null;
  // Settles a pending setup step as soon as the start is cancelled or interrupted, so a hung
  // browser call cannot keep the microphone held.
  let cancelSetup = (_error: unknown) => {};
  const setupCancelled = new Promise<never>((_, reject) => {
    cancelSetup = reject;
  });
  setupCancelled.catch(() => undefined);
  const onSetupAbort = () => cancelSetup(abortError());
  signal?.addEventListener("abort", onSetupAbort, { once: true });
  const duringSetup = <T>(step: Promise<T>) => Promise.race([step, setupCancelled]);
  let onInterruption = (reason: string) => {
    interruption ??= reason;
    cancelSetup(new Error(interruption));
  };
  const onTrackEnded = () => onInterruption(TRACK_ENDED_REASON);
  const onDeviceChange = () => onInterruption(DEVICE_CHANGE_REASON);
  navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange);

  let stream: MediaStream;
  try {
    stream = await acquireMicrophone(signal);
  } catch (error) {
    signal?.removeEventListener("abort", onSetupAbort);
    navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
    throw error;
  }
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", onTrackEnded);
  }
  const unwatch = () => {
    signal?.removeEventListener("abort", onSetupAbort);
    for (const track of stream.getTracks()) {
      track.removeEventListener("ended", onTrackEnded);
    }
    navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
  };
  const assertUsable = () => {
    throwIfAborted(signal);
    if (stream.getTracks().some((track) => track.readyState === "ended")) {
      interruption ??= TRACK_ENDED_REASON;
    }
    if (interruption) {
      throw new Error(interruption);
    }
  };

  let context: AudioContext;
  try {
    assertUsable();
    context = new AudioContext({ latencyHint: "interactive" });
  } catch (error) {
    unwatch();
    stopStream(stream);
    throw error;
  }
  const abandon = async (error: unknown): Promise<never> => {
    unwatch();
    stopStream(stream);
    await closeContext(context);
    throw error;
  };

  try {
    await duringSetup(context.resume());
    assertUsable();
  } catch (error) {
    return abandon(error);
  }

  const source = context.createMediaStreamSource(stream);
  const dryGain = context.createGain();
  const delay = context.createDelay(MAX_DELAY_MS / 1000 + 0.05);
  const wetGain = context.createGain();
  const limiter = context.createDynamicsCompressor();
  const outputGain = context.createGain();
  const captureDestination = context.createMediaStreamDestination();

  limiter.threshold.value = -16;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.08;

  let pitchShiftNode: AudioWorkletNode | null = null;
  try {
    if (context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      const processorUrl = new URL("./pitchShiftProcessor.js", import.meta.url);
      await duringSetup(context.audioWorklet.addModule(processorUrl));
      pitchShiftNode = new AudioWorkletNode(context, PITCH_SHIFT_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
    }
  } catch {
    // A failed worklet only disables pitch shifting; cancellation is re-checked below.
    pitchShiftNode = null;
  }
  try {
    assertUsable();
  } catch (error) {
    return abandon(error);
  }

  source.connect(dryGain);
  source.connect(delay);
  dryGain.connect(limiter);
  if (pitchShiftNode) {
    delay.connect(pitchShiftNode);
    pitchShiftNode.connect(wetGain);
  } else {
    delay.connect(wetGain);
  }
  wetGain.connect(limiter);
  limiter.connect(outputGain);
  outputGain.connect(context.destination);
  outputGain.connect(captureDestination);

  const rawCapture = startRecorderCapture(createRecorderCapture(stream));
  const processedCapture = startRecorderCapture(createRecorderCapture(captureDestination.stream));
  const descriptors = labDescriptors(stream, context.sampleRate);

  let stopped = false;
  let stopPromise: Promise<AuditoryFeedbackRecording> | null = null;

  const applySettings = (settings: AuditoryFeedbackSettings) => {
    if (stopped) {
      return;
    }
    const normalized = normalizeAuditoryFeedbackSettings(settings);
    const mix = calculateMixGains(normalized.wetMix);
    const now = context.currentTime;
    delay.delayTime.setTargetAtTime(normalized.delayMs / 1000, now, 0.01);
    dryGain.gain.setTargetAtTime(mix.dry, now, 0.01);
    wetGain.gain.setTargetAtTime(mix.wet, now, 0.01);
    outputGain.gain.setTargetAtTime(normalized.outputGain, now, 0.01);
    pitchShiftNode?.parameters
      .get("semitones")
      ?.setTargetAtTime(normalized.pitchShiftSemitones, now, 0.01);
  };

  // Runs synchronously on Stop, before any recorder work, so nothing stays audible.
  const silenceOutput = () => {
    try {
      outputGain.gain.cancelScheduledValues(0);
      outputGain.gain.value = 0;
    } catch {
      // Disconnecting below still silences the output.
    }
    safely(() => outputGain.disconnect(context.destination));
  };

  const teardown = async () => {
    for (const node of [source, dryGain, delay, pitchShiftNode, wetGain, limiter, outputGain]) {
      safely(() => node?.disconnect());
    }
    unwatch();
    stopStream(stream);
    // Closing the context does not end the destination track a recorder may still hold.
    stopStream(captureDestination.stream);
    await closeContext(context);
  };

  const stop = () => {
    if (stopPromise) {
      return stopPromise;
    }
    stopped = true;
    silenceOutput();
    stopPromise = (async () => {
      try {
        const [raw, processed] = await Promise.all([
          stopRecorderCapture(rawCapture, finalizeTimeoutMs),
          stopRecorderCapture(processedCapture, finalizeTimeoutMs),
        ]);
        return {
          raw: raw && { blob: raw, descriptor: descriptors.raw },
          processed: processed && { blob: processed, descriptor: descriptors.processed },
        };
      } finally {
        await teardown();
      }
    })();
    return stopPromise;
  };

  signal?.removeEventListener("abort", onSetupAbort);
  onInterruption = (reason: string) => {
    if (stopped) {
      return;
    }
    void stop();
    onInterrupted?.(reason);
  };

  applySettings(initialSettings);

  return {
    capabilities: {
      pitchShift: pitchShiftNode !== null,
      localCapture: rawCapture !== null && processedCapture !== null,
    },
    update: applySettings,
    stop,
  };
}

type RecorderCapture = {
  recorder: MediaRecorder;
  chunks: Blob[];
};

function createRecorderCapture(stream: MediaStream): RecorderCapture | null {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }
  try {
    const mimeType = preferredRecordingMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });
    return { recorder, chunks };
  } catch {
    return null;
  }
}

// Returns the capture only if recording actually started, so capabilities stay honest.
function startRecorderCapture(capture: RecorderCapture | null): RecorderCapture | null {
  if (!capture) {
    return null;
  }
  try {
    capture.recorder.start(250);
    return capture;
  } catch {
    return null;
  }
}

// Resolves with whatever was captured once the recorder stops or times out; never rejects. An
// error is followed by a final dataavailable and stop, so it does not finalize early.
function stopRecorderCapture(
  capture: RecorderCapture | null,
  timeoutMs: number,
): Promise<Blob | null> {
  if (!capture) {
    return Promise.resolve(null);
  }
  const { recorder, chunks } = capture;
  const collected = () =>
    chunks.length ? new Blob(chunks, { type: recorder.mimeType || "audio/webm" }) : null;
  if (recorder.state === "inactive") {
    return Promise.resolve(collected());
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      recorder.removeEventListener("stop", finish);
      resolve(collected());
    };
    const timer = setTimeout(finish, timeoutMs);
    recorder.addEventListener("stop", finish);
    try {
      recorder.stop();
    } catch {
      finish();
    }
  });
}

// A pending permission prompt cannot be cancelled, so an abort settles immediately and a stream
// that is granted later is released at once.
function acquireMicrophone(signal?: AbortSignal): Promise<MediaStream> {
  const request = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, ...REQUESTED_PREPROCESSING },
  });
  if (!signal) {
    return request;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
      void request.then(stopStream, () => undefined);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (stream) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          stopStream(stream);
        } else {
          resolve(stream);
        }
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Descriptors of one trial's two captures, which both start on the trial clock. The processed
 * capture is the app's own monitor output, so it is never described as speaker input.
 */
function labDescriptors(stream: MediaStream, contextSampleRate: number) {
  const track = stream.getTracks()[0];
  const reported = track?.getSettings?.().sampleRate;
  const trialId = crypto.randomUUID();
  const base = {
    sessionId: trialId,
    runId: trialId,
    origin: "browser",
    startOffsetSeconds: 0,
    speakerAssessment: "unknown",
  } as const;
  const raw: RecordingDescriptor = {
    ...base,
    ...describeCapture(track),
    role: "appInput",
    sampleRate: typeof reported === "number" && reported > 0 ? reported : contextSampleRate,
    discontinuities: [],
  };
  const processed: RecordingDescriptor = {
    ...base,
    role: "interventionOutput",
    sampleRate: contextSampleRate,
    channelCount: 1,
    // The monitor mix carries the input's preprocessing plus the app's delay, pitch and limiter.
    preprocessing: raw.preprocessing,
    discontinuities: [],
  };
  return { raw, processed };
}

function preferredRecordingMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

async function closeContext(context: AudioContext) {
  if (context.state !== "closed") {
    await context.close().catch(() => undefined);
  }
}

function safely(action: () => void) {
  try {
    action();
  } catch {
    // Already disconnected or released.
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

function abortError() {
  return new DOMException("Live audio feedback start was cancelled", "AbortError");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
