import {
  describeCompute,
  REFERENCE_TRANSCRIPT_MODEL,
  referenceTranscriptApplies,
  sessionTranscriptRevisions,
  TRANSCRIPT_LIMITATION_LABELS,
  type TranscriptProvenance,
  type TranscriptRevision,
} from "@stutter-tracker/shared";
import { useMemo } from "react";
import type { SavedSession } from "../types";
import { cx, mutedTextClass, panelClass } from "./styles";
import { TranscriptText } from "./TranscriptText";

const ENGINE_LABELS: Record<TranscriptProvenance["engine"], string> = {
  browser: "Browser speech",
  whisperCpp: "whisper.cpp",
  whisperCli: "Whisper CLI",
  fasterWhisper: "Faster-Whisper",
};

/**
 * Transcript revisions of a saved session (vox#26): the current one first, earlier ones kept and
 * readable, each with its provenance; plus the state of the automatic post-session reference
 * transcript (owner answer Q3 B), which runs after each recording without a user action.
 */
export function TranscriptRevisionsPanel({
  session,
  referenceAvailable,
  pending,
}: {
  session: SavedSession;
  /** Whether whisper.cpp can run here (desktop app or compute server). */
  referenceAvailable: boolean;
  /** Whether this session's reference transcript is being made. */
  pending: boolean;
}) {
  const revisions = useMemo(() => sessionTranscriptRevisions(session), [session]);
  const hasReference = revisions.some((revision) => revision.kind === "reference");
  const provisional = revisions[0].provenance ?? session.analysis.transcription ?? null;

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

      {pending ? (
        <p className="m-0 mt-3 text-sm" role="status">
          Making the reference transcript with whisper.cpp {REFERENCE_TRANSCRIPT_MODEL}…
        </p>
      ) : (
        !hasReference && (
          <p className={cx("m-0 mt-3 text-sm", mutedTextClass)}>
            {!referenceTranscriptApplies(provisional)
              ? `No reference transcript: the provisional transcript already used a model at least as large as ${REFERENCE_TRANSCRIPT_MODEL}.`
              : !referenceAvailable
                ? "No reference transcript: it needs whisper.cpp, in the desktop app or on a compute server."
                : `No reference transcript. After each recording, whisper.cpp ${REFERENCE_TRANSCRIPT_MODEL} transcribes the whole recording again when that model is on this device, and saves the result as a new revision.`}
          </p>
        )
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
  if (provenance.compute) parts.push(describeCompute(provenance.compute));
  return parts.join(" · ");
}

function khz(rate: number) {
  return `${(rate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz`;
}
