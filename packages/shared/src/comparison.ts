// Matched comparison of two saved sessions on reviewed (human-accepted) labels. It compares
// measures separately, states its denominators and limits, and refuses when the sessions are not
// a matched pair. It never turns fewer events with less speaking into an improvement.
import {
  type AnnotatedEvent,
  acceptedAnnotation,
  isDisfluencyLabel,
  type SessionRecord,
} from "./sessions";
import {
  canonicalSpokenLanguage,
  speechLanguageSupport,
  UNKNOWN_SPOKEN_LANGUAGE,
} from "./outcomes";

/** Less than this share of the other session's speaking time makes a lower rate "mixed". */
export const COMPARABLE_SPEECH_RATIO = 0.75;
/** Rates within this relative difference are reported as unchanged. */
export const UNCHANGED_RELATIVE_DIFFERENCE = 0.1;

export type SessionSide = {
  sessionId: string;
  condition: string;
  /** Seconds the transcript marks as speech: the rate denominator. */
  speakingSeconds: number;
  wordCount: number;
  /** Reviewed disfluency events, excluding typical fillers and span conditions. */
  events: number;
  /** Of which marked "possible". */
  possibleEvents: number;
  fillers: number;
  eventsPerSpeakingMinute: number | null;
  medianEventSeconds: number | null;
  longestEventSeconds: number | null;
  reviewedBy: string;
};

export type SessionComparison =
  | { comparable: false; reasons: string[] }
  | {
      comparable: true;
      language: string;
      task: string;
      first: SessionSide;
      second: SessionSide;
      /** Second relative to first, by reviewed events per speaking minute. */
      verdict: "lower" | "higher" | "unchanged" | "mixed" | "noEvents";
      limitations: string[];
    };

/** Compares `second` with `first` (e.g. later with earlier, or assisted with unassisted). */
export function compareSessions(first: SessionRecord, second: SessionRecord): SessionComparison {
  const reasons: string[] = [];
  if (first.id === second.id) reasons.push("choose two different sessions");
  const references = [acceptedAnnotation(first), acceptedAnnotation(second)];
  references.forEach((reference, index) => {
    if (!reference)
      reasons.push(
        `session ${index + 1} has no reviewed labels (save annotations as reference first)`,
      );
  });
  const languages = [first, second].map((session) =>
    canonicalSpokenLanguage(session.context.spokenLanguage),
  );
  if (languages.includes(UNKNOWN_SPOKEN_LANGUAGE)) {
    reasons.push("the spoken language is not recorded for both sessions");
  } else if (languages[0] !== languages[1]) {
    reasons.push(`they are in different languages (${languages[0]} and ${languages[1]})`);
  }
  const tasks = [first, second].map((session) => session.context.task);
  if (!tasks[0] || !tasks[1]) {
    reasons.push("the speaking task is not recorded for both sessions");
  } else if (tasks[0].kind !== tasks[1].kind || tasks[0].trained !== tasks[1].trained) {
    reasons.push("they are different speaking tasks (task kind or practised/unpractised differ)");
  }
  [first, second].forEach((session, index) => {
    if (session.report.captureQuality?.state === "unknown") {
      reasons.push(`session ${index + 1}'s recording failed the capture-quality check`);
    }
    if (session.reviewCopy)
      reasons.push(`session ${index + 1} is a review copy of someone else's recording`);
  });
  if (reasons.length) return { comparable: false, reasons };

  const sides = [first, second].map((session, index) =>
    side(session, references[index]!.events, references[index]!.author),
  ) as [SessionSide, SessionSide];
  const limitations: string[] = [];
  const support = speechLanguageSupport(languages[0]);
  if (support !== "first") {
    limitations.push(
      `Speech analysis is not prepared for "${languages[0]}" yet; only the reviewed labels are compared.`,
    );
  }
  if (sides[0].condition !== sides[1].condition) {
    limitations.push(
      `Different assistance conditions: ${sides[0].condition} and ${sides[1].condition}.`,
    );
  }
  if (
    references[0]!.author.role !== references[1]!.author.role ||
    references[0]!.author.id !== references[1]!.author.id
  ) {
    limitations.push("Different people reviewed the two sessions; their labelling may differ.");
  }
  limitations.push(
    "Two sessions are a small sample: a difference can come from the day, the topic or chance. This is not evidence of treatment effect.",
  );

  return {
    comparable: true,
    language: languages[0],
    task: describeTask(first),
    first: sides[0],
    second: sides[1],
    verdict: verdict(sides[0], sides[1]),
    limitations,
  };
}

function side(
  session: SessionRecord,
  events: AnnotatedEvent[],
  author: { role: string; id?: string },
): SessionSide {
  const disfluencies = events.filter(
    (event) => isDisfluencyLabel(event.kind) && event.kind !== "filler",
  );
  const durations = disfluencies
    .map((event) => event.endSeconds - event.startSeconds)
    .sort((a, b) => a - b);
  const speakingSeconds = Math.max(0, session.report.speechStats?.speakingDurationSeconds ?? 0);
  return {
    sessionId: session.id,
    condition: describeCondition(session),
    speakingSeconds: round(speakingSeconds),
    wordCount: session.report.wordCount,
    events: disfluencies.length,
    possibleEvents: disfluencies.filter((event) => event.certainty === "possible").length,
    fillers: events.filter((event) => event.kind === "filler").length,
    eventsPerSpeakingMinute:
      speakingSeconds > 0 ? round((disfluencies.length / speakingSeconds) * 60) : null,
    medianEventSeconds: durations.length ? round(median(durations)) : null,
    longestEventSeconds: durations.length ? round(durations[durations.length - 1]) : null,
    reviewedBy: author.id ? `${author.id} (${author.role})` : author.role,
  };
}

function verdict(
  first: SessionSide,
  second: SessionSide,
): "lower" | "higher" | "unchanged" | "mixed" | "noEvents" {
  if (first.eventsPerSpeakingMinute === null || second.eventsPerSpeakingMinute === null)
    return "mixed";
  if (first.events === 0 && second.events === 0) return "noEvents";
  const a = first.eventsPerSpeakingMinute;
  const b = second.eventsPerSpeakingMinute;
  const relative = Math.abs(b - a) / Math.max(a, b);
  if (relative <= UNCHANGED_RELATIVE_DIFFERENCE) return "unchanged";
  if (b < a) {
    // Fewer events while speaking much less is not an improvement on its own.
    return second.speakingSeconds < first.speakingSeconds * COMPARABLE_SPEECH_RATIO
      ? "mixed"
      : "lower";
  }
  return "higher";
}

function describeTask(session: SessionRecord) {
  const task = session.context.task!;
  return `${task.kind}${task.trained ? " (practised)" : " (not practised)"}`;
}

function describeCondition(session: SessionRecord) {
  const condition = session.context.condition;
  if (!condition) return "condition not recorded";
  return condition.kind === "unassisted" ? "unassisted" : `assisted (${condition.aidId})`;
}

function median(sorted: number[]) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
