import {
  ANNOTATION_EXCHANGE_RIGHTS,
  buildAnnotationExchange,
  currentConsent,
  encodeSamples,
  hasConsent,
  requireConsent,
} from "@stutter-tracker/shared";
import { FileDown, FileUp } from "lucide-react";
import { useState } from "react";
import { loadConsentLedger, recordConsentDecision } from "../storage/localStorage";
import { clockSecondsAt, type KeptSessionAudio } from "../storage/sessionAudio";
import type { SavedSession } from "../types";
import { useReviewAudio } from "./ReviewAudio";
import { buttonClass, cx, mutedTextClass, panelClass } from "./styles";

export const ANNOTATION_EXCHANGE_FILENAME = "vox-annotation-exchange.json";

/**
 * Exchange annotations with a rater on another device (vox#23). The file holds the transcript,
 * annotation revisions and validation declaration, and the session's kept audio only when it is
 * selected here and previewed. Sending needs clinician-sharing consent; analysis results,
 * conditions, dates and voiceprints are never included.
 */
export function AnnotationExchangePanel({
  session,
  audio,
  onImport,
}: {
  session: SavedSession | null;
  audio: KeptSessionAudio | null;
  onImport: (file: File) => Promise<void>;
}) {
  const [sharingAllowed, setSharingAllowed] = useState(() => {
    try {
      return hasConsent(loadConsentLedger(), "clinicianSharing");
    } catch {
      return false;
    }
  });
  const [includeAudio, setIncludeAudio] = useState(false);
  const [message, setMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const preview = useReviewAudio(includeAudio ? audio : null);
  const audioIncluded = includeAudio && audio !== null;

  function download() {
    if (!session) return;
    try {
      const ledger = loadConsentLedger();
      requireConsent(ledger, "clinicianSharing");
      const exchange = buildAnnotationExchange(session, {
        exportedAt: new Date(),
        consentGrantedAt: currentConsent(ledger, "clinicianSharing")!.at,
        audio: audioIncluded
          ? {
              sampleRate: audio.sampleRate,
              startOffsetSeconds: audio.startOffsetSeconds,
              discontinuities: audio.discontinuities,
              droppedSeconds: audio.droppedSeconds,
              audioId: audio.audioId,
              samples: encodeSamples(audio.samples),
            }
          : null,
      });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exchange)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = ANNOTATION_EXCHANGE_FILENAME;
      link.click();
      URL.revokeObjectURL(url);
      setMessage("Annotation file downloaded");
    } catch {
      setSharingAllowed(false);
      setMessage("Sharing consent could not be confirmed. Grant consent before downloading.");
    }
  }

  const speakers = session
    ? [...new Set(session.segments.flatMap((segment) => segment.speakerLabel ?? []))]
    : [];

  return (
    <section className={cx(panelClass, "mb-4 p-4")} aria-labelledby="exchange-heading">
      <h2 id="exchange-heading" className="m-0 mb-1 text-lg">
        Exchange annotations
      </h2>
      <p className={cx("m-0 mb-3 text-sm", mutedTextClass)}>
        Send a session to a clinician rater on another device and import their annotations back.
        Nothing is uploaded; you pass the file on yourself, and copies you share cannot be recalled.
      </p>

      {session ? (
        <div className="mb-4 grid gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sharingAllowed}
              onChange={(change) => {
                const granted = change.target.checked;
                try {
                  recordConsentDecision({ purpose: "clinicianSharing", granted });
                  setSharingAllowed(granted);
                  setMessage("");
                } catch {
                  setSharingAllowed(false);
                  setMessage("Sharing consent could not be saved. Download is unavailable.");
                }
              }}
            />
            I consent to sharing selected evidence with a clinician
          </label>
          {audio && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeAudio}
                onChange={(change) => setIncludeAudio(change.target.checked)}
              />
              Include this session's kept audio
            </label>
          )}
          <div
            aria-label="File preview"
            role="group"
            className="rounded border border-[#dae2dd] p-3"
          >
            <p className="m-0 font-semibold">The file will contain</p>
            <ul className="m-0 pl-5">
              <li>
                Transcript: {session.segments.length} segment
                {session.segments.length === 1 ? "" : "s"}
                {speakers.length > 0 && `, with speaker names ${speakers.join(", ")}`}
              </li>
              <li>
                Annotation revisions: {session.annotations.length}
                {session.validation ? " and the two-rater validation declaration" : ""}
              </li>
              <li>
                Audio:{" "}
                {audioIncluded
                  ? `${(audio.samples.length / audio.sampleRate).toFixed(1)} s at ${audio.sampleRate} Hz, about ${Math.ceil((audio.samples.length * 4 * 4) / 3 / 1_000_000)} MB`
                  : "none"}
              </li>
            </ul>
            {audioIncluded && (
              <button
                type="button"
                className={cx(buttonClass, "mt-2")}
                disabled={!preview.available}
                onClick={() =>
                  preview.playing
                    ? preview.stop()
                    : preview.play({
                        startSeconds: 0,
                        endSeconds: clockSecondsAt(audio, audio.samples.length - 1),
                      })
                }
              >
                {preview.playing ? "Stop preview" : "Play the audio to be sent"}
              </button>
            )}
            <p className={cx("m-0 mt-2", mutedTextClass)}>
              Never included: analysis results, assistance conditions, recording dates and
              voiceprints.
            </p>
            <p className="m-0 mt-2">Permitted use: {ANNOTATION_EXCHANGE_RIGHTS.statement}</p>
          </div>
          <div>
            <button
              type="button"
              className={buttonClass}
              disabled={!sharingAllowed}
              onClick={download}
            >
              <FileDown size={16} aria-hidden="true" /> Download annotation file
            </button>
          </div>
        </div>
      ) : (
        <p className={cx("m-0 mb-3 text-sm", mutedTextClass)}>
          Open a saved session to send it to a rater.
        </p>
      )}

      <label className="flex flex-wrap items-center gap-2 text-sm">
        <FileUp size={16} aria-hidden="true" />
        Import annotation file
        <input
          type="file"
          accept="application/json,.json"
          disabled={importing}
          onChange={async (change) => {
            const file = change.target.files?.[0];
            change.target.value = "";
            if (!file) return;
            setImporting(true);
            try {
              await onImport(file);
            } finally {
              setImporting(false);
            }
          }}
        />
      </label>
      {message && (
        <p role="status" className="mb-0 mt-2 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
