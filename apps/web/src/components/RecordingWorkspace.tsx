import { type ReactNode, useState } from "react";
import {
  Download,
  HardDriveDownload,
  LoaderCircle,
  Mic,
  Save,
  ShieldCheck,
  UserCheck,
  Waves,
} from "lucide-react";
import type {
  SpeakerMatch,
  TranscriptionChunkRecord,
  TranscriptionChunkStats,
  TranscriptionChunkSummary,
  TranscriptionModelStatus,
  TranscriptionProgressEvent,
  TranscriptSegment,
} from "../types";
import { formatPercent, modelStatusLabel } from "../utils/formatting";
import { ChunkProgressPanel } from "./ChunkProgressPanel";
import { SessionRestoreButton } from "./SessionRestoreButton";
import { TranscriptText } from "./TranscriptText";
import type { SavedSession } from "../types";
import {
  buttonClass,
  cx,
  eyebrowClass,
  mutedTextClass,
  panelClass,
  panelHeaderClass,
} from "./styles";

type PipelineState = "idle" | "active" | "done" | "error";

type RecordingWorkspaceProps = {
  isNative: boolean;
  message: string;
  speakersCount: number;
  speakerMatch: SpeakerMatch | null;
  isRecording: boolean;
  isTranscribing: boolean;
  isAnalyzing: boolean;
  isEnrolling: boolean;
  isMatchingVoice: boolean;
  downloadingModel: string | null;
  downloadProgress: TranscriptionProgressEvent | null;
  selectedModelStatus?: TranscriptionModelStatus;
  chunkStats: TranscriptionChunkStats;
  chunkProgress: TranscriptionChunkSummary;
  transcriptionChunks: TranscriptionChunkRecord[];
  hasAnalysisEvents: boolean;
  level: number;
  /** Verbatim transcript: the analysis evidence. */
  transcript: string;
  /** The verbatim transcript's segments, shown inline with unaligned spans marked. */
  transcriptSegments: TranscriptSegment[];
  /** Display-only rendering without fillers, repeats and fragments. */
  readableTranscript: string;
  interimText: string;
  canEnroll: boolean;
  onEnroll: () => void;
  onSave: () => void;
  /** Whether the next save of a new recording also keeps its raw audio on this device. */
  keepAudio?: boolean;
  /** Absent when the workspace has no recorded audio to keep. */
  onKeepAudioChange?: (keep: boolean) => void;
  /** Saving waits until capture and transcription have finished. */
  saveDisabled?: boolean;
  /** Shown while the unsaved capture cannot be checkpointed. */
  storageWarning?: string | null;
  onExport: () => void;
  /** Saved sessions a restore would replace (named in its confirmation). */
  savedSessionCount: number;
  /** Replaces every saved session with a validated backup; rejects without changing anything. */
  onRestoreSessions: (sessions: SavedSession[]) => Promise<void>;
};

export function RecordingWorkspace({
  isNative,
  message,
  speakersCount,
  speakerMatch,
  isRecording,
  isTranscribing,
  isAnalyzing,
  isEnrolling,
  isMatchingVoice,
  downloadingModel,
  downloadProgress,
  selectedModelStatus,
  chunkStats,
  chunkProgress,
  transcriptionChunks,
  hasAnalysisEvents,
  level,
  transcript,
  transcriptSegments,
  readableTranscript,
  interimText,
  canEnroll,
  onEnroll,
  onSave,
  keepAudio = false,
  onKeepAudioChange,
  saveDisabled = false,
  storageWarning = null,
  onExport,
  savedSessionCount,
  onRestoreSessions,
}: RecordingWorkspaceProps) {
  const [readableView, setReadableView] = useState(false);
  const restoreDisabled =
    isRecording ||
    isTranscribing ||
    Boolean(transcript.trim() || interimText.trim() || hasAnalysisEvents);

  return (
    <div className={`${panelClass} min-w-0 flex-1 p-4`}>
      <div className={`${panelHeaderClass} mb-4 max-sm:flex-col max-sm:items-start`}>
        <div>
          <p className={eyebrowClass}>{isNative ? "Native Rust" : "External Server / WebGPU"}</p>
          <h2 className="m-0 text-2xl font-semibold">{message}</h2>
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap rounded-full border border-[#dae2dd] px-3 py-2 text-[#2d4e43]">
          <UserCheck size={18} />
          {speakersCount
            ? speakerMatch
              ? `${speakerMatch.label} ${formatPercent(speakerMatch.score)}`
              : `${speakersCount} speaker${speakersCount === 1 ? "" : "s"}`
            : "No speakers"}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2" aria-label="Processing status">
        <StatusPill active={isRecording} icon={<Mic size={15} />} label="Recording" />
        <StatusPill
          active={isTranscribing}
          icon={<LoaderCircle size={15} />}
          label="Transcribing"
        />
        <StatusPill
          active={chunkStats.queued > 0 || chunkStats.processing > 0}
          icon={<Waves size={15} />}
          label={`Chunks ${chunkProgress.completed}/${chunkProgress.total}`}
        />
        <StatusPill
          active={Boolean(downloadingModel)}
          icon={<HardDriveDownload size={15} />}
          label={downloadingModel ? `Downloading ${downloadingModel}` : "Downloading"}
          progress={downloadProgress?.progress}
        />
        <StatusPill active={isAnalyzing} icon={<LoaderCircle size={15} />} label="Analyzing" />
        <StatusPill active={isEnrolling} icon={<LoaderCircle size={15} />} label="Enrolling" />
        <StatusPill
          active={isMatchingVoice}
          icon={<LoaderCircle size={15} />}
          label="Identifying speaker"
        />
      </div>

      <div className="mb-4 grid grid-cols-4 overflow-hidden rounded-lg border border-[#dbe4df] max-lg:grid-cols-2 max-sm:grid-cols-1">
        <PipelineStep
          label="Model"
          detail={
            downloadingModel
              ? (downloadProgress?.message ?? `Downloading ${downloadingModel}`)
              : modelStatusLabel(selectedModelStatus)
          }
          state={downloadingModel ? "active" : selectedModelStatus?.cached ? "done" : "idle"}
        />
        <PipelineStep
          label="Audio"
          detail={isRecording ? "Capturing microphone samples" : "Waiting for recording"}
          state={isRecording ? "active" : "idle"}
        />
        <PipelineStep
          label="Chunks"
          detail={chunkStats.lastMessage}
          state={
            chunkStats.failed > 0
              ? "error"
              : chunkStats.processing || chunkStats.queued
                ? "active"
                : chunkStats.completed
                  ? "done"
                  : "idle"
          }
        />
        <PipelineStep
          label="Analysis"
          detail={isAnalyzing ? "Analyzing transcript updates" : "Ready"}
          state={isAnalyzing ? "active" : hasAnalysisEvents ? "done" : "idle"}
        />
      </div>

      <ChunkProgressPanel chunks={transcriptionChunks} progress={chunkProgress} />

      <div className="mb-4 grid h-44 grid-cols-[repeat(42,minmax(0,1fr))] items-center gap-1 overflow-hidden rounded-lg bg-[#17201b] p-4 max-sm:h-32">
        {Array.from({ length: 42 }).map((_, index) => (
          <span
            className="block h-full min-w-0 rounded-md bg-gradient-to-b from-[#e6fff2] to-[#44c295] transition-[opacity,transform] duration-150"
            key={index}
            style={{
              transform: `scaleY(${0.18 + Math.min(1, level * (1 + (index % 5) * 0.11))})`,
              opacity: index / 42 < level ? 1 : 0.35,
            }}
          />
        ))}
      </div>

      <label className="mb-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={readableView}
          onChange={(change) => setReadableView(change.target.checked)}
        />
        Readable view (display only; analysis always uses the verbatim transcript)
      </label>
      <div className="min-h-36 rounded-lg border border-[#dae2dd] p-4">
        <div
          className="break-words text-xl leading-relaxed text-[#17201b] max-sm:text-lg"
          aria-label={readableView ? "Readable transcript" : "Verbatim transcript"}
        >
          {readableView ? (
            readableTranscript || "Transcript will appear here."
          ) : transcript ? (
            <TranscriptText segments={transcriptSegments} />
          ) : (
            "Transcript will appear here."
          )}
          {interimText && <span className="text-[#7b8780]"> {interimText}</span>}
        </div>
      </div>

      {storageWarning && (
        <p
          className="mt-4 mb-0 rounded-md border border-[#e3c9a8] bg-[#fbf3e8] p-3 text-sm text-[#7a4a12]"
          role="alert"
        >
          {storageWarning}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button className={buttonClass} onClick={onEnroll} disabled={!canEnroll}>
          <ShieldCheck size={17} />
          Enroll
        </button>
        <button
          className={buttonClass}
          onClick={onSave}
          disabled={saveDisabled}
          title={
            saveDisabled ? "Available once recording and transcription have finished" : undefined
          }
        >
          <Save size={17} />
          Save
        </button>
        {onKeepAudioChange && (
          <label
            className="flex items-center gap-2 text-sm"
            title="Keeps this recording's raw audio in this browser for annotation review. Deleting the session removes it; backups do not include it."
          >
            <input
              type="checkbox"
              checked={keepAudio}
              onChange={(change) => onKeepAudioChange(change.target.checked)}
            />
            Keep audio on this device for review
          </label>
        )}
        <button className={buttonClass} onClick={onExport}>
          <Download size={17} />
          Export
        </button>
        <SessionRestoreButton
          disabled={restoreDisabled}
          currentSessionCount={savedSessionCount}
          onRestore={onRestoreSessions}
        />
      </div>
    </div>
  );
}

function StatusPill({
  active,
  icon,
  label,
  progress,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  progress?: number;
}) {
  return (
    <div
      className={cx(
        "inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-[#647169]",
        active
          ? "border-[#b9d6cb] bg-[#e9f4f0] text-[#1c6b5a] [&_svg]:animate-spin"
          : "border-[#dbe4df] bg-[#f2f5f3]",
      )}
    >
      {icon}
      <span>{label}</span>
      {active && progress != null && (
        <strong className="text-sm">{Math.round(progress * 100)}%</strong>
      )}
    </div>
  );
}

function PipelineStep({
  label,
  detail,
  state,
}: {
  label: string;
  detail: string;
  state: PipelineState;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-r border-[#dbe4df] bg-[#fbfcfb] p-3 last:border-r-0 max-lg:[&:nth-child(-n+2)]:border-b max-lg:[&:nth-child(2)]:border-r-0 max-sm:border-r-0 max-sm:border-b max-sm:last:border-b-0">
      <span
        className={cx(
          "size-2.5 shrink-0 rounded-full bg-[#b9c5bd]",
          state === "active" && "animate-pulse bg-[#1c6b5a]",
          state === "done" && "bg-[#2f8f68]",
          state === "error" && "bg-[#a33b3b]",
        )}
      />
      <div className="min-w-0">
        <strong className="block truncate">{label}</strong>
        <small className={`block truncate text-xs ${mutedTextClass}`}>{detail}</small>
      </div>
    </div>
  );
}
