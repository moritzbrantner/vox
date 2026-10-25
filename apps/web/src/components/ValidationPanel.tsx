import {
  type AdjudicationDecision,
  type AdjudicationOutcome,
  allowedOutcomes,
  type AnnotatedEvent,
  type AnnotationLabel,
  type AnnotationRater,
  type AnnotatorRole,
  BOUNDARY_TOLERANCE_SECONDS,
  type RaterComparison,
  sameRater,
  type SessionValidation,
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
const OUTCOMES: Record<AdjudicationOutcome, string> = {
  first: "Rater 1's span",
  second: "Rater 2's span",
  adjusted: "Adjusted span",
  noEvent: "No event",
  uncertain: "Uncertain (kept as possible)",
};
const DIFFERENCES = { label: "label", certainty: "certainty", boundaries: "boundaries" } as const;

export type AdjudicationRequest = {
  author: AnnotationRater;
  qualification: string;
  decisions: AdjudicationDecision[];
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
  onAdjudicate: (sessionId: string, request: AdjudicationRequest) => Promise<boolean>;
}) {
  const report = useMemo(() => validationReport(sessions), [sessions]);
  const validation = session ? sessionValidation(session) : null;
  const [adjudicating, setAdjudicating] = useState<string | null>(null);

  return (
    <section className={cx(panelClass, "mb-4 p-4")} aria-labelledby="validation-heading">
      <h2 id="validation-heading" className="m-0 mb-1 text-lg">
        Two-rater validation
      </h2>
      <p className={cx("m-0 mb-3 text-sm", mutedTextClass)}>
        {report.declared === 0
          ? "No sessions are declared for validation."
          : `${report.declared} declared · ${report.bothRated} rated by both · ${report.adjudicated} adjudicated · event agreement ${percent(report.positiveAgreement)} · time agreement (kappa) ${number(report.meanFrameKappa)} · ${report.disagreementCount} disagreements.`}{" "}
        Spans agree when label and certainty match and onset and offset each differ by at most{" "}
        {BOUNDARY_TOLERANCE_SECONDS * 1000} ms (provisional rule, not empirically validated); kappa
        compares 10 ms frames with any disfluency.
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
              <p className="m-0 mb-2 text-sm">
                {validation.comparison.matches.length} spans accepted automatically ·{" "}
                {validation.comparison.disagreements.length} referred to adjudication
              </p>
              {validation.comparison.disagreements.length === 0 ? (
                <p className="m-0 mb-2 text-sm">No disagreements.</p>
              ) : (
                <ul className="m-0 mb-2 pl-5 text-sm" aria-label="Disagreements">
                  {validation.comparison.disagreements.map((item) => (
                    <li key={item.key}>{describe(item)}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {adjudicating !== session.id && (
                  <button
                    type="button"
                    className={primaryButtonClass}
                    disabled={disabled}
                    onClick={() => setAdjudicating(session.id)}
                  >
                    {validation.adjudication ? "Revise adjudication" : "Adjudicate"}
                  </button>
                )}
                {validation.adjudication && (
                  <span className={cx("text-sm", mutedTextClass)}>
                    Adjudicated by {raterName(validation.adjudication.author)}
                    {validation.adjudication.adjudication
                      ? ` (${validation.adjudication.adjudication.qualification})`
                      : ""}
                    {validation.adjudicationCurrent
                      ? "; it is the session's human reference."
                      : "; a rater saved a new reference since, so it needs revising."}
                  </span>
                )}
              </div>
              {adjudicating === session.id && (
                <AdjudicationForm
                  key={validation.ratings.map((rating) => rating?.id).join()}
                  validation={validation}
                  comparison={validation.comparison}
                  raters={session.validation!.raters}
                  disabled={disabled}
                  onCancel={() => setAdjudicating(null)}
                  onSave={async (request) => {
                    const saved = await onAdjudicate(session.id, request);
                    if (saved) setAdjudicating(null);
                  }}
                />
              )}
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

type Draft = {
  outcome: AdjudicationOutcome | null;
  kind: AnnotationLabel;
  start: string;
  end: string;
  certainty: AnnotatedEvent["certainty"];
};

/**
 * Selective adjudication: agreements are accepted automatically; the adjudicator, a named
 * Clinician who is neither rater, decides each referred item and states their qualification.
 */
function AdjudicationForm({
  validation,
  comparison,
  raters,
  disabled,
  onCancel,
  onSave,
}: {
  validation: SessionValidation;
  comparison: RaterComparison;
  raters: [AnnotationRater, AnnotationRater];
  disabled: boolean;
  onCancel: () => void;
  onSave: (request: AdjudicationRequest) => Promise<void>;
}) {
  // Revising continues the previous decisions when they were made for these same ratings.
  const previous = validation.adjudicationCurrent ? validation.adjudication : null;
  const [name, setName] = useState(previous?.author.id ?? "");
  const [qualification, setQualification] = useState(previous?.adjudication?.qualification ?? "");
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      comparison.disagreements.map((item) => {
        const decided = previous?.adjudication?.decisions.find(
          (decision) => decision.item === item.key,
        );
        const base = decided?.event ?? (item.kind === "onlySecond" ? item.second : item.first);
        return [
          item.key,
          {
            outcome: decided?.outcome ?? null,
            kind: base.kind,
            start: String(base.startSeconds),
            end: String(base.endSeconds),
            certainty: base.certainty,
          },
        ];
      }),
    ),
  );
  const [saving, setSaving] = useState(false);
  const author: AnnotationRater = { role: "clinician", id: name.trim() };
  const update = (key: string, change: Partial<Draft>) =>
    setDrafts({ ...drafts, [key]: { ...drafts[key], ...change } });

  const decisions = comparison.disagreements.flatMap<AdjudicationDecision>((item) => {
    const draft = drafts[item.key];
    if (!draft.outcome) return [];
    if (draft.outcome !== "adjusted") return [{ item: item.key, outcome: draft.outcome }];
    return [
      {
        item: item.key,
        outcome: "adjusted",
        event: {
          kind: draft.kind,
          startSeconds: toSeconds(draft.start),
          endSeconds: toSeconds(draft.end),
          certainty: draft.certainty,
        },
      },
    ];
  });
  const badSpan = decisions.some(
    (decision) =>
      decision.event &&
      !(
        validSeconds(decision.event.startSeconds) &&
        validSeconds(decision.event.endSeconds) &&
        decision.event.endSeconds >= decision.event.startSeconds
      ),
  );
  const problem = !name.trim()
    ? "Enter the adjudicator's name."
    : raters.some((rater) => sameRater(rater, author))
      ? "The adjudicator must be neither rater."
      : !qualification.trim()
        ? "Enter the adjudicator's qualification."
        : decisions.length < comparison.disagreements.length
          ? "Decide every referred item."
          : badSpan
            ? "An adjusted span needs a start and an end (end not before start)."
            : null;

  return (
    <section
      className="mt-3 border-0 border-t border-solid border-[#d8ded9] pt-3"
      aria-label="Adjudicate validation"
    >
      <p className="m-0 mb-2 text-sm">
        Spans both raters marked alike are accepted automatically, at the mean of their boundaries.
        Decide each referred item; the raters' own revisions stay unchanged.
      </p>
      {comparison.matches.length > 0 && (
        <ul className="m-0 mb-2 pl-5 text-sm" aria-label="Accepted automatically">
          {comparison.matches.map((match, index) => (
            <li key={index}>{span(match.accepted)}</li>
          ))}
        </ul>
      )}
      {comparison.disagreements.map((item, index) => {
        const current = drafts[item.key];
        return (
          <fieldset key={item.key} className="m-0 mb-2 border-0 p-0">
            <legend className="text-sm font-semibold">
              Item {index + 1}: {describe(item)}
            </legend>
            <div className="flex flex-wrap gap-3 text-sm">
              {allowedOutcomes(item).map((outcome) => (
                <label key={outcome} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name={`decision-${item.key}`}
                    checked={current.outcome === outcome}
                    onChange={() => update(item.key, { outcome })}
                  />
                  {OUTCOMES[outcome]}
                </label>
              ))}
            </div>
            {current.outcome === "adjusted" && (
              <div className="mt-1 flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-sm">
                  Item {index + 1} label
                  <select
                    className={controlClass}
                    value={current.kind}
                    onChange={(change) =>
                      update(item.key, { kind: change.target.value as AnnotationLabel })
                    }
                  >
                    {Object.entries(LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col text-sm">
                  Item {index + 1} start
                  <input
                    className={controlClass}
                    inputMode="decimal"
                    value={current.start}
                    onChange={(change) => update(item.key, { start: change.target.value })}
                  />
                </label>
                <label className="flex flex-col text-sm">
                  Item {index + 1} end
                  <input
                    className={controlClass}
                    inputMode="decimal"
                    value={current.end}
                    onChange={(change) => update(item.key, { end: change.target.value })}
                  />
                </label>
                <label className="flex flex-col text-sm">
                  Item {index + 1} certainty
                  <select
                    className={controlClass}
                    value={current.certainty}
                    onChange={(change) =>
                      update(item.key, {
                        certainty: change.target.value as AnnotatedEvent["certainty"],
                      })
                    }
                  >
                    <option value="certain">Certain</option>
                    <option value="possible">Possible</option>
                  </select>
                </label>
              </div>
            )}
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-sm">
          Adjudicator name
          <input
            className={controlClass}
            value={name}
            onChange={(change) => setName(change.target.value)}
          />
        </label>
        <span className="pb-2 text-sm">Role: Clinician</span>
        <label className="flex flex-col text-sm">
          Qualification
          <input
            className={controlClass}
            placeholder="e.g. SLT, stuttering specialist"
            value={qualification}
            onChange={(change) => setQualification(change.target.value)}
          />
        </label>
        <button
          type="button"
          className={primaryButtonClass}
          disabled={disabled || saving || problem !== null}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave({ author, qualification: qualification.trim(), decisions });
            } finally {
              setSaving(false);
            }
          }}
        >
          Save adjudication
        </button>
        <button type="button" className={buttonClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {problem && <p className="m-0 mt-1 text-sm text-[#a33b3b]">{problem}</p>}
    </section>
  );
}

function toSeconds(value: string) {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function validSeconds(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function describe(item: SpanDisagreement) {
  if (item.kind === "pair") {
    const differs = item.differences.map((difference) => DIFFERENCES[difference]).join(", ");
    return `Differs in ${differs}: rater 1 ${span(item.first)}, rater 2 ${span(item.second)}`;
  }
  return item.kind === "onlyFirst"
    ? `Only rater 1: ${span(item.first)}`
    : `Only rater 2: ${span(item.second)}`;
}

function span(event: AnnotatedEvent) {
  const label = event.candidateLabels
    ? event.candidateLabels.map((candidate) => LABELS[candidate]).join(" or ")
    : LABELS[event.kind];
  return `${label} ${event.startSeconds.toFixed(2)}–${event.endSeconds.toFixed(2)} s${event.certainty === "possible" ? " (possible)" : ""}`;
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
