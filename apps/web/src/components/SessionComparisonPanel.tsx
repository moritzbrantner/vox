import {
  type AssistanceCondition,
  canonicalSpokenLanguage,
  type CapabilityStatus,
  compareSessions,
  LANGUAGE_CAPABILITIES,
  type SessionSide,
  type SpeakingTask,
  UNKNOWN_SPOKEN_LANGUAGE,
} from "@stutter-tracker/shared";
import { useMemo, useState } from "react";
import type { SavedSession } from "../types";
import { buttonClass, controlClass, cx, mutedTextClass, panelClass } from "./styles";

const TASKS: Record<SpeakingTask["kind"], string> = {
  reading: "Reading aloud",
  monologue: "Spontaneous monologue",
  conversation: "Conversation",
  phoneCall: "Phone-like call",
  presentation: "Presentation",
  other: "Other",
};
const LANGUAGES = { en: "English", de: "German", es: "Spanish" } as const;
const STATUS: Record<CapabilityStatus, string> = {
  available: "Available",
  evaluated: "Evaluated",
  notEvaluated: "Runs, not evaluated",
  notAvailable: "Not available",
};
const VERDICTS = {
  lower: "Fewer reviewed events per speaking minute in session 2.",
  higher: "More reviewed events per speaking minute in session 2.",
  unchanged: "About the same rate of reviewed events (within 10%).",
  mixed:
    "Mixed: session 2 has a lower rate but much less speech, or a rate could not be computed. Fewer events while speaking less is not an improvement on its own.",
  noEvents: "Neither session has reviewed events.",
} as const;

export type ContextTags = {
  task: SpeakingTask | null;
  condition: AssistanceCondition | null;
  spokenLanguage?: string;
};

/**
 * Tags a saved session's speaking context and compares two matched sessions on reviewed labels
 * (vox#28). Measures are shown separately with their denominators; there is no combined score.
 */
export function SessionComparisonPanel({
  sessions,
  session,
  disabled,
  onTag,
}: {
  /** The user's own sessions (no review copies). */
  sessions: SavedSession[];
  session: SavedSession | null;
  disabled: boolean;
  onTag: (sessionId: string, tags: ContextTags) => Promise<boolean>;
}) {
  const [firstId, setFirstId] = useState("");
  const [secondId, setSecondId] = useState("");
  const first = sessions.find((candidate) => candidate.id === firstId) ?? null;
  const second = sessions.find((candidate) => candidate.id === secondId) ?? null;
  const comparison = useMemo(
    () => (first && second ? compareSessions(first, second) : null),
    [first, second],
  );

  return (
    <section className={cx(panelClass, "mb-4 p-4")} aria-labelledby="comparison-heading">
      <h2 id="comparison-heading" className="m-0 mb-1 text-lg">
        Compare two sessions
      </h2>
      <p className={cx("m-0 mb-3 text-sm", mutedTextClass)}>
        Compares reviewed labels of two sessions with the same language and speaking task. Tag a
        session's task and condition first.
      </p>

      <details className="mb-3 text-sm">
        <summary className="cursor-pointer">Language support</summary>
        <table className="mt-2 border-collapse" aria-label="Language support">
          <thead>
            <tr>
              <th className="pr-3 text-left">Language</th>
              <th className="pr-3 text-left">Recording and review</th>
              <th className="pr-3 text-left">Transcription</th>
              <th className="pr-3 text-left">Event detection</th>
              <th className="text-left">Reviewed practice</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(LANGUAGE_CAPABILITIES).map(([code, capabilities]) => (
              <tr key={code} title={capabilities.note}>
                <td className="pr-3">{LANGUAGES[code as keyof typeof LANGUAGES]}</td>
                <td className="pr-3">{STATUS[capabilities.recordingAndReview]}</td>
                <td className="pr-3">{STATUS[capabilities.transcription]}</td>
                <td className="pr-3">{STATUS[capabilities.eventDetection]}</td>
                <td>{STATUS[capabilities.reviewedPractice]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className={cx("m-0 mt-2 pl-5", mutedTextClass)}>
          {Object.entries(LANGUAGE_CAPABILITIES).map(([code, capabilities]) => (
            <li key={code}>
              {LANGUAGES[code as keyof typeof LANGUAGES]}: {capabilities.note}
            </li>
          ))}
        </ul>
      </details>

      {session && !session.reviewCopy && (
        <ContextForm
          key={`${session.id}:${JSON.stringify(session.context)}`}
          session={session}
          disabled={disabled}
          onTag={(tags) => onTag(session.id, tags)}
        />
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        {(
          [
            ["Session 1", firstId, setFirstId],
            ["Session 2", secondId, setSecondId],
          ] as const
        ).map(([label, value, setValue]) => (
          <label key={label} className="flex flex-col text-sm">
            {label}
            <select
              className={controlClass}
              value={value}
              onChange={(change) => setValue(change.target.value)}
            >
              <option value="">Choose…</option>
              {sessions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {sessionLabel(candidate)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {comparison && !comparison.comparable && (
        <div className="mt-3 text-sm" role="status">
          <p className="m-0">These sessions cannot be compared:</p>
          <ul className="m-0 pl-5">
            {comparison.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {comparison?.comparable && (
        <div className="mt-3 text-sm" aria-label="Comparison result" role="group">
          <p className="m-0 mb-2 font-semibold">{VERDICTS[comparison.verdict]}</p>
          <p className="m-0 mb-2">
            Language {comparison.language} · task {comparison.task}. Rates are reviewed disfluency
            events per minute of transcribed speech; typical fillers are counted separately.
          </p>
          <table className="mb-2 border-collapse">
            <thead>
              <tr>
                <th className="pr-4 text-left">Measure</th>
                <th className="pr-4 text-left">Session 1</th>
                <th className="text-left">Session 2</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([label, value]) => (
                <tr key={label}>
                  <td className="pr-4">{label}</td>
                  <td className="pr-4">{value(comparison.first)}</td>
                  <td>{value(comparison.second)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className={cx("m-0 pl-5", mutedTextClass)}>
            {comparison.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const ROWS: Array<[string, (side: SessionSide) => string]> = [
  ["Condition", (side) => side.condition],
  ["Speaking time", (side) => `${side.speakingSeconds.toFixed(1)} s`],
  ["Words", (side) => String(side.wordCount)],
  ["Reviewed events", (side) => `${side.events} (${side.possibleEvents} possible)`],
  [
    "Events per speaking minute",
    (side) =>
      side.eventsPerSpeakingMinute === null ? "n/a" : side.eventsPerSpeakingMinute.toFixed(2),
  ],
  [
    "Median / longest event",
    (side) =>
      side.medianEventSeconds === null
        ? "n/a"
        : `${side.medianEventSeconds.toFixed(2)} s / ${side.longestEventSeconds!.toFixed(2)} s`,
  ],
  ["Typical fillers", (side) => String(side.fillers)],
  ["Reviewed by", (side) => side.reviewedBy],
];

function ContextForm({
  session,
  disabled,
  onTag,
}: {
  session: SavedSession;
  disabled: boolean;
  onTag: (tags: ContextTags) => Promise<boolean>;
}) {
  const [task, setTask] = useState<SpeakingTask["kind"] | "">(session.context.task?.kind ?? "");
  const [trained, setTrained] = useState(session.context.task?.trained ?? false);
  const [condition, setCondition] = useState<"" | "unassisted" | "assisted">(
    session.context.condition?.kind ?? "",
  );
  const [aidId, setAidId] = useState(
    session.context.condition?.kind === "assisted" ? session.context.condition.aidId : "",
  );
  const languageUnknown =
    canonicalSpokenLanguage(session.context.spokenLanguage) === UNKNOWN_SPOKEN_LANGUAGE;
  const [language, setLanguage] = useState("");
  const invalid = condition === "assisted" && !aidId.trim();

  return (
    <fieldset className="m-0 flex flex-wrap items-end gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-semibold">Context of the open session</legend>
      <label className="flex flex-col text-sm">
        Speaking task
        <select
          className={controlClass}
          value={task}
          onChange={(change) => setTask(change.target.value as SpeakingTask["kind"] | "")}
        >
          <option value="">Not recorded</option>
          {Object.entries(TASKS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={trained}
          disabled={!task}
          onChange={(change) => setTrained(change.target.checked)}
        />
        Practised task
      </label>
      <label className="flex flex-col text-sm">
        Assistance
        <select
          className={controlClass}
          value={condition}
          onChange={(change) => setCondition(change.target.value as typeof condition)}
        >
          <option value="">Not recorded</option>
          <option value="unassisted">Unassisted</option>
          <option value="assisted">Assisted</option>
        </select>
      </label>
      {condition === "assisted" && (
        <label className="flex flex-col text-sm">
          Aid used
          <input
            className={controlClass}
            value={aidId}
            onChange={(change) => setAidId(change.target.value)}
          />
        </label>
      )}
      {languageUnknown && (
        <label className="flex flex-col text-sm">
          Spoken language (not recorded)
          <select
            className={controlClass}
            value={language}
            onChange={(change) => setLanguage(change.target.value)}
          >
            <option value="">Leave unknown</option>
            {Object.entries(LANGUAGES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className={buttonClass}
        disabled={disabled || invalid}
        onClick={() =>
          void onTag({
            task: task ? { kind: task, trained } : null,
            condition:
              condition === "unassisted"
                ? { kind: "unassisted" }
                : condition === "assisted"
                  ? { kind: "assisted", aidId: aidId.trim() }
                  : null,
            ...(languageUnknown && language ? { spokenLanguage: language } : {}),
          })
        }
      >
        Save context
      </button>
    </fieldset>
  );
}

function sessionLabel(session: SavedSession) {
  const task = session.context.task ? TASKS[session.context.task.kind] : "task not recorded";
  return `${new Date(session.startedAt).toLocaleString()} · ${task}`;
}
