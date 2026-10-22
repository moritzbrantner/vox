import type { CaptureStreamRole } from "@stutter-tracker/shared";
import { Headphones, Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
  type AuditoryFeedbackSession,
  type AuditoryFeedbackSettings,
  type LabCapture,
  startAuditoryFeedbackSession,
} from "../audio/auditoryFeedback";
import {
  clampDisplayValue,
  FEEDBACK_CONTROL_SPECS,
  type FeedbackControlKey,
  fromDisplayValue,
  parseDisplayValue,
  stepDisplayValue,
  toDisplayValue,
} from "../audio/feedbackControls";
import { loadFeedbackSettings, saveFeedbackSettings } from "../storage/feedbackSettings";

/** A replayable capture keeps the stream role from its recording descriptor. */
type ReplayCapture = { url: string; role: CaptureStreamRole };

type RecordingUrls = {
  raw: ReplayCapture | null;
  processed: ReplayCapture | null;
};

const REPLAY_TEXT: Record<CaptureStreamRole, { title: string; description: string }> = {
  appInput: {
    title: "Untouched microphone",
    description: "What the microphone captured before the feedback processing graph.",
  },
  interventionOutput: {
    title: "Monitored feedback",
    description: "The dry/altered mix after delay, pitch processing, limiter, and monitor gain.",
  },
};

function replayCapture(capture: LabCapture | null): ReplayCapture | null {
  return capture ? { url: URL.createObjectURL(capture.blob), role: capture.descriptor.role } : null;
}

type PitchSupport = "unknown" | "supported" | "unsupported";

const DELAY_PRESETS = [0, 25, 50, 75, 100, 150, 200];

export function AuditoryFeedbackLab() {
  const [settings, setSettings] = useState<AuditoryFeedbackSettings>(() => loadFeedbackSettings());
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [pitchSupport, setPitchSupport] = useState<PitchSupport>("unknown");
  const [status, setStatus] = useState(
    "Connect headphones, choose a feedback setting, then start a short practice trial.",
  );
  const [recordingUrls, setRecordingUrls] = useState<RecordingUrls>({
    raw: null,
    processed: null,
  });
  const sessionRef = useRef<AuditoryFeedbackSession | null>(null);
  const startRef = useRef<AbortController | null>(null);
  const recordingUrlsRef = useRef(recordingUrls);
  const mountedRef = useRef(true);
  const [isStarting, setIsStarting] = useState(false);

  // Latest settings, so a session that finishes starting picks up edits made while it started.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
    sessionRef.current?.update(settings);
    saveFeedbackSettings(settings);
  }, [settings]);

  const setControl = (key: FeedbackControlKey, value: number) =>
    setSettings((current) => ({ ...current, [key]: value }));
  // What the engine actually applies: pitch shifting needs the worklet.
  const pitchApplied = pitchSupport !== "unsupported";

  useEffect(() => {
    recordingUrlsRef.current = recordingUrls;
  }, [recordingUrls]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startRef.current?.abort();
      startRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      void session?.stop().catch(() => undefined);
      releaseRecordingUrls(recordingUrlsRef.current);
    };
  }, []);

  async function startFeedback() {
    if (!headphonesConfirmed || isActive || isStopping || startRef.current) {
      return;
    }
    const controller = new AbortController();
    startRef.current = controller;
    setIsStarting(true);
    setStatus("Requesting microphone access…");
    try {
      const session = await startAuditoryFeedbackSession(settings, {
        signal: controller.signal,
        onInterrupted: (reason) => void finishFeedback(session, reason),
      });
      if (controller.signal.aborted || !mountedRef.current) {
        void session.stop().catch(() => undefined);
        return;
      }
      sessionRef.current = session;
      session.update(settingsRef.current);
      setIsActive(true);
      setPitchSupport(session.capabilities.pitchShift ? "supported" : "unsupported");
      setStatus(
        session.capabilities.localCapture
          ? "Feedback is live. The raw and processed comparison stays only in this browser tab."
          : "Feedback is live. This browser cannot make the local comparison recording.",
      );
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setStatus(
        controller.signal.aborted
          ? "Feedback start was cancelled."
          : error instanceof Error
            ? error.message
            : "Unable to start live audio feedback",
      );
    } finally {
      if (startRef.current === controller) {
        startRef.current = null;
      }
      if (mountedRef.current) {
        setIsStarting(false);
      }
    }
  }

  function stopFeedback() {
    if (startRef.current) {
      startRef.current.abort();
      return;
    }
    const session = sessionRef.current;
    if (session) {
      void finishFeedback(session);
    }
  }

  // Shared by Stop and engine interruptions. session.stop() silences output synchronously,
  // so the UI never waits on recorder finalization to make the trial inaudible.
  async function finishFeedback(session: AuditoryFeedbackSession, interruptedReason?: string) {
    if (sessionRef.current !== session) {
      return;
    }
    sessionRef.current = null;
    const stopping = session.stop();
    setIsStopping(true);
    setStatus(interruptedReason ?? "Feedback stopped. Preparing the local comparison…");
    try {
      const recording = await stopping;
      if (!mountedRef.current) {
        return;
      }
      const nextUrls = {
        raw: replayCapture(recording.raw),
        processed: replayCapture(recording.processed),
      };
      setRecordingUrls((current) => {
        releaseRecordingUrls(current);
        return nextUrls;
      });
      if (!interruptedReason) {
        setStatus(
          nextUrls.raw && nextUrls.processed
            ? "Trial stopped. Compare the untouched microphone recording with the monitored feedback below."
            : "Trial stopped.",
        );
      }
    } catch (error) {
      if (mountedRef.current) {
        setStatus(error instanceof Error ? error.message : "Unable to finish the feedback trial");
      }
    } finally {
      if (mountedRef.current) {
        setIsActive(false);
        setIsStopping(false);
      }
    }
  }

  function resetSettings() {
    setSettings(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);
  }

  return (
    <section className="mx-auto max-w-[1420px] px-5 pb-8 text-[#17201b] max-sm:px-3">
      <div className="rounded-[24px] border border-[#dfe6e1] bg-white p-5 shadow-sm">
        <div className="mb-5 flex items-start justify-between gap-4 max-md:flex-col">
          <div className="max-w-3xl">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[#5c6c62]">
              Practice experiment
            </p>
            <h2 className="text-2xl font-semibold tracking-tight">Auditory Feedback Lab</h2>
            <p className="mt-2 text-sm leading-6 text-[#536158]">
              Hear your own microphone with a controlled delay, optional pitch shift, and adjustable
              dry/altered mix. People respond differently to altered auditory feedback, so use short
              trials to learn what feels easier rather than treating one setting as a target.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-[#ccd7d0] px-3 py-2 text-sm font-medium hover:bg-[#f4f7f5] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={resetSettings}
            disabled={isActive || isStarting || isStopping}
          >
            <RotateCcw size={16} aria-hidden="true" />
            Reset
          </button>
        </div>

        <div className="mb-5 rounded-2xl border border-[#e1e7e3] bg-[#f7f9f7] p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              className="mt-1 h-4 w-4 accent-[#276749]"
              type="checkbox"
              checked={headphonesConfirmed}
              disabled={isActive || isStarting || isStopping}
              onChange={(event) => setHeadphonesConfirmed(event.target.checked)}
            />
            <span>
              <span className="flex items-center gap-2 font-medium">
                <Headphones size={17} aria-hidden="true" />I am using headphones
              </span>
              <span className="mt-1 block text-sm leading-5 text-[#657169]">
                The browser cannot reliably prove that audio is going only to headphones. This gate
                reduces the risk of loudspeaker feedback before microphone monitoring starts.
              </span>
            </span>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-6 max-md:grid-cols-1">
          <Control
            label="Feedback delay"
            field={
              <NumericField
                controlKey="delayMs"
                label="Feedback delay"
                value={settings.delayMs}
                onCommit={(value) => setControl("delayMs", value)}
              />
            }
            hint="The delay added to the altered voice path. The default is a starting point, not a recommended or clinically optimal setting. Wireless headphones add their own latency on top."
          >
            <input
              className="w-full accent-[#276749]"
              aria-label="Feedback delay"
              type="range"
              min="0"
              max="200"
              step="1"
              value={settings.delayMs}
              onChange={(event) =>
                setSettings((current) => ({ ...current, delayMs: Number(event.target.value) }))
              }
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {DELAY_PRESETS.map((delayMs) => (
                <button
                  key={delayMs}
                  type="button"
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                    settings.delayMs === delayMs
                      ? "border-[#276749] bg-[#eaf4ee] text-[#1f573e]"
                      : "border-[#d8e0da] text-[#59665e] hover:bg-[#f4f7f5]"
                  }`}
                  onClick={() => setSettings((current) => ({ ...current, delayMs }))}
                >
                  {delayMs} ms
                </button>
              ))}
            </div>
          </Control>

          <Control
            label="Pitch shift"
            field={
              <NumericField
                controlKey="pitchShiftSemitones"
                label="Pitch shift"
                value={settings.pitchShiftSemitones}
                disabled={!pitchApplied}
                onCommit={(value) => setControl("pitchShiftSemitones", value)}
              />
            }
            hint={
              pitchApplied
                ? "Optional frequency-altered feedback. Pitch processing adds a small amount of processing latency."
                : `This browser cannot load the real-time pitch processor, so pitch shifting is off. Your requested ${formatSemitones(settings.pitchShiftSemitones)} is kept but not applied.`
            }
          >
            <input
              className="w-full accent-[#276749] disabled:opacity-40"
              aria-label="Pitch shift"
              type="range"
              min="-4"
              max="4"
              step="0.5"
              value={settings.pitchShiftSemitones}
              disabled={!pitchApplied}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  pitchShiftSemitones: Number(event.target.value),
                }))
              }
            />
          </Control>

          <Control
            label="Altered voice mix"
            field={
              <NumericField
                controlKey="wetMix"
                label="Altered voice mix"
                value={settings.wetMix}
                onCommit={(value) => setControl("wetMix", value)}
              />
            }
            hint="0% is immediate microphone sidetone; 100% is only the delayed/pitch-shifted path."
          >
            <input
              className="w-full accent-[#276749]"
              aria-label="Altered voice mix"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={settings.wetMix}
              onChange={(event) =>
                setSettings((current) => ({ ...current, wetMix: Number(event.target.value) }))
              }
            />
          </Control>

          <Control
            label="Monitor level"
            field={
              <NumericField
                controlKey="outputGain"
                label="Monitor level"
                value={settings.outputGain}
                onCommit={(value) => setControl("outputGain", value)}
              />
            }
            hint="The signal is capped below full scale and passes a fast limiter. That limits the signal, not how loud your device and headphones play it: set device volume low first and raise the level only if comfortable."
          >
            <input
              className="w-full accent-[#276749]"
              aria-label="Monitor level"
              type="range"
              min="0.15"
              max="0.8"
              step="0.01"
              value={settings.outputGain}
              onChange={(event) =>
                setSettings((current) => ({ ...current, outputGain: Number(event.target.value) }))
              }
            />
          </Control>
        </div>

        <ul className="mt-6 list-disc space-y-1 pl-5 text-sm leading-5 text-[#536158]">
          <li>Start only when you mean to: your microphone plays straight into your headphones.</li>
          <li>Stop at once if it is uncomfortable, too loud, or makes speaking harder.</li>
          <li>
            Do not use it where you need to hear your surroundings, such as traffic or alarms.
          </li>
        </ul>

        {/* Output is silent from the moment Stop begins, so the line goes with it. */}
        {isActive && !isStopping && (
          <p
            className="mt-4 rounded-xl bg-[#f3f7f4] px-3 py-2 text-sm text-[#2f4a3b]"
            aria-label="Effective feedback settings"
          >
            Running now: {settings.delayMs} ms delay ·{" "}
            {pitchApplied
              ? `pitch shift ${formatSemitones(settings.pitchShiftSemitones)}`
              : `pitch shift off (not available; requested ${formatSemitones(settings.pitchShiftSemitones)})`}{" "}
            · {Math.round(settings.wetMix * 100)}% altered mix ·{" "}
            {Math.round(settings.outputGain * 100)}% monitor level
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[#e5ebe7] pt-5">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full bg-[#235d41] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1b4c35] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={startFeedback}
            disabled={!headphonesConfirmed || isActive || isStarting || isStopping}
          >
            <Play size={16} fill="currentColor" aria-hidden="true" />
            Start feedback
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-[#cbd6cf] px-4 py-2.5 text-sm font-semibold hover:bg-[#f4f7f5] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={stopFeedback}
            disabled={!(isActive || isStarting) || isStopping}
          >
            <Square size={15} fill="currentColor" aria-hidden="true" />
            {isStopping ? "Stopping…" : isStarting ? "Cancel" : "Stop & compare"}
          </button>
          <p className="min-w-0 flex-1 text-sm text-[#5d6a62]" role="status" aria-live="polite">
            {status}
          </p>
        </div>

        {(recordingUrls.raw || recordingUrls.processed) && (
          <div className="mt-6 grid grid-cols-2 gap-4 border-t border-[#e5ebe7] pt-5 max-md:grid-cols-1">
            {[recordingUrls.raw, recordingUrls.processed].map(
              (capture) =>
                capture && (
                  <ComparisonRecording
                    key={capture.role}
                    {...REPLAY_TEXT[capture.role]}
                    url={capture.url}
                  />
                ),
            )}
          </div>
        )}

        <p className="mt-5 text-xs leading-5 text-[#6d786f]">
          This is a practice and measurement aid, not a diagnostic or treatment device. Stop the
          trial if the monitoring is uncomfortable, distracting, or makes speaking harder.
        </p>
      </div>
    </section>
  );
}

function Control({
  label,
  field,
  hint,
  children,
}: {
  label: string;
  field: React.ReactNode;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold">{label}</span>
        {field}
      </div>
      {children}
      <p className="mt-2 text-xs leading-5 text-[#6a756d]">{hint}</p>
    </div>
  );
}

function ComparisonRecording({
  title,
  description,
  url,
}: {
  title: string;
  description: string;
  url: string;
}) {
  return (
    <div className="rounded-2xl border border-[#e0e7e2] bg-[#fafbfa] p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-[#68736b]">{description}</p>
      <audio className="mt-3 w-full" controls preload="metadata" src={url} />
    </div>
  );
}

function releaseRecordingUrls(urls: RecordingUrls) {
  for (const capture of [urls.raw, urls.processed]) {
    if (capture) {
      URL.revokeObjectURL(capture.url);
    }
  }
}

/**
 * Exact numeric entry. Typing commits on Enter or blur (clamped to the lab range, invalid text
 * reverts); arrow keys step by the fine step, Shift + arrow by the coarse step.
 */
function NumericField({
  controlKey,
  label,
  value,
  disabled = false,
  onCommit,
}: {
  controlKey: FeedbackControlKey;
  label: string;
  value: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const spec = FEEDBACK_CONTROL_SPECS[controlKey];
  const display = toDisplayValue(controlKey, value);
  const [draft, setDraft] = useState<string | null>(null);
  // While typing, expose the value the draft would commit; omit it while the draft is invalid.
  const draftValue = draft === null ? display : parseDisplayValue(draft);
  const ariaValue = draftValue === null ? undefined : clampDisplayValue(controlKey, draftValue);

  const commit = (text: string) => {
    const parsed = parseDisplayValue(text);
    setDraft(null);
    if (parsed !== null) {
      onCommit(fromDisplayValue(controlKey, parsed));
    }
  };

  return (
    <span className="inline-flex items-center gap-1 text-sm tabular-nums text-[#4e5d54]">
      <input
        className="w-16 rounded-md border border-[#ccd7d0] px-1.5 py-0.5 text-right disabled:opacity-50"
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-label={`${label} (${spec.unit})`}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={ariaValue}
        value={draft ?? String(display)}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit(event.currentTarget.value);
          } else if (event.key === "Escape") {
            setDraft(null);
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const base = parseDisplayValue(event.currentTarget.value) ?? display;
            setDraft(null);
            onCommit(
              fromDisplayValue(
                controlKey,
                stepDisplayValue(
                  controlKey,
                  base,
                  event.key === "ArrowUp" ? 1 : -1,
                  event.shiftKey,
                ),
              ),
            );
          }
        }}
      />
      <span aria-hidden="true">{spec.unit}</span>
    </span>
  );
}

function formatSemitones(semitones: number) {
  return `${semitones > 0 ? "+" : ""}${semitones} st`;
}
