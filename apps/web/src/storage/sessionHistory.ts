import { analyzerKey, canonicalSpokenLanguage, isAnalysisVerified } from "@stutter-tracker/shared";
import type { SavedSession } from "../types";

export type SessionHistoryPoint = {
  id: string;
  startedAt: string;
  durationSeconds: number;
  stutterCount: number;
  stuttersPerMinute: number;
  fluencyPercentage: number | null;
  wordsPerMinute: number | null;
  /** Analyzer behind the report ("unknown" for records that never stored it). */
  analyzerKey: string;
  /** The report is known to analyze exactly the saved transcript. */
  verified: boolean;
  /** Whether captured audio fed the analysis (acoustic events); null when not recorded. */
  usedAudio: boolean | null;
  /** Speaking context; sessions in different contexts are not directly comparable. */
  spokenLanguage: string;
  task: string;
  condition: string;
};

export type ProgressComparability = {
  comparable: boolean;
  /** Plain-language reasons the points are not directly comparable. */
  reasons: string[];
  /** Some reasons concern the analysis, which reanalyzing the sessions can fix. */
  reanalysisHelps: boolean;
  /** Some reasons concern the speaking context, which reanalysis cannot change. */
  contextDiffers: boolean;
  /** No point records its speaking task (tag it in "Compare two sessions"). */
  taskUnrecorded: boolean;
  /** No point records its assistance condition (tag it in "Compare two sessions"). */
  conditionUnrecorded: boolean;
};

/**
 * Points are comparable only when one known analyzer version produced every report from the same
 * kind of input (with or without audio) and every report is verified against its transcript.
 * Every point is an automated report; human annotations are not plotted here. Anything else is
 * flagged, not hidden.
 */
export function progressComparability(points: SessionHistoryPoint[]): ProgressComparability {
  const reasons: string[] = [];
  const known = new Set(
    points.map((point) => point.analyzerKey).filter((key) => key !== "unknown"),
  );
  if (known.size > 1) {
    reasons.push(`${known.size} different analyzer versions produced these results`);
  }
  const unknown = points.filter((point) => point.analyzerKey === "unknown").length;
  if (unknown > 0) {
    reasons.push(
      `the analyzer version was not recorded for ${unknown === points.length ? "these sessions" : `${unknown} of them`}`,
    );
  }
  const audioUse = new Set(points.map((point) => point.usedAudio).filter((used) => used !== null));
  if (audioUse.size > 1) {
    reasons.push("some were analyzed with audio and some without");
  }
  // Unknown audio use is not a shared modality: either report may include acoustic analysis.
  const audioUnknown = points.filter((point) => point.usedAudio === null).length;
  if (audioUnknown > 0) {
    reasons.push(
      `whether audio was analyzed was not recorded for ${audioUnknown === points.length ? "these sessions" : `${audioUnknown} of them`}`,
    );
  }
  let contextDiffers = false;
  // Same split as outcome comparisons: language, task and assistance condition. Unknown task or
  // condition on every point is reported separately (contextUnrecorded): flagging it as a
  // mismatch would show the warning on every chart, since most sessions are not tagged.
  for (const [field, label] of [
    ["spokenLanguage", "languages"],
    ["task", "speaking tasks"],
    ["condition", "assistance conditions"],
  ] as const) {
    const values = new Set(points.map((point) => point[field]));
    if (values.size > 1) {
      reasons.push(`they span ${values.size} different ${label}`);
      contextDiffers = true;
    }
  }
  // Unlike task and condition, new sessions do record their language; an unknown one comes from
  // older or imported records and is real missing provenance.
  const languageUnknown = points.filter((point) => point.spokenLanguage === "unknown").length;
  if (languageUnknown > 0 && !contextDiffers) {
    reasons.push(
      `the spoken language was not recorded for ${languageUnknown === points.length ? "these sessions" : `${languageUnknown} of them`}`,
    );
  }
  const unverified = points.filter((point) => !point.verified).length;
  if (unverified > 0) {
    reasons.push(
      `${unverified} session${unverified === 1 ? "'s analysis is" : "s' analyses are"} not verified for the saved transcript`,
    );
  }
  return {
    comparable: reasons.length === 0,
    reasons,
    reanalysisHelps:
      known.size > 1 || unknown > 0 || audioUse.size > 1 || audioUnknown > 0 || unverified > 0,
    contextDiffers,
    taskUnrecorded: points.length > 0 && points.every((point) => point.task === "unknown"),
    conditionUnrecorded:
      points.length > 0 && points.every((point) => point.condition === "unknown"),
  };
}

export function buildSessionHistory(sessions: SavedSession[], limit = 12): SessionHistoryPoint[] {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 12;
  if (normalizedLimit === 0) {
    return [];
  }

  return sessions
    .map((session, index) => ({
      session,
      index,
      timestamp: Date.parse(session.startedAt),
    }))
    .filter(({ timestamp }) => Number.isFinite(timestamp))
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
    .slice(-normalizedLimit)
    .map(({ session }) => toHistoryPoint(session));
}

function toHistoryPoint(session: SavedSession): SessionHistoryPoint {
  const durationSeconds = nonNegativeNumber(session.report.totalDurationSeconds);
  const stutterCount = nonNegativeNumber(session.report.stutterCount);
  const reportedRate = finiteNumberOrNull(session.report.stuttersPerMinute);
  const derivedRate = durationSeconds > 0 ? stutterCount / (durationSeconds / 60) : 0;
  const fluencyPercentage = finiteNumberOrNull(session.report.speechStats?.fluencyPercentage);
  const wordsPerMinute = finiteNumberOrNull(session.report.speechStats?.wordsPerMinute);

  return {
    id: session.id,
    startedAt: session.startedAt,
    durationSeconds,
    stutterCount,
    stuttersPerMinute: Math.max(0, reportedRate ?? derivedRate),
    fluencyPercentage:
      fluencyPercentage == null ? null : Math.min(100, Math.max(0, fluencyPercentage)),
    wordsPerMinute: wordsPerMinute == null ? null : Math.max(0, wordsPerMinute),
    analyzerKey: analyzerKey(session),
    verified: isAnalysisVerified(session),
    usedAudio: session.analysis.usedAudio,
    spokenLanguage: canonicalSpokenLanguage(session.context.spokenLanguage),
    task: session.context.task
      ? `${session.context.task.kind}:${session.context.task.trained ? "trained" : "untrained"}`
      : "unknown",
    condition: session.context.condition
      ? session.context.condition.kind === "assisted"
        ? `assisted:${session.context.condition.aidId}:${canonicalSettings(session.context.condition.settings)}`
        : "unassisted"
      : "unknown",
  };
}

function nonNegativeNumber(value: number | null | undefined) {
  const finite = finiteNumberOrNull(value);
  return finite == null ? 0 : Math.max(0, finite);
}

function finiteNumberOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Settings key independent of property order, like the outcome comparisons. */
function canonicalSettings(settings: Record<string, number | string | boolean> | undefined) {
  return JSON.stringify(
    Object.entries(settings ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}
