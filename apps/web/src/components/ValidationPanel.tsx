import {
  type AnnotatedEvent,
  type AnnotationRater,
  type AnnotatorRole,
  DEFAULT_ONSET_TOLERANCE_SECONDS,
  sameRater,
  sessionValidation,
  type SpanDisagreement,
  validationReport,
} from "@stutter-tracker/shared";
import { useMemo, useState } from "react";
import type { SavedSession } from "../types";
import {
  buttonClass,
  controlClass,
  cx,
  mutedTextClass,
  panelClass,
  primaryButtonClass,
} from "./styles";

const ROLES: Record<AnnotatorRole, string> = {
  self: "Self",
  clinician: "Clinician",
  researcher: "Researcher",
};
const LABELS: Record<AnnotatedEvent["kind"], string> = {
  soundRepetition: "Sound/syllable repetition",
  wordRepetition: "Word repetition",
  prolongation: "Prolongation",
  block: "Block",
  filler: "Filler",
  noSpeech: "No speech",
  overlap: "Overlapping speakers",
  unusable: "Unusable audio",
};

/**
 * Two-rater validation: declare the raters before either annotates, compare their reference
 * revisions, list every disagreement and start an adjudication. Agreement is measured, never
 * assumed; numbers cover only the declared subset.
 */
export function ValidationPanel({
  sessions,
  session,
  disabled,
  onDeclare,
  onAdjudicate,
}: {
  sessions: SavedSession[];
  /** The session on screen, if any. */
  session: SavedSession | null;
  disabled: boolean;
  onDeclare: (sessionId: string, raters: [AnnotationRater, AnnotationRater]) => Promise<boolean>;
  onAdjudicate: (sessionId: string) => void;
}) {
  const report = useMemo(() => validationReport(sessions), [sessions]);
  const validation = session ? sessionValidation(session) : null;

  return (
    <section className={cx(panelClass, "mb-4 p-4")} aria-labelledby="validation-heading">
      <h2 id="validation-heading" className="m-0 mb-1 text-lg">
        Two-rater validation
      </h2>
      <p className={cx("m-0 mb-3 text-sm", mutedTextClass)}>
        {report.declared === 0
          ? "No sessions are declared for validation."
          : `${report.declared} declared · ${report.bothRated} rated by both · ${report.adjudicated} adjudicated · event agreement ${percent(report.positiveAgreement)} · time agreement (kappa) ${number(report.meanFrameKappa)} · ${report.disagreementCount} disagreements.`}{" "}
        Spans of the same label agree when they overlap or start within{" "}
        {DEFAULT_ONSET_TOLERANCE_SECONDS * 1000} ms; kappa compares 10 ms frames with any
        disfluency.
      </p>

      {session && !validation && (
        <DeclareForm
          session={session}
          disabled={disabled}
          onDeclare={(raters) => onDeclare(session.id, raters)}
        />
      )}

      {session && validation && (
        <div>
          <ul className="m-0 mb-2 list-none p-0 text-sm">
            {session.validation!.raters.map((rater, index) => (
              <li key={index}>
                Rater {index + 1}: {raterName(rater)} —{" "}
                {validation.ratings[index]
                  ? `reference saved${validation.blind[index] ? " in blind review" : " (analysis was visible)"}`
                  : "no reference saved yet"}
              </li>
            ))}
          </ul>
          {validation.comparison && (
            <>
              <p className="m-0 mb-2 text-sm">
                Event agreement {percent(validation.comparison.positiveAgreement)} (
                {validation.comparison.eventCounts[0]} vs {validation.comparison.eventCounts[1]}{" "}
                events) · time agreement (kappa) {number(validation.comparison.frameKappa)}
              </p>
              {validation.comparison.disagreements.length === 0 ? (
                <p className="m-0 mb-2 text-sm">No disagreements.</p>
              ) : (
                <ul className="m-0 mb-2 pl-5 text-sm" aria-label="Disagreements">
                  {validation.comparison.disagreements.map((item, index) => (
                    <li key={index}>{describe(item)}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={primaryButtonClass}
                  disabled={disabled}
                  onClick={() => onAdjudicate(session.id)}
                >
                  {validation.adjudication ? "Revise adjudication" : "Adjudicate"}
                </button>
                {validation.adjudication && (
                  <span className={cx("text-sm", mutedTextClass)}>
                    Adjudicated by {raterName(validation.adjudication.author)}; it is the session's
                    human reference.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function DeclareForm({
  session,
  disabled,
  onDeclare,
}: {
  session: SavedSession;
  disabled: boolean;
  onDeclare: (raters: [AnnotationRater, AnnotationRater]) => Promise<boolean>;
}) {
  const [roles, setRoles] = useState<[AnnotatorRole, AnnotatorRole]>(["clinician", "clinician"]);
  const [names, setNames] = useState<[string, string]>(["", ""]);
  const raters = [0, 1].map((index) =>
    names[index].trim() ? { role: roles[index], id: names[index].trim() } : { role: roles[index] },
  ) as [AnnotationRater, AnnotationRater];
  const problem = sameRater(raters[0], raters[1])
    ? "Choose two different raters."
    : session.annotations.some((revision) =>
          raters.some((rater) => sameRater(rater, revision.author)),
        )
      ? "A chosen rater has already annotated this session; validation is declared before rating."
      : null;

  return (
    <div className="flex flex-wrap items-end gap-2">
      {[0, 1].map((index) => (
        <fieldset key={index} className="m-0 flex flex-wrap items-end gap-2 border-0 p-0">
          <legend className="sr-only">Rater {index + 1}</legend>
          <label className="flex flex-col text-sm">
            Rater {index + 1} role
            <select
              className={controlClass}
              value={roles[index]}
              onChange={(change) => {
                const next = [...roles] as [AnnotatorRole, AnnotatorRole];
                next[index] = change.target.value as AnnotatorRole;
                setRoles(next);
              }}
            >
              {Object.entries(ROLES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            Rater {index + 1} name
            <input
              className={controlClass}
              value={names[index]}
              onChange={(change) => {
                const next = [...names] as [string, string];
                next[index] = change.target.value;
                setNames(next);
              }}
            />
          </label>
        </fieldset>
      ))}
      <button
        type="button"
        className={buttonClass}
        disabled={disabled || problem !== null}
        onClick={() => void onDeclare(raters)}
      >
        Declare for validation
      </button>
      {problem && <p className="m-0 w-full text-sm text-[#a33b3b]">{problem}</p>}
    </div>
  );
}

function describe(item: SpanDisagreement) {
  if (item.kind === "labelMismatch") {
    return `Label differs: rater 1 ${span(item.first)}, rater 2 ${span(item.second)}`;
  }
  return item.kind === "onlyFirst"
    ? `Only rater 1: ${span(item.first)}`
    : `Only rater 2: ${span(item.second)}`;
}

function span(event: AnnotatedEvent) {
  return `${LABELS[event.kind]} ${event.startSeconds.toFixed(2)}–${event.endSeconds.toFixed(2)} s${event.certainty === "possible" ? " (possible)" : ""}`;
}

function raterName(rater: AnnotationRater) {
  return rater.id ? `${rater.id} (${ROLES[rater.role]})` : ROLES[rater.role];
}

function percent(value: number | null) {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function number(value: number | null) {
  return value === null ? "n/a" : value.toFixed(2);
}
