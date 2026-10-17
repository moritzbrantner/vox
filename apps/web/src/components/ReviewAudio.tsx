import type { AnnotatedEvent } from "@stutter-tracker/shared";
import { Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createReviewPlayer, type ReviewPlayer, type ReviewSpan } from "../audio/reviewPlayback";
import { clockSecondsAt, type KeptSessionAudio, sampleIndexAt } from "../storage/sessionAudio";
import { buttonClass, controlClass, cx, mutedTextClass } from "./styles";

export const REVIEW_RATES = [0.5, 0.75, 1] as const;
const WAVEFORM_BINS = 480;

export type ReviewAudio = {
  /** False when no audio was kept or this browser cannot play it. */
  available: boolean;
  playing: boolean;
  rate: number;
  loop: boolean;
  setRate: (rate: number) => void;
  setLoop: (loop: boolean) => void;
  play: (span: ReviewSpan) => boolean;
  stop: () => void;
};

export function useReviewAudio(audio: KeptSessionAudio | null): ReviewAudio {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(true);
  const [player, setPlayer] = useState<ReviewPlayer | null>(null);

  useEffect(() => {
    const created = audio ? createReviewPlayer(audio, () => setPlaying(false)) : null;
    setPlayer(created);
    return () => {
      created?.close();
      setPlayer(null);
      setPlaying(false);
    };
  }, [audio]);

  return {
    available: player !== null,
    playing,
    rate,
    loop,
    setRate,
    setLoop,
    play(span) {
      const started = player?.play(span, { loop, rate }) ?? false;
      setPlaying(started);
      return started;
    },
    stop() {
      player?.stop();
      setPlaying(false);
    },
  };
}

export function ReviewAudioPanel({
  audio,
  review,
  events,
  onPick,
}: {
  audio: KeptSessionAudio;
  review: ReviewAudio;
  events: AnnotatedEvent[];
  /** Click picks a session-clock time; Shift+click picks the end. */
  onPick: (edge: "start" | "end", seconds: number) => void;
}) {
  const duration = clockSecondsAt(audio, Math.max(0, audio.samples.length - 1));
  const peaks = useMemo(() => waveformPeaks(audio, duration), [audio, duration]);
  const x = (seconds: number) => (duration > 0 ? (seconds / duration) * WAVEFORM_BINS : 0);

  return (
    <div className="mb-4">
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={!review.available}
          onClick={() => review.play({ startSeconds: 0, endSeconds: duration })}
        >
          Play recording
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!review.playing}
          onClick={review.stop}
        >
          <Square size={14} aria-hidden="true" /> Stop
        </button>
        <label className="flex flex-col text-sm">
          Review speed
          <select
            className={controlClass}
            value={review.rate}
            onChange={(change) => review.setRate(Number(change.target.value))}
          >
            {REVIEW_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}×
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={review.loop}
            onChange={(change) => review.setLoop(change.target.checked)}
          />
          Loop
        </label>
      </div>
      {!review.available && (
        <p className={cx("m-0 mb-2 text-sm", mutedTextClass)}>
          This browser cannot play the kept audio.
        </p>
      )}
      <svg
        role="img"
        aria-label={`Waveform of the kept recording, ${duration.toFixed(2)} seconds. Click to set the new event's start, Shift+click its end.`}
        className="h-20 w-full cursor-crosshair rounded border border-[#dae2dd] bg-[#f6f8f7]"
        viewBox={`0 -1 ${WAVEFORM_BINS} 2`}
        preserveAspectRatio="none"
        onClick={(click) => {
          const box = click.currentTarget.getBoundingClientRect();
          if (box.width <= 0) return;
          const seconds = ((click.clientX - box.left) / box.width) * duration;
          onPick(click.shiftKey ? "end" : "start", Math.max(0, Math.min(duration, seconds)));
        }}
      >
        {events.map((event, index) => (
          <rect
            key={index}
            x={x(event.startSeconds)}
            width={Math.max(0.5, x(event.endSeconds) - x(event.startSeconds))}
            y={-1}
            height={2}
            fill="#1c6b5a"
            opacity={0.2}
          />
        ))}
        <path
          d={peaks.map((peak, bin) => (peak > 0 ? `M${bin + 0.5} ${-peak}V${peak}` : "")).join("")}
          stroke="#17201b"
          strokeWidth={0.6}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

// Peak absolute amplitude per bin of session-clock time; gaps stay empty.
function waveformPeaks(audio: KeptSessionAudio, duration: number) {
  const peaks = Array.from({ length: WAVEFORM_BINS }, () => 0);
  if (duration <= 0) return peaks;
  for (let bin = 0; bin < WAVEFORM_BINS; bin += 1) {
    const from = sampleIndexAt(audio, (bin / WAVEFORM_BINS) * duration);
    const to = sampleIndexAt(audio, ((bin + 1) / WAVEFORM_BINS) * duration);
    if (from === null) continue;
    const end = to ?? Math.min(audio.samples.length, from + 1);
    let peak = 0;
    for (let index = from; index < Math.max(end, from + 1); index += 1) {
      peak = Math.max(peak, Math.abs(audio.samples[index] ?? 0));
    }
    peaks[bin] = Math.min(1, peak);
  }
  return peaks;
}
