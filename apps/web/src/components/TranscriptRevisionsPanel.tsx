import {
  referenceTranscriptModels,
  sessionTranscriptRevisions,
  TRANSCRIPT_LIMITATION_LABELS,
  type TranscriptProvenance,
  type TranscriptionModelStatus,
  type TranscriptRevision,
} from "@stutter-tracker/shared";
import { useEffect, useMemo, useState } from "react";
import type { KeptSessionAudio } from "../storage/sessionAudio";
import type { SavedSession } from "../types";
import { buttonClass, controlClass, cx, mutedTextClass, panelClass } from "./styles";
import { TranscriptText } from "./TranscriptText";

const ENGINE_LABELS: Record<TranscriptProvenance["engine"], string> = {
  browser: "Browser speech",
  whisperCpp: "whisper.cpp",
  whisperCli: "Whisper CLI",
  fasterWhisper: "Faster-Whisper",
};

/**
 * Transcript revisions of a saved session (vox#26): the current one first, earlier ones kept and
 * readable, each with its provenance; plus the user-started post-session reference transcript.
 */
export function TranscriptRevisionsPanel({
  session,
  audio,
  referenceAvailable,
  pending,
  disabled,
  loadModels,
  onCreateReference,
}: {
  session: SavedSession;
  audio: KeptSessionAudio | null;
  /** Whether whisper.cpp can run here (desktop app or compute server). */
  referenceAvailable: boolean;
  pending: boolean;
  disabled: boolean;
  loadModels: () => Promise<TranscriptionModelStatus[]>;
  onCreateReference: (model: string) => void;
}) {
  const revisions = useMemo(() => sessionTranscriptRevisions(session), [session]);
  const models = useMemo(() => {
    const provisional = revisions[0].provenance;
    return referenceTranscriptModels(
      provisional ?? session.analysis.transcription ?? null,
      provisional?.language ?? session.context.spokenLanguage,
    );
  }, [revisions, session]);
  const [statuses, setStatuses] = useState<TranscriptionModelStatus[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const canReference = referenceAvailable && audio !== null && audio.droppedSeconds === 0;
  useEffect(() => {
    if (!canReference || !models.length) return;
    let current = true;
    loadModels().then(
      (loaded) => {
        if (current) setStatuses(loaded);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
    // Statuses are refreshed when the panel opens and after each reference transcript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReference, models, pending]);
  const cached = (id: string) => statuses?.find((status) => status.id === id)?.cached === true;
  // Default: the largest model already on this device, else large-v3-turbo, else the largest.
  const chosen =
    model && models.includes(model)
      ? model
      : ([...models].reverse().find(cached) ??
        (models.includes("large-v3-turbo") ? "large-v3-turbo" : models.at(-1)) ??
        null);

  return (
    <section className={cx(panelClass, "mb-4 p-4")} aria-labelledby="transcript-revisions-heading">
      <h2 id="transcript-revisions-heading" className="m-0 mb-1 text-lg">
        Transcript revisions
      </h2>
      <p className={cx("m-0 mb-3 text-sm", mutedTextClass)}>
        Analysis uses the newest revision. Earlier revisions stay saved as they were.
      </p>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {[...revisions].reverse().map((revision, index) => (
          <li key={revision.id} aria-label={revisionTitle(revision)}>
            <RevisionSummary revision={revision} current={index === 0} />
          </li>
        ))}
      </ol>

      <h3 className="m-0 mt-4 mb-2 text-base">Reference transcript</h3>
      {!referenceAvailable ? (
        <p className={cx("m-0 text-sm", mutedTextClass)}>
          A reference transcript needs whisper.cpp: use the desktop app or a compute server.
        </p>
      ) : !audio ? (
        <p className={cx("m-0 text-sm", mutedTextClass)}>
          This session has no kept audio, so it cannot be transcribed again.
        </p>
      ) : audio.droppedSeconds > 0 ? (
        <p className={cx("m-0 text-sm", mutedTextClass)}>
          The kept audio misses the first {audio.droppedSeconds.toFixed(0)} s of the recording, so a
          reference transcript would not cover it.
        </p>
      ) : !models.length || !chosen ? (
        <p className={cx("m-0 text-sm", mutedTextClass)}>
          No larger whisper.cpp model than the one used is available.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            Reference model
            <select
              className={controlClass}
              value={chosen}
              disabled={pending || disabled}
              onChange={(change) => setModel(change.target.value)}
            >
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                  {statuses && !cached(id) ? " (download)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={buttonClass}
            disabled={pending || disabled}
            onClick={() => onCreateReference(chosen)}
          >
            {pending ? "Making reference transcript…" : "Make reference transcript"}
          </button>
          <span className={cx("text-sm", mutedTextClass)}>
            Transcribes the kept audio again with {chosen}
            {statuses && !cached(chosen) ? " after downloading it" : ""} and saves it as a new
            revision.
          </span>
        </div>
      )}
    </section>
  );
}

function revisionTitle(revision: TranscriptRevision) {
  return revision.kind === "reference" ? "Reference transcript" : "Provisional transcript";
}

function RevisionSummary({
  revision,
  current,
}: {
  revision: TranscriptRevision;
  current: boolean;
}) {
  const provenance = revision.provenance;
  const reconciliation = revision.reconciliation;
  return (
    <div className="rounded-md border border-[#edf1ee] p-3 text-sm">
      <p className="m-0 font-semibold">
        {revisionTitle(revision)}
        {current ? " (current)" : ""}
        {revision.createdAt && (
          <span className={cx("ml-2 font-normal", mutedTextClass)}>
            {new Date(revision.createdAt).toLocaleString()}
          </span>
        )}
      </p>
      <p className={cx("m-0 mt-1", mutedTextClass)}>
        {provenance
          ? describeProvenance(provenance)
          : "Model, language and preprocessing not recorded"}
      </p>
      {provenance && provenance.limitations.length > 0 && (
        <ul className="m-0 mt-1 pl-5 text-[#7a4a12]">
          {provenance.limitations.map((limitation) => (
            <li key={limitation}>{TRANSCRIPT_LIMITATION_LABELS[limitation]}</li>
          ))}
        </ul>
      )}
      {reconciliation && (
        <p className="m-0 mt-1">
          Compared with the previous revision: {reconciliation.unchangedWords} words unchanged,{" "}
          {reconciliation.substitutedWords} changed, {reconciliation.insertedWords} added,{" "}
          {reconciliation.deletedWords} removed.
        </p>
      )}
      {!current && (
        <details className="mt-1">
          <summary className="cursor-pointer">Show this revision</summary>
          <p className="m-0 mt-1 break-words">
            {revision.segments.length ? <TranscriptText segments={revision.segments} /> : "Empty"}
          </p>
        </details>
      )}
    </div>
  );
}

function describeProvenance(provenance: TranscriptProvenance) {
  const parts = [`${ENGINE_LABELS[provenance.engine]} ${provenance.model}`];
  parts.push(
    `language ${provenance.language}` +
      (provenance.detectedLanguage ? ` (detected ${provenance.detectedLanguage})` : ""),
  );
  const { captureSampleRate, modelSampleRate, chunkSeconds } = provenance.preprocessing;
  if (captureSampleRate && modelSampleRate) {
    parts.push(
      captureSampleRate === modelSampleRate
        ? `${khz(modelSampleRate)} audio`
        : `resampled ${khz(captureSampleRate)} → ${khz(modelSampleRate)}`,
    );
  }
  if (chunkSeconds) parts.push(`${chunkSeconds} s chunks`);
  return parts.join(" · ");
}

function khz(rate: number) {
  return `${(rate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz`;
}
