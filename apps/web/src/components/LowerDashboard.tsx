import {
  BarChart3,
  BrainCircuit,
  ListChecks,
  PlayCircle,
  RefreshCw,
  Trash2,
  TrendingUp,
  Waves,
} from "lucide-react";
import { describeParticipants, isReplayable, sessionParticipants } from "@stutter-tracker/shared";
import { isScoreWithheld } from "../audio/captureQuality";
import { TIMING_NOT_ALIGNED } from "./TranscriptText";
import { type ReactNode, useState } from "react";
import {
  buildSessionHistory,
  progressComparability,
  type SessionHistoryPoint,
  cohortKey,
  type HistoryCohort,
  historyCohorts,
  languageBreakdown,
} from "../storage/sessionHistory";
import type {
  AnalysisReport,
  BlockerStats,
  ChunkAnalysis,
  PossibleEvent,
  SavedSession,
  SpeakerIntentPrediction,
  TranscriptSegment,
} from "../types";
import {
  eventDetail,
  eventSourceLabel,
  formatPercent,
  formatTime,
  kindLabel,
} from "../utils/formatting";
import {
  buttonClass,
  controlClass,
  cx,
  mutedTextClass,
  panelClass,
  panelHeaderClass,
} from "./styles";

type LowerDashboardProps = {
  report: AnalysisReport;
  segments: TranscriptSegment[];
  intentPredictions: SpeakerIntentPrediction[];
  analyzedChunks: ChunkAnalysis[];
  blockerStats: BlockerStats;
  sessions: SavedSession[];
  onSessionLoad: (session: SavedSession) => void;
  /** Loading waits until capture and transcription have finished. */
  sessionLoadDisabled?: boolean;
  onSessionDelete: (session: SavedSession) => void;
  /** Appends a fresh analysis run of the saved transcript; earlier runs stay in the history. */
  onSessionReanalyze?: (session: SavedSession) => void;
  /** Sessions with a reanalysis in flight; their action is disabled until it lands. */
  reanalyzingSessionIds?: string[];
  deletingSessionId: string | null;
};

/** What deleting a saved session removes, and what it cannot reach (vox#87). */
export const SESSION_DELETE_CONFIRMATION = [
  "Delete this saved session? This cannot be undone.",
  "This removes its transcript, annotations, analyses, any audio kept for review and any unsaved recording copy from this app. In the desktop app it also removes the session from the speech corpus; the browser version cannot reach desktop data.",
  "Session backups and copies you already exported or shared are not changed. Speaker voiceprints are kept; remove them separately.",
].join("\n\n");
export function LowerDashboard({
  report,
  segments,
  intentPredictions,
  analyzedChunks,
  blockerStats,
  sessions,
  onSessionLoad,
  sessionLoadDisabled = false,
  onSessionDelete,
  onSessionReanalyze,
  reanalyzingSessionIds = [],
  deletingSessionId,
}: LowerDashboardProps) {
  return (
    <section className="flex items-start gap-4 max-lg:flex-col">
      <EventsPanel report={report} />
      <IntentPanel predictions={intentPredictions} />
      <SpeechLogPanel segments={segments} />
      <ChunkAnalysisPanel chunks={analyzedChunks} report={report} blockerStats={blockerStats} />
      <ProgressPanel sessions={sessions} />
      <SessionsPanel
        sessions={sessions}
        onSessionLoad={onSessionLoad}
        sessionLoadDisabled={sessionLoadDisabled}
        onSessionDelete={onSessionDelete}
        onSessionReanalyze={onSessionReanalyze}
        reanalyzingSessionIds={reanalyzingSessionIds}
        deletingSessionId={deletingSessionId}
      />
    </section>
  );
}

function IntentPanel({ predictions }: { predictions: SpeakerIntentPrediction[] }) {
  return (
    <div className={`${panelClass} min-w-0 flex-[1.1_1_22rem] max-lg:w-full`}>
      <PanelHeader title="Intent" count={predictions.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {predictions.length === 0 ? (
          <EmptyState
            icon={<BrainCircuit size={24} />}
            label="Intent predictions will appear when transcript context is available."
          />
        ) : (
          predictions.map((prediction) => (
            <article
              className="grid gap-2 border-b border-[#edf1ee] px-4 py-3 last:border-b-0"
              key={prediction.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="break-words">{intentReasonLabel(prediction.reason)}</strong>
                {prediction.startSeconds != null && (
                  <time className={`text-sm ${mutedTextClass}`}>
                    At {formatTime(prediction.startSeconds)}
                  </time>
                )}
              </div>
              <p className={`m-0 break-words text-sm ${mutedTextClass}`}>
                {prediction.speakerLabel ? `${prediction.speakerLabel}: ` : ""}
                {prediction.contextText}
                {prediction.triggerText ? ` · ${prediction.triggerText}` : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                {prediction.suggestions.map((suggestion) => (
                  <span
                    className="min-w-0 rounded-full border border-[#cfe0d8] bg-[#f1f7f4] px-2 py-1 text-sm text-[#25493d]"
                    key={`${prediction.id}-${suggestion.phrase || suggestion.token}`}
                    title={`${Math.round(suggestion.probability * 100)}%`}
                  >
                    {suggestion.phrase || suggestion.token}
                  </span>
                ))}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function EventsPanel({ report }: { report: AnalysisReport }) {
  // A capture that failed the quality gate has no event result to list.
  const withheld = isScoreWithheld(report);
  return (
    <div className={`${panelClass} min-w-0 flex-[1.2_1_22rem] max-lg:w-full`}>
      <PanelHeader title="Events" count={withheld ? "Unknown" : report.events.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {withheld ? (
          <EmptyState
            icon={<Waves size={24} />}
            label="Events are not shown because the capture quality is unknown."
          />
        ) : report.events.length === 0 ? (
          <EmptyState icon={<Waves size={24} />} label="No events in the current session." />
        ) : (
          report.events.map((event, index) => (
            <div
              className="flex items-center gap-3 border-b border-[#edf1ee] px-4 py-3 last:border-b-0"
              key={`${event.kind}-${event.startSeconds}-${index}`}
            >
              <div
                className={cx(
                  "w-16 shrink-0 rounded-full px-2 py-1 text-center text-xs font-bold text-white",
                  eventKindClass(event.kind),
                )}
              >
                {kindLabel(event.kind)}
              </div>
              <div className="min-w-0">
                <strong className="flex flex-wrap items-center gap-2 break-words">
                  {event.text}
                  {event.source && (
                    <small className={`text-xs font-bold ${mutedTextClass}`}>
                      {eventSourceLabel(event.source)}
                    </small>
                  )}
                </strong>
                <span className={`block break-words ${mutedTextClass}`}>{eventDetail(event)}</span>
              </div>
              <time className={`ml-auto ${mutedTextClass}`}>{formatTime(event.startSeconds)}</time>
            </div>
          ))
        )}
        {!withheld && <PossibleEventsList possible={report.insufficientEvidence ?? []} />}
      </div>
    </div>
  );
}

const possibleKindLabel: Record<PossibleEvent["candidate"]["kind"], string> = {
  wordRepetition: "word repetition",
  soundRepetition: "sound repetition",
  prolongation: "prolongation",
  block: "block",
  filler: "filler",
};

const insufficientEvidenceReasonLabel: Record<PossibleEvent["reason"], string> = {
  audioOnly: "audio only",
};

/**
 * Detections withheld for insufficient evidence. They are not events: the panel count, rates and
 * trends leave them out; each links to the evidence of the candidate it was withheld from.
 */
function PossibleEventsList({ possible }: { possible: PossibleEvent[] }) {
  if (possible.length === 0) {
    return null;
  }
  return (
    <section aria-label="Possible – not enough evidence" className="border-t border-[#edf1ee]">
      <h3 className={`m-0 px-4 pt-3 text-sm font-bold ${mutedTextClass}`}>
        Possible – not enough evidence ({possible.length})
      </h3>
      {possible.map(({ reason, candidate }, index) => (
        <details
          className="border-b border-[#edf1ee] px-4 py-3 last:border-b-0"
          key={`${candidate.kind}-${candidate.startSeconds}-${index}`}
        >
          <summary className="flex cursor-pointer items-center gap-3">
            <span className="min-w-0 break-words">
              Possible {possibleKindLabel[candidate.kind]} – not enough evidence (
              {insufficientEvidenceReasonLabel[reason]})
            </span>
            <time className={`ml-auto ${mutedTextClass}`}>
              {formatTime(candidate.startSeconds)}
            </time>
          </summary>
          <p className={`m-0 mt-2 break-words text-sm ${mutedTextClass}`}>
            {candidate.evidence?.explanation ?? eventDetail(candidate)}
          </p>
          {candidate.evidence && candidate.evidence.supporting.length > 0 && (
            <p className={`m-0 mt-1 break-words text-xs ${mutedTextClass}`}>
              Evidence: {candidate.evidence.supporting.join(", ")}
            </p>
          )}
        </details>
      ))}
    </section>
  );
}

function SpeechLogPanel({ segments }: { segments: TranscriptSegment[] }) {
  return (
    <div className={`${panelClass} min-w-0 flex-[1_1_22rem] max-lg:w-full`}>
      <PanelHeader title="Speech Log" count={segments.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {segments.length === 0 ? (
          <EmptyState
            icon={<ListChecks size={24} />}
            label="Spoken segments will be logged here."
          />
        ) : (
          segments.map((segment, index) => (
            <div
              className="grid grid-cols-[3.2rem_minmax(0,1fr)_minmax(4.2rem,auto)] gap-3 border-b border-[#edf1ee] px-4 py-3 last:border-b-0"
              key={`${segment.startSeconds}-${index}`}
            >
              {segment.alignment === "unaligned" ? (
                <span className={`break-words text-xs ${mutedTextClass}`}>
                  {TIMING_NOT_ALIGNED}
                </span>
              ) : (
                <time className={`break-words ${mutedTextClass}`}>
                  {formatTime(segment.startSeconds)}
                </time>
              )}
              <p className="m-0 break-words">{segment.text}</p>
              <span className={`break-words ${mutedTextClass}`}>
                {segment.speakerLabel
                  ? `${segment.speakerLabel} ${formatPercent(segment.speakerScore ?? null)}`
                  : formatPercent(segment.confidence ?? null)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ChunkAnalysisPanel({
  chunks,
  report,
  blockerStats,
}: {
  chunks: ChunkAnalysis[];
  report: AnalysisReport;
  blockerStats: BlockerStats;
}) {
  const withheld = isScoreWithheld(report);
  return (
    <div className={`${panelClass} min-w-0 flex-[1.1_1_24rem] max-lg:w-full`}>
      <PanelHeader title="Chunk Analysis" count={chunks.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {chunks.length === 0 ? (
          <EmptyState
            icon={<BarChart3 size={24} />}
            label="Chunk statistics will appear after speech is transcribed."
          />
        ) : (
          chunks.map((chunk) => (
            <article
              className="grid gap-3 border-b border-[#edf1ee] px-4 py-3 last:border-b-0"
              key={`${chunk.index}-${chunk.startSeconds}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <strong>Chunk {chunk.index + 1}</strong>
                <time className={`text-sm ${mutedTextClass}`}>
                  {formatTime(chunk.startSeconds)}-{formatTime(chunk.endSeconds)}
                </time>
              </div>
              <div className="grid gap-2">
                <AnalysisBar
                  label="Words"
                  value={chunk.wordCount}
                  max={Math.max(1, report.wordCount)}
                />
                {withheld ? (
                  <span className={`text-sm ${mutedTextClass}`}>Events and blocks: unknown</span>
                ) : (
                  <>
                    <AnalysisBar
                      label="Events"
                      value={chunk.stutterCount}
                      max={Math.max(1, report.stutterCount)}
                    />
                    <AnalysisBar
                      label="Blocks"
                      value={chunk.blockCount}
                      max={Math.max(1, blockerStats.blockCount)}
                    />
                  </>
                )}
              </div>
              <div
                className={`flex flex-wrap items-center justify-between gap-3 text-sm ${mutedTextClass}`}
              >
                <span>{chunk.wordsPerMinute.toFixed(0)} wpm</span>
                <span>{chunk.silentPauseSeconds.toFixed(1)}s pause</span>
                <span>{formatPercent(chunk.averageConfidence ?? null)}</span>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function ProgressPanel({ sessions }: { sessions: SavedSession[] }) {
  // Sessions whose capture failed the quality gate have no score to trend.
  const allScored = sessions.filter((session) => !isScoreWithheld(session.report));
  const withheldCount = sessions.length - allScored.length;
  const cohorts = historyCohorts(allScored);
  const [cohort, setCohort] = useState("all");
  const selected = cohorts.some((candidate) => candidate.key === cohort) ? cohort : "all";
  const scored =
    selected === "all" ? allScored : allScored.filter((session) => cohortKey(session) === selected);
  const languages = selected === "all" ? languageBreakdown(scored) : [];
  const history = buildSessionHistory(scored);
  const comparability = progressComparability(history);

  return (
    <div className={`${panelClass} min-w-0 flex-[1.2_1_28rem] max-lg:w-full`}>
      <div className={`${panelHeaderClass} p-4`}>
        <div>
          <h2 className="m-0 text-xl font-semibold">Progress</h2>
          <p className={`m-0 mt-1 text-sm ${mutedTextClass}`}>
            Last {history.length || "saved"} sessions · oldest to newest
          </p>
          {cohorts.length > 1 && (
            <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              Sessions
              <select
                className={controlClass}
                value={selected}
                onChange={(change) => setCohort(change.target.value)}
              >
                <option value="all">All sessions (mixed contexts)</option>
                {cohorts.map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {cohortLabel(candidate)} ({candidate.count})
                  </option>
                ))}
              </select>
            </label>
          )}
          {languages.length > 1 && (
            <p className={`m-0 mt-1 text-sm ${mutedTextClass}`}>
              Languages: {languages.map(([language, count]) => `${language} ${count}`).join(", ")}.
              Shown together, these are not one trajectory; choose a group to compare like with
              like.
            </p>
          )}
          {withheldCount > 0 && (
            <p className={`m-0 mt-1 text-sm ${mutedTextClass}`}>
              {withheldCount} session{withheldCount === 1 ? "" : "s"} with unknown capture quality
              left out
            </p>
          )}
        </div>
      </div>
      <div className="border-t border-[#edf1ee]">
        {history.length < 2 ? (
          <EmptyState
            icon={<TrendingUp size={24} />}
            label="Save at least two sessions to compare changes over time."
          />
        ) : (
          <>
            {!comparability.comparable && (
              <p
                role="note"
                className="m-0 border-b border-[#f0e2c4] bg-[#fdf8ec] px-4 py-3 text-sm text-[#6b5520]"
              >
                Not directly comparable: {comparability.reasons.join("; ")}.
                {comparability.reanalysisHelps &&
                  " Reanalyzing the affected sessions brings their analysis onto equal terms (a reanalysis uses the saved transcript only, without audio)."}
                {comparability.contextDiffers &&
                  " Compare sessions recorded in the same language, task and condition."}
              </p>
            )}
            <TrendMetric
              label="Fluency"
              hint="Computed fluency percentage"
              points={history}
              value={(point) => point.fluencyPercentage}
              format={(value) => `${value.toFixed(0)}%`}
              ceiling={100}
            />
            <TrendMetric
              label="Events/min"
              hint="Detected events per minute"
              points={history}
              value={(point) => point.stuttersPerMinute}
              format={(value) => `${value.toFixed(1)}/min`}
            />
            <TrendMetric
              label="Words/min"
              hint="Speaking pace"
              points={history}
              value={(point) => point.wordsPerMinute}
              format={(value) => `${value.toFixed(0)} wpm`}
            />
            <p className={`m-0 px-4 py-3 text-xs ${mutedTextClass}`}>
              Tracking metrics are for personal review and are not diagnostic scores.
              {(comparability.taskUnrecorded || comparability.conditionUnrecorded) &&
                ` ${[
                  comparability.taskUnrecorded && "Speaking task",
                  comparability.conditionUnrecorded && "Assistance condition",
                ]
                  .filter(Boolean)
                  .join(" and ")} ${
                  comparability.taskUnrecorded && comparability.conditionUnrecorded ? "are" : "is"
                } not recorded yet, so sessions may differ in ways this view cannot show.`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const TASK_LABELS: Record<string, string> = {
  reading: "reading",
  monologue: "monologue",
  conversation: "conversation",
  phoneCall: "phone-like call",
  presentation: "presentation",
  other: "other task",
};

function cohortLabel(cohort: HistoryCohort) {
  const [kind, trained] = cohort.task.split(":");
  const task =
    cohort.task === "unknown"
      ? "task not recorded"
      : `${TASK_LABELS[kind] ?? kind}${trained === "trained" ? " (practised)" : ""}`;
  const condition =
    cohort.condition === "unknown"
      ? "condition not recorded"
      : cohort.condition === "unassisted"
        ? "unassisted"
        : `assisted (${cohort.condition.split(":")[1]})`;
  const language = cohort.spokenLanguage === "unknown" ? "language unknown" : cohort.spokenLanguage;
  return `${language} · ${task} · ${condition}`;
}

function TrendMetric({
  label,
  hint,
  points,
  value,
  format,
  ceiling,
}: {
  label: string;
  hint: string;
  points: SessionHistoryPoint[];
  value: (point: SessionHistoryPoint) => number | null;
  format: (value: number) => string;
  ceiling?: number;
}) {
  const values = points.map(value);
  const availableValues = values.filter((candidate): candidate is number => candidate != null);
  const chartCeiling = Math.max(1, ceiling ?? Math.max(1, ...availableValues));
  const latest = values[values.length - 1] ?? null;

  return (
    <div className="grid gap-2 border-b border-[#edf1ee] px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <strong>{label}</strong>
          <span className={`ml-2 text-xs ${mutedTextClass}`}>{hint}</span>
        </div>
        <span className={`text-sm ${mutedTextClass}`}>
          Latest: {latest == null ? "No data" : format(latest)}
        </span>
      </div>
      <div
        className="flex h-16 items-end gap-1"
        role="img"
        aria-label={`${label} across the last ${points.length} saved sessions, oldest to newest`}
      >
        {points.map((point, index) => {
          const metric = values[index];
          const height =
            metric == null ? 5 : Math.max(6, Math.min(100, (metric / chartCeiling) * 100));
          const date = new Date(point.startedAt).toLocaleDateString();
          const display = metric == null ? "No data" : format(metric);

          return (
            <span
              key={`${point.id}-${point.startedAt}`}
              className={cx(
                "min-w-1 flex-1 rounded-t",
                metric == null ? "bg-[#dce4df]" : "bg-[#1c6b5a]",
              )}
              style={{ height: `${height}%` }}
              title={`${date}: ${display}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function SessionsPanel({
  sessions,
  onSessionLoad,
  sessionLoadDisabled = false,
  onSessionDelete,
  onSessionReanalyze,
  reanalyzingSessionIds = [],
  deletingSessionId,
}: {
  sessions: SavedSession[];
  onSessionLoad: (session: SavedSession) => void;
  sessionLoadDisabled?: boolean;
  onSessionDelete: (session: SavedSession) => void;
  /** Appends a fresh analysis run of the saved transcript; earlier runs stay in the history. */
  onSessionReanalyze?: (session: SavedSession) => void;
  /** Sessions with a reanalysis in flight; their action is disabled until it lands. */
  reanalyzingSessionIds?: string[];
  deletingSessionId: string | null;
}) {
  const historyById = new Map(
    buildSessionHistory(sessions, Math.max(1, sessions.length)).map((point) => [point.id, point]),
  );

  return (
    <div className={`${panelClass} w-96 shrink-0 max-lg:w-full`}>
      <PanelHeader title="Sessions" count={sessions.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {sessions.length === 0 ? (
          <EmptyState
            icon={<PlayCircle size={24} />}
            label="Saved sessions will appear here after your first recording."
          />
        ) : (
          sessions.map((session) => {
            const historyPoint = historyById.get(session.id);

            return (
              <div
                key={session.id}
                className="flex items-stretch border-b border-[#edf1ee] last:border-b-0"
              >
                <button
                  className={`session-row ${buttonClass} min-w-0 flex-1 justify-start rounded-none border-0 px-4 py-3`}
                  onClick={() => onSessionLoad(session)}
                  disabled={sessionLoadDisabled}
                  title={
                    sessionLoadDisabled
                      ? "Available once recording and transcription have finished"
                      : undefined
                  }
                >
                  <PlayCircle className="shrink-0" size={18} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">
                      {new Date(session.startedAt).toLocaleString()}
                    </span>
                    {historyPoint && isScoreWithheld(session.report) && (
                      <span className={`mt-1 block text-xs ${mutedTextClass}`}>
                        {formatSessionDuration(historyPoint.durationSeconds)} · capture quality
                        unknown
                      </span>
                    )}
                    {historyPoint && !isScoreWithheld(session.report) && (
                      <span className={`mt-1 block text-xs ${mutedTextClass}`}>
                        {formatSessionDuration(historyPoint.durationSeconds)} ·{" "}
                        {historyPoint.fluencyPercentage == null
                          ? "fluency unavailable"
                          : `${historyPoint.fluencyPercentage.toFixed(0)}% fluency`}{" "}
                        · {historyPoint.stuttersPerMinute.toFixed(1)} events/min
                      </span>
                    )}
                    <span className={`mt-0.5 block text-xs ${mutedTextClass}`}>
                      {analysisProvenanceLabel(session)}
                    </span>
                    {sessionParticipants(session) && (
                      <span className={`mt-0.5 block text-xs ${mutedTextClass}`}>
                        {describeParticipants(sessionParticipants(session), (iso) =>
                          new Date(iso).toLocaleString(),
                        )}
                      </span>
                    )}
                  </span>
                  <strong className="shrink-0 text-sm">
                    {isScoreWithheld(session.report)
                      ? "Unknown"
                      : `${session.report.stutterCount} events`}
                  </strong>
                </button>
                {onSessionReanalyze && (
                  <button
                    type="button"
                    className="border-0 border-l border-[#edf1ee] bg-white px-3 text-[#355e47] hover:bg-[#f2f7f4] disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Reanalyze saved session from ${new Date(session.startedAt).toLocaleString()}`}
                    title="Reanalyze: add a new analysis run; earlier runs stay in the history"
                    disabled={
                      sessionLoadDisabled ||
                      deletingSessionId === session.id ||
                      reanalyzingSessionIds.includes(session.id) ||
                      !isReplayable(session)
                    }
                    onClick={() => onSessionReanalyze(session)}
                  >
                    <RefreshCw size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="border-0 border-l border-[#edf1ee] bg-white px-3 text-[#a33b3b] hover:bg-[#fff4f4] disabled:cursor-wait disabled:opacity-50"
                  aria-label={`Delete saved session from ${new Date(session.startedAt).toLocaleString()}`}
                  title="Delete saved session"
                  disabled={deletingSessionId === session.id}
                  onClick={() => {
                    if (window.confirm(SESSION_DELETE_CONFIRMATION)) {
                      onSessionDelete(session);
                    }
                  }}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function PanelHeader({ title, count }: { title: string; count: number | string }) {
  return (
    <div className={`${panelHeaderClass} p-4`}>
      <h2 className="m-0 text-xl font-semibold">{title}</h2>
      <span>{count}</span>
    </div>
  );
}

function AnalysisBar({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.min(100, Math.max(4, (value / max) * 100))}%`;
  return (
    <div className="grid grid-cols-[4.4rem_minmax(0,1fr)_2.4rem] items-center gap-2">
      <span className={`text-sm ${mutedTextClass}`}>{label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-[#edf2ef]">
        <i className="block h-full rounded-full bg-[#1c6b5a]" style={{ width }} />
      </div>
      <strong className={`text-right text-sm ${mutedTextClass}`}>{value}</strong>
    </div>
  );
}

function EmptyState({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className={`flex items-center gap-3 p-4 ${mutedTextClass}`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

function formatSessionDuration(seconds: number) {
  const roundedSeconds = Math.round(seconds);
  if (roundedSeconds < 60) {
    return `${roundedSeconds}s`;
  }

  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function eventKindClass(kind: AnalysisReport["events"][number]["kind"]) {
  return {
    wordRepetition: "bg-[#236f8e]",
    soundRepetition: "bg-[#236f8e]",
    prolongation: "bg-[#7f5d1f]",
    block: "bg-[#7d3c68]",
    filler: "bg-[#51605a]",
  }[kind];
}

function intentReasonLabel(reason: SpeakerIntentPrediction["reason"]) {
  return {
    currentContext: "Current context",
    block: "After block",
    filler: "After filler",
    repetition: "After repetition",
    prolongation: "After prolongation",
  }[reason];
}

const ANALYZER_LABELS = {
  onDevice: "On-device analysis",
  computeServer: "Compute-server analysis",
  desktopNative: "Desktop analysis",
} as const;

/** Missing provenance is shown as unknown rather than hidden, so mixed results are visible. */
export function analysisProvenanceLabel(session: SavedSession) {
  const { analyzer } = session.analysis;
  const runs = session.priorAnalyses.length + 1;
  const reruns = runs > 1 ? ` · ${runs} analysis runs` : "";
  if (!analyzer) {
    return `Analysis origin not recorded${reruns}`;
  }
  const version = analyzer.version ? ` v${analyzer.version}` : " (version not reported)";
  return `${ANALYZER_LABELS[analyzer.producer]}${version}${reruns}`;
}
