// Plays a span of kept session audio for annotation review: optional looping and a review speed.
// Speed uses the buffer playback rate, so pitch follows speed; this is a review aid, not analysis.
import { type KeptSessionAudio, sampleIndexAt } from "../storage/sessionAudio";

export type ReviewSpan = { startSeconds: number; endSeconds: number };

export type ReviewPlayer = {
  /** Returns false when the capture has no samples in the span. */
  play(span: ReviewSpan, options: { loop: boolean; rate: number }): boolean;
  stop(): void;
  close(): void;
};

export function createReviewPlayer(
  audio: KeptSessionAudio,
  onEnded: () => void,
): ReviewPlayer | null {
  const Context =
    typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!Context || audio.samples.length === 0) return null;
  const context = new Context();
  const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate);
  buffer.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0);
  let source: AudioBufferSourceNode | null = null;

  function stop() {
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    source.disconnect();
    source = null;
  }

  return {
    play(span, { loop, rate }) {
      stop();
      const first = firstIndexIn(audio, span);
      const last = lastIndexIn(audio, span);
      if (first === null || last === null || last <= first) return false;
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = rate;
      node.connect(context.destination);
      const offset = first / audio.sampleRate;
      const duration = (last - first) / audio.sampleRate;
      if (loop) {
        node.loop = true;
        node.loopStart = offset;
        node.loopEnd = offset + duration;
      }
      node.onended = () => {
        if (source === node) source = null;
        onEnded();
      };
      void context.resume();
      if (loop) node.start(0, offset);
      else node.start(0, offset, duration);
      source = node;
      return true;
    },
    stop,
    close() {
      stop();
      void context.close();
    },
  };
}

// A span may start or end inside a gap; play the samples that exist within it.
function firstIndexIn(audio: KeptSessionAudio, span: ReviewSpan) {
  return scan(audio, span, span.startSeconds, 1);
}

function lastIndexIn(audio: KeptSessionAudio, span: ReviewSpan) {
  return scan(audio, span, span.endSeconds, -1);
}

function scan(audio: KeptSessionAudio, span: ReviewSpan, from: number, direction: 1 | -1) {
  const step = 0.005;
  for (
    let clock = from;
    clock >= span.startSeconds - 1e-9 && clock <= span.endSeconds + 1e-9;
    clock += direction * step
  ) {
    const index = sampleIndexAt(audio, clock);
    if (index !== null) return index;
  }
  return null;
}
