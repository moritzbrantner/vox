import { EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import type { SavedSession } from "../types";
import { buttonClass, cx, mutedTextClass, panelClass, primaryButtonClass } from "./styles";

/**
 * Neutral references for blind review. Ordered by a hash of the session id, so neither the
 * order nor the name follows the recording date, condition or analysis.
 */
export function blindReferences(sessions: SavedSession[]) {
  return [...sessions]
    .sort((a, b) => hash(a.id) - hash(b.id) || a.id.localeCompare(b.id))
    .map((session, index) => ({ id: session.id, label: `Recording ${index + 1}` }));
}

/**
 * Blind review shows only the annotation workbench of a session picked by a neutral reference:
 * no analysis, events, scores, dates, conditions or session names are rendered.
 */
export function BlindReview({
  sessions,
  selectedId,
  message,
  onSelect,
  onExit,
  children,
}: {
  sessions: SavedSession[];
  selectedId: string | null;
  message: string;
  onSelect: (id: string) => void;
  onExit: () => void;
  children: ReactNode;
}) {
  const references = blindReferences(sessions);
  return (
    <section aria-labelledby="blind-review-heading">
      <div className={cx(panelClass, "mb-4 p-4")}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 id="blind-review-heading" className="m-0 flex items-center gap-2 text-xl">
              <EyeOff size={20} aria-hidden="true" /> Blind review
            </h1>
            <p className={cx("m-0 text-sm", mutedTextClass)}>
              Analysis results, dates and conditions are hidden. Annotations saved here are marked
              as made without seeing the analysis.
            </p>
          </div>
          <button type="button" className={buttonClass} onClick={onExit}>
            End blind review
          </button>
        </div>
        <div role="group" aria-label="Recordings" className="flex flex-wrap gap-2">
          {references.map((reference) => (
            <button
              key={reference.id}
              type="button"
              aria-pressed={reference.id === selectedId}
              className={reference.id === selectedId ? primaryButtonClass : buttonClass}
              onClick={() => onSelect(reference.id)}
            >
              {reference.label}
            </button>
          ))}
        </div>
        {message && (
          <p role="status" className={cx("mb-0 mt-3 text-sm", mutedTextClass)}>
            {message}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return value;
}
