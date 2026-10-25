import {
  type AnnotatedEvent,
  type AnnotationRater,
  type AnnotationEdit,
  type AnnotatorRole,
  annotatedEventError,
  createAnnotationEditor,
  currentRevisionBy,
  editAnnotation,
  redoAnnotation,
  roundAnnotationSeconds,
  sameRater,
  sameEvents,
  type AnnotationLabel,
  undoAnnotation,
} from "@stutter-tracker/shared";
import { Play, Redo2, Trash2, Undo2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { KeptSessionAudio } from "../storage/sessionAudio";
import type { SavedSession } from "../types";
import { ReviewAudioPanel, useReviewAudio } from "./ReviewAudio";
import { TIMING_NOT_ALIGNED } from "./TranscriptText";
import {
  buttonClass,
  controlClass,
  cx,
  mutedTextClass,
  panelClass,
  primaryButtonClass,
} from "./styles";

export type AnnotationSaveRequest = {
  author: AnnotationRater;
  events: AnnotatedEvent[];
  status: "draft" | "accepted";
  /** Annotated without seeing any analysis (blind review). */
  blind: boolean;
};

const KIND_LABELS: Record<AnnotationLabel, string> = {
  soundRepetition: "Sound/syllable repetition",
  wordRepetition: "Word repetition",
  prolongation: "Prolongation",
  block: "Block",
  filler: "Filler / typical disfluency",
  noSpeech: "No speech",
  overlap: "Overlapping speakers",
  unusable: "Unusable / uncertain audio",
};
const ROLE_LABELS: Record<AnnotatorRole, string> = {
  self: "Self (my own speech)",
  clinician: "Clinician",
  researcher: "Researcher",
};
/** Arrow keys nudge a boundary by 10 ms; with Shift by 100 ms. */
const NUDGE_SECONDS = 0.01;
const COARSE_NUDGE_SECONDS = 0.1;

/**
 * One rater's event-span editor for a saved session. Spans are entered as exact seconds on the
 * session clock; saving appends a revision and never changes the observation or another rater's
 * revisions.
 */
export function AnnotationWorkbench({
  session,
  audio,
  blind = false,
  disabled,
  onSave,
}: {
  session: SavedSession;
  /** Audio the user kept with this session; null when none was kept. */
  audio: KeptSessionAudio | null;
  /** Blind review: the rater has not been shown this session's analysis. */
  blind?: boolean;
  disabled: boolean;
  onSave: (request: AnnotationSaveRequest) => Promise<boolean>;
}) {
  const [role, setRole] = useState<AnnotatorRole>("self");
  const [raterId, setRaterId] = useState("");
  const author = useMemo<AnnotationRater>(
    () => (raterId.trim() ? { role, id: raterId.trim() } : { role }),
    [role, raterId],
  );
  const baseline = currentRevisionBy(session, author);
  const startEvents = (rater: AnnotationRater) => currentRevisionBy(session, rater)?.events;
  const [editor, setEditor] = useState(() => createAnnotationEditor(startEvents(author)));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const review = useReviewAudio(audio);
  const [draft, setDraft] = useState<AnnotatedEvent>({
    kind: "block",
    startSeconds: Number.NaN,
    endSeconds: Number.NaN,
    certainty: "certain",
  });

  // Switching rater loads that rater's current revision; unsaved edits of the previous rater
  // are not carried over to someone else.
  const loadedFor = useRef(author);
  useEffect(() => {
    if (sameRater(loadedFor.current, author)) return;
    loadedFor.current = author;
    setEditor(createAnnotationEditor(startEvents(author)));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [author, session]);

  const dirty = !sameEvents(editor.events, baseline?.events ?? []);
  const otherRevisions = session.annotations.filter(
    (revision) => !sameRater(revision.author, author),
  ).length;

  function apply(edit: AnnotationEdit) {
    const result = editAnnotation(editor, edit);
    setEditor(result.state);
    setError(result.error);
    return result.error === null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      setEditor(undoAnnotation(editor));
      setError(null);
    } else if ((key === "z" && event.shiftKey) || key === "y") {
      event.preventDefault();
      setEditor(redoAnnotation(editor));
      setError(null);
    }
  }

  async function save(status: "draft" | "accepted") {
    setSaving(true);
    try {
      // On failure the edits stay on screen, so nothing typed is lost.
      if (await onSave({ author, events: editor.events, status, blind })) {
        setEditor(createAnnotationEditor(editor.events));
      }
    } finally {
      setSaving(false);
    }
  }

  function addDraft() {
    const added = apply({ type: "add", event: draft });
    if (added) setDraft({ ...draft, startSeconds: Number.NaN, endSeconds: Number.NaN, note: "" });
  }

  const draftError = annotatedEventError(draft);

  return (
    <section
      className={cx(panelClass, "mb-4 p-4")}
      aria-labelledby="annotation-heading"
      onKeyDown={onKeyDown}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="annotation-heading" className="m-0 text-lg">
            Annotate events
          </h2>
          <p className={cx("m-0 text-sm", mutedTextClass)}>
            Times are seconds from the session start. Arrow Up/Down nudges a boundary by 10 ms
            (Shift: 100 ms); Ctrl+Z / Ctrl+Shift+Z undo and redo. Saving adds a revision; earlier
            revisions and other raters' annotations are kept.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-sm">
            Annotating as
            <select
              className={controlClass}
              value={role}
              onChange={(event) => setRole(event.target.value as AnnotatorRole)}
            >
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            Rater name (optional)
            <input
              className={controlClass}
              value={raterId}
              onChange={(event) => setRaterId(event.target.value)}
            />
          </label>
        </div>
      </div>

      {audio ? (
        <ReviewAudioPanel
          audio={audio}
          review={review}
          events={editor.events}
          onPick={(edge, seconds) =>
            setDraft((current) =>
              edge === "start"
                ? { ...current, startSeconds: roundAnnotationSeconds(seconds) }
                : { ...current, endSeconds: roundAnnotationSeconds(seconds) },
            )
          }
        />
      ) : (
        <p className={cx("m-0 mb-3 text-sm", mutedTextClass)}>
          No audio was kept with this session, so it can only be annotated against the transcript.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="m-0 mb-2 text-base">Transcript</h3>
          {session.segments.length === 0 ? (
            <p className={cx("text-sm", mutedTextClass)}>This session has no saved transcript.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-1 p-0">
              {session.segments.map((segment, index) => (
                <li key={index} className="flex items-center gap-2 text-sm">
                  {segment.alignment === "unaligned" ? (
                    // No timing to offer: an annotation span is never taken from an estimate.
                    <span className={cx("text-xs", mutedTextClass)}>{TIMING_NOT_ALIGNED}</span>
                  ) : (
                    <button
                      type="button"
                      className={buttonClass}
                      title="Use this segment's start and end for a new event"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          startSeconds: segment.startSeconds,
                          endSeconds: segment.endSeconds,
                        })
                      }
                    >
                      {formatSeconds(segment.startSeconds)}–{formatSeconds(segment.endSeconds)}
                    </button>
                  )}
                  <span>{segment.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div>
          <h3 className="m-0 mb-2 text-base">Events</h3>
          <div className="mb-2 flex gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={editor.past.length === 0}
              onClick={() => {
                setEditor(undoAnnotation(editor));
                setError(null);
              }}
            >
              <Undo2 size={16} aria-hidden="true" /> Undo
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={editor.future.length === 0}
              onClick={() => {
                setEditor(redoAnnotation(editor));
                setError(null);
              }}
            >
              <Redo2 size={16} aria-hidden="true" /> Redo
            </button>
          </div>
          {editor.events.length === 0 && (
            <p className={cx("text-sm", mutedTextClass)}>No events annotated.</p>
          )}
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Annotated events">
            {editor.events.map((event, index) => (
              // Index keys keep focus on a boundary while it is nudged; inputs follow their value.
              <li key={index} className="flex flex-wrap items-end gap-2">
                <EventFields
                  label={`Event ${index + 1}`}
                  event={event}
                  onKind={(kind) => apply({ type: "update", index, patch: { kind } })}
                  onCertainty={(certainty) =>
                    apply({ type: "update", index, patch: { certainty } })
                  }
                  onNote={(note) => apply({ type: "update", index, patch: { note } })}
                  onTime={(edge, seconds) =>
                    apply({
                      type: "update",
                      index,
                      patch: edge === "start" ? { startSeconds: seconds } : { endSeconds: seconds },
                    })
                  }
                  onNudge={(edge, deltaSeconds) =>
                    apply({ type: "nudge", index, edge, deltaSeconds })
                  }
                />
                {audio && (
                  <button
                    type="button"
                    className={buttonClass}
                    aria-label={`Play event ${index + 1}`}
                    disabled={!review.available}
                    onClick={() => review.play(event)}
                  >
                    <Play size={16} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className={buttonClass}
                  aria-label={`Delete event ${index + 1}`}
                  onClick={() => apply({ type: "remove", index })}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-[#dae2dd] pt-3">
            <EventFields
              label="New event"
              event={draft}
              onKind={(kind) => setDraft({ ...draft, kind })}
              onCertainty={(certainty) => setDraft({ ...draft, certainty })}
              onNote={(note) => setDraft({ ...draft, note })}
              onTime={(edge, seconds) =>
                setDraft(
                  edge === "start"
                    ? { ...draft, startSeconds: seconds }
                    : { ...draft, endSeconds: seconds },
                )
              }
              onNudge={(edge, delta) => {
                const key = edge === "start" ? "startSeconds" : "endSeconds";
                if (Number.isFinite(draft[key])) {
                  setDraft({ ...draft, [key]: roundAnnotationSeconds(draft[key] + delta) });
                }
                return true;
              }}
            />
            <button
              type="button"
              className={buttonClass}
              disabled={draftError !== null}
              onClick={addDraft}
            >
              Add event
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-0 mt-3 text-sm text-[#a33b3b]">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={disabled || saving || !dirty}
          onClick={() => void save("draft")}
        >
          Save draft
        </button>
        <button
          type="button"
          className={primaryButtonClass}
          disabled={disabled || saving || (!dirty && baseline?.status === "accepted")}
          onClick={() => void save("accepted")}
        >
          Save as reference
        </button>
        <span className={cx("text-sm", mutedTextClass)}>
          {baseline
            ? `Your current revision: ${baseline.status === "accepted" ? "reference" : "draft"}${dirty ? ", unsaved changes" : ""}.`
            : dirty
              ? "Unsaved changes."
              : "No revision saved yet."}
          {otherRevisions > 0 &&
            ` ${otherRevisions} revision${otherRevisions === 1 ? "" : "s"} by other raters kept.`}
        </span>
      </div>
    </section>
  );
}

function EventFields({
  label,
  event,
  onKind,
  onCertainty,
  onNote,
  onTime,
  onNudge,
}: {
  label: string;
  event: AnnotatedEvent;
  onKind: (kind: AnnotationLabel) => void;
  onCertainty: (certainty: AnnotatedEvent["certainty"]) => void;
  onNote: (note: string) => void;
  onTime: (edge: "start" | "end", seconds: number) => boolean | void;
  onNudge: (edge: "start" | "end", deltaSeconds: number) => boolean | void;
}) {
  return (
    <fieldset className="m-0 flex flex-wrap items-end gap-2 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      <label className="flex flex-col text-sm">
        Kind
        <select
          className={controlClass}
          aria-label={`${label} kind`}
          value={event.kind}
          onChange={(change) => onKind(change.target.value as AnnotationLabel)}
        >
          {Object.entries(KIND_LABELS).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <SecondsInput
        label={`${label} start`}
        text="Start (s)"
        seconds={event.startSeconds}
        onCommit={(seconds) => onTime("start", seconds)}
        onNudge={(delta) => onNudge("start", delta)}
      />
      <SecondsInput
        label={`${label} end`}
        text="End (s)"
        seconds={event.endSeconds}
        onCommit={(seconds) => onTime("end", seconds)}
        onNudge={(delta) => onNudge("end", delta)}
      />
      <label className="flex flex-col text-sm">
        Certainty
        <select
          className={controlClass}
          aria-label={`${label} certainty`}
          value={event.certainty}
          onChange={(change) => onCertainty(change.target.value as AnnotatedEvent["certainty"])}
        >
          <option value="certain">Certain</option>
          <option value="possible">Possible</option>
        </select>
      </label>
      <NoteInput label={`${label} note`} note={event.note ?? ""} onCommit={onNote} />
    </fieldset>
  );
}

/** Typed text is committed on Enter or blur, so partial input never becomes a boundary. */
function SecondsInput({
  label,
  text,
  seconds,
  onCommit,
  onNudge,
}: {
  label: string;
  text: string;
  seconds: number;
  onCommit: (seconds: number) => boolean | void;
  onNudge: (deltaSeconds: number) => boolean | void;
}) {
  const shown = Number.isFinite(seconds) ? String(seconds) : "";
  const [value, setValue] = useState(shown);
  useEffect(() => setValue(shown), [shown]);

  function commit() {
    if (value === shown) return;
    const parsed = value.trim() === "" ? Number.NaN : Number(value);
    if (onCommit(parsed) === false) setValue(shown);
  }

  return (
    <label className="flex flex-col text-sm">
      {text}
      <input
        className={cx(controlClass, "w-24")}
        aria-label={label}
        inputMode="decimal"
        value={value}
        onChange={(change) => setValue(change.target.value)}
        onBlur={commit}
        onKeyDown={(key) => {
          if (key.key === "Enter") {
            commit();
          } else if (key.key === "ArrowUp" || key.key === "ArrowDown") {
            key.preventDefault();
            const step = key.shiftKey ? COARSE_NUDGE_SECONDS : NUDGE_SECONDS;
            onNudge(key.key === "ArrowUp" ? step : -step);
          }
        }}
      />
    </label>
  );
}

function NoteInput({
  label,
  note,
  onCommit,
}: {
  label: string;
  note: string;
  onCommit: (note: string) => void;
}) {
  const [value, setValue] = useState(note);
  useEffect(() => setValue(note), [note]);
  return (
    <label className="flex flex-col text-sm">
      Note
      <input
        className={controlClass}
        aria-label={label}
        value={value}
        onChange={(change) => setValue(change.target.value)}
        onBlur={() => value !== note && onCommit(value)}
        onKeyDown={(key) => key.key === "Enter" && value !== note && onCommit(value)}
      />
    </label>
  );
}

function formatSeconds(seconds: number) {
  return `${seconds.toFixed(2)}s`;
}
