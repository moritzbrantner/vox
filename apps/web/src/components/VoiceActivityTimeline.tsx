import {
  type DetectorSpan,
  type LiveFiniteParity,
  type MeasuredCaptureMetrics,
  type RecordingDescriptor,
  type VoiceActivityEvidence,
  type VoiceActivityProvider,
  streamSecondsToSessionSeconds,
} from "@stutter-tracker/shared";
import { useState } from "react";
import type { LiveVoiceActivity } from "../app/hooks/useVoiceActivity";
import { cx, eyebrowClass, mutedTextClass } from "./styles";

/** No detector update for this long while recording shows the live timeline as stale. */
export const STALE_AFTER_MS = 2_000;

type Span = { startSeconds: number; endSeconds: number; kind: "final" | "provisional" | "unknown" };

type VoiceActivityTimelineProps = {
  /** The capture being recorded or just stopped. */
  live: LiveVoiceActivity | null;
  liveDescriptor: RecordingDescriptor | null;
  /** Saved evidence of a reviewed session (newest VAD-bearing run), or of the finished capture. */
  evidence: VoiceActivityEvidence | null;
  /** True when a reviewed session has no VAD-bearing run (legacy or transcript-only). */
  reviewWithoutEvidence: boolean;
  isRecording: boolean;
  now: number;
};

/**
 * Optional speech/silence timeline: provider speech spans (unattributed), provisional spans while
 * recording, and parts nothing is known about. Sound level and capture health are shown apart from
 * speech; an unavailable detector is never drawn as silence.
 */
export function VoiceActivityTimeline(props: VoiceActivityTimelineProps) {
  const [shown, setShown] = useState(false);
  return (
    <section className="mb-4 rounded-lg border border-[#dae2dd] p-3" aria-label="Speech detection">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={shown}
          onChange={(change) => setShown(change.target.checked)}
        />
        Show speech detection timeline
      </label>
      {shown && <TimelineBody {...props} />}
    </section>
  );
}

function TimelineBody({
  live,
  liveDescriptor,
  evidence,
  reviewWithoutEvidence,
  isRecording,
  now,
}: VoiceActivityTimelineProps) {
  if (evidence) return <EvidenceView evidence={evidence} />;
  if (reviewWithoutEvidence || !live) {
    return (
      <p className={cx("mt-2 mb-0 text-sm", mutedTextClass)} data-vad-state="unavailable">
        No speech detection for this recording: speech and silence are unknown.
      </p>
    );
  }
  const toSession = (seconds: number) =>
    liveDescriptor ? streamSecondsToSessionSeconds(liveDescriptor, seconds) : seconds;
  const stale = isRecording && live.status === "detected" && now - live.updatedAt > STALE_AFTER_MS;
  const spans: Span[] = [
    ...live.finalized.map((span) => sessionSpan(span, "final", toSession)),
    ...live.provisional.map((span) => sessionSpan(span, "provisional", toSession)),
    ...gaps(liveDescriptor),
  ];
  if (live.status !== "detected") {
    spans.push({ startSeconds: 0, endSeconds: toSession(live.receivedSeconds), kind: "unknown" });
  }
  const end = Math.max(toSession(live.receivedSeconds), ...spans.map((span) => span.endSeconds), 1);
  return (
    <div className="mt-2" data-vad-state={stale ? "stale" : live.status}>
      <p className={cx("m-0 text-sm", mutedTextClass)} aria-live="polite">
        {liveStatusText(live, stale)}
      </p>
      {live.provider && <ProviderLine provider={live.provider} />}
      <Bar spans={spans} end={end} />
      <SpanList spans={spans} />
      {live.captureMetrics && <CaptureHealth metrics={live.captureMetrics} />}
    </div>
  );
}

function EvidenceView({ evidence }: { evidence: VoiceActivityEvidence }) {
  const spans: Span[] = [
    ...evidence.speech.map((span) => ({ ...span, kind: "final" as const })),
    ...evidence.unknown.map((gap) => ({ ...gap, kind: "unknown" as const })),
  ];
  if (evidence.status !== "detected") {
    spans.push({ ...evidence.coverage, kind: "unknown" });
  }
  const end = Math.max(evidence.coverage.endSeconds, ...spans.map((span) => span.endSeconds), 1);
  const speechSeconds = evidence.speech.reduce(
    (total, span) => total + span.endSeconds - span.startSeconds,
    0,
  );
  return (
    <div className="mt-2" data-vad-state={evidence.status}>
      <p className={cx("m-0 text-sm", mutedTextClass)}>
        {evidence.status === "detected"
          ? `${evidence.speech.length} unattributed speech interval${evidence.speech.length === 1 ? "" : "s"}, ${speechSeconds.toFixed(1)} s, in ${evidence.coverage.startSeconds.toFixed(1)}–${evidence.coverage.endSeconds.toFixed(1)} s analyzed after recording.`
          : `Speech detection ${evidence.status}: speech and silence are unknown.${evidence.reason ? ` ${evidence.reason}` : ""}`}
      </p>
      {evidence.provider && <ProviderLine provider={evidence.provider} />}
      {evidence.live && (
        <p
          className={cx("m-0 text-xs", mutedTextClass)}
          data-vad-parity={evidence.live.parity.state}
        >
          Live detection: {parityText(evidence.live.parity)}
        </p>
      )}
      <Bar spans={spans} end={end} />
      <SpanList spans={spans} />
    </div>
  );
}

function ProviderLine({ provider }: { provider: VoiceActivityProvider }) {
  return (
    <p className={cx("m-0 text-xs", mutedTextClass)}>
      {provider.id} · {provider.model} · sha256 {provider.modelSha256.slice(0, 12)} · threshold{" "}
      {provider.threshold}
    </p>
  );
}

function Bar({ spans, end }: { spans: Span[]; end: number }) {
  return (
    <div
      className="relative my-2 h-6 overflow-hidden rounded bg-[#eef3f0]"
      role="img"
      aria-label="Speech timeline: solid is detected speech, light is provisional, striped is unknown"
    >
      {spans.map((span, index) => (
        <span
          key={`${span.kind}-${index}`}
          data-vad-span={span.kind}
          className={cx(
            "absolute top-0 h-full",
            span.kind === "final" && "bg-[#1c6b5a]",
            span.kind === "provisional" && "border border-dashed border-[#1c6b5a] bg-[#9fd6c2]",
            span.kind === "unknown" &&
              "bg-[repeating-linear-gradient(45deg,#c9d1cc_0,#c9d1cc_4px,transparent_4px,transparent_8px)]",
          )}
          style={{
            left: `${(Math.max(0, span.startSeconds) / end) * 100}%`,
            width: `${(Math.max(0, span.endSeconds - span.startSeconds) / end) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

function SpanList({ spans }: { spans: Span[] }) {
  const sorted = [...spans].sort((a, b) => a.startSeconds - b.startSeconds);
  return (
    <ul className="sr-only" aria-label="Speech timeline intervals">
      {sorted.map((span, index) => (
        <li key={index}>
          {span.kind === "unknown"
            ? "Unknown"
            : `Unattributed speech (${span.kind === "final" ? "final" : "provisional"})`}{" "}
          {span.startSeconds.toFixed(2)}–{span.endSeconds.toFixed(2)} s
        </li>
      ))}
    </ul>
  );
}

function CaptureHealth({ metrics }: { metrics: MeasuredCaptureMetrics }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs" aria-label="Capture health">
      <span className={eyebrowClass}>Capture health</span>
      <span data-capture-marker="clipping">
        Clipping {(metrics.clippedSampleRatio * 100).toFixed(2)}%
      </span>
      <span data-capture-marker="no-input">No input {metrics.noInputSeconds.toFixed(1)} s</span>
      <span data-capture-marker="activity">
        Sound activity {metrics.activitySeconds.toFixed(1)} s (level only, not speech)
      </span>
    </div>
  );
}

function sessionSpan(
  span: DetectorSpan,
  kind: "final" | "provisional",
  toSession: (seconds: number) => number,
): Span {
  return {
    startSeconds: toSession(span.startSeconds),
    endSeconds: toSession(span.endSeconds),
    kind,
  };
}

function gaps(descriptor: RecordingDescriptor | null): Span[] {
  return (descriptor?.discontinuities ?? []).map((gap) => ({
    startSeconds: gap.startSeconds,
    endSeconds: gap.endSeconds,
    kind: "unknown",
  }));
}

function liveStatusText(live: LiveVoiceActivity, stale: boolean) {
  if (stale) return "Speech detection is behind: the timeline is stale.";
  switch (live.status) {
    case "starting":
      return "Starting speech detection.";
    case "detected":
      return live.finished
        ? `${live.finalized.length} unattributed speech interval${live.finalized.length === 1 ? "" : "s"} detected live.`
        : `Detecting speech: ${live.finalized.length} final, ${live.provisional.length} provisional.`;
    case "unavailable":
      return `Speech detection unavailable: speech and silence are unknown. ${live.reason ?? ""}`.trim();
    case "interrupted":
      return `Speech detection stopped: ${live.reason ?? "audio was missing"}. Later speech is unknown.`;
    case "failed":
      return `Speech detection failed: ${live.reason ?? "unknown error"}. Speech is unknown.`;
  }
}

function parityText(parity: LiveFiniteParity) {
  switch (parity.state) {
    case "match":
      return `matched the analysis after recording exactly (${parity.spans} intervals).`;
    case "mismatch":
      return `differed from the analysis after recording (${parity.liveSpans} vs ${parity.finiteSpans} intervals, up to ${parity.maxBoundaryDeltaSeconds.toFixed(3)} s).`;
    case "notComparable":
      return `not comparable: ${parity.reason}.`;
  }
}
