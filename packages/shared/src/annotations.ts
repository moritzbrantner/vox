// Pure editing model for one rater's event spans. The editor never touches the observation or
// another rater's revisions; saving appends a revision through `annotateSession`.
import type {
  AnnotatedEvent,
  AnnotationRater,
  AnnotationRevision,
  SessionRecord,
} from "./sessions";
import { currentAnnotations, sameRater } from "./sessions";

export type AnnotationEditorState = {
  events: AnnotatedEvent[];
  past: AnnotatedEvent[][];
  future: AnnotatedEvent[][];
};

export type AnnotationEdit =
  | { type: "add"; event: AnnotatedEvent }
  | { type: "update"; index: number; patch: Partial<AnnotatedEvent> }
  | { type: "remove"; index: number }
  | { type: "nudge"; index: number; edge: "start" | "end"; deltaSeconds: number };

/** Boundaries are kept to the millisecond so nudging never accumulates float drift. */
export function roundAnnotationSeconds(seconds: number) {
  return Math.round(seconds * 1000) / 1000;
}

export function createAnnotationEditor(events: AnnotatedEvent[] = []): AnnotationEditorState {
  return { events: sortEvents(events), past: [], future: [] };
}

/** Why an event span is not valid, or null. Overlapping spans are valid. */
export function annotatedEventError(event: AnnotatedEvent): string | null {
  if (!Number.isFinite(event.startSeconds) || !Number.isFinite(event.endSeconds)) {
    return "Start and end must be numbers of seconds.";
  }
  if (event.startSeconds < 0) return "Start cannot be before the session start.";
  if (event.endSeconds < event.startSeconds) return "End must not be before start.";
  return null;
}

/** Applies one edit as one undo step. An invalid edit leaves the state unchanged. */
export function editAnnotation(
  state: AnnotationEditorState,
  edit: AnnotationEdit,
): { state: AnnotationEditorState; error: string | null } {
  const events = applyEdit(state.events, edit);
  if (typeof events === "string") return { state, error: events };
  if (sameEvents(events, state.events)) return { state, error: null };
  return { state: { events, past: [...state.past, state.events], future: [] }, error: null };
}

export function undoAnnotation(state: AnnotationEditorState): AnnotationEditorState {
  const previous = state.past.at(-1);
  if (!previous) return state;
  return {
    events: previous,
    past: state.past.slice(0, -1),
    future: [state.events, ...state.future],
  };
}

export function redoAnnotation(state: AnnotationEditorState): AnnotationEditorState {
  const [next, ...rest] = state.future;
  if (!next) return state;
  return { events: next, past: [...state.past, state.events], future: rest };
}

/** The author's current revision (not superseded), which their next save replaces. */
export function currentRevisionBy(
  record: SessionRecord,
  author: AnnotationRater,
): AnnotationRevision | null {
  return (
    currentAnnotations(record)
      .filter((revision) => sameRater(revision.author, author))
      .at(-1) ?? null
  );
}

export function sameEvents(a: AnnotatedEvent[], b: AnnotatedEvent[]) {
  return (
    JSON.stringify(sortEvents(a).map(canonical)) === JSON.stringify(sortEvents(b).map(canonical))
  );
}

function applyEdit(events: AnnotatedEvent[], edit: AnnotationEdit): AnnotatedEvent[] | string {
  if (edit.type === "add") {
    const event = normalize(edit.event);
    return annotatedEventError(event) ?? sortEvents([...events, event]);
  }
  const current = events[edit.index];
  if (!current) return "That event no longer exists.";
  if (edit.type === "remove") return events.filter((_, index) => index !== edit.index);
  const next =
    edit.type === "update"
      ? normalize({ ...current, ...edit.patch })
      : normalize(
          edit.edge === "start"
            ? { ...current, startSeconds: current.startSeconds + edit.deltaSeconds }
            : { ...current, endSeconds: current.endSeconds + edit.deltaSeconds },
        );
  return (
    annotatedEventError(next) ??
    sortEvents(events.map((event, index) => (index === edit.index ? next : event)))
  );
}

function normalize(event: AnnotatedEvent): AnnotatedEvent {
  const { note, ...rest } = event;
  const trimmed = note?.trim();
  return {
    ...rest,
    startSeconds: roundAnnotationSeconds(event.startSeconds),
    endSeconds: roundAnnotationSeconds(event.endSeconds),
    ...(trimmed ? { note: trimmed } : {}),
  };
}

function sortEvents(events: AnnotatedEvent[]) {
  return [...events].sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

function canonical(event: AnnotatedEvent) {
  return [event.kind, event.startSeconds, event.endSeconds, event.certainty, event.note ?? null];
}
