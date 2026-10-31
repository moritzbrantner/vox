import {
  buildEvidenceExport,
  hasConsent,
  requireConsent,
  renderEvidenceReport,
  transcriptSpeakersOf,
} from "@stutter-tracker/shared";
import { FileDown } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CONSENT_LEDGER_KEY,
  loadConsentLedger,
  recordConsentDecision,
} from "../storage/localStorage";
import { appStorage } from "../storage/protectedStorage";
import type { SavedSession } from "../types";
import { buttonClass, mutedTextClass, panelClass } from "./styles";

/**
 * User-directed export for a therapist: choose sessions and what to include, see exactly what
 * will be exported, then download. Nothing is sent anywhere; the file is built in memory.
 */
export function EvidenceExportPanel({ sessions }: { sessions: SavedSession[] }) {
  const [sharingAllowed, setSharingAllowed] = useState(() => {
    try {
      return hasConsent(loadConsentLedger(), "clinicianSharing");
    } catch {
      return false;
    }
  });
  const [consentMessage, setConsentMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [includeTranscripts, setIncludeTranscripts] = useState(false);
  const [includeSpeakerNames, setIncludeSpeakerNames] = useState(false);
  const [excludedSpeakers, setExcludedSpeakers] = useState<string[]>([]);
  const [previewFormat, setPreviewFormat] = useState<"report" | "data">("report");

  // Nothing is built while the panel is closed, so recording renders do no export work.
  const selected = useMemo(
    () => (open ? sessions.filter((session) => selectedIds.includes(session.id)) : []),
    [open, sessions, selectedIds],
  );
  const speakers = useMemo(() => transcriptSpeakersOf(selected), [selected]);
  const exportOptions = useMemo(() => {
    // Exclusions only count for speakers present in the current selection.
    const present = speakers.map((speaker) => speaker.id);
    const excluded = excludedSpeakers.filter((id) => present.includes(id));
    return {
      sessionIds: selected.map((session) => session.id),
      includeTranscripts,
      transcriptSpeakers: excluded.length
        ? present.filter((id) => !excluded.includes(id))
        : ("all" as const),
      includeSpeakerNames,
    };
  }, [selected, speakers, excludedSpeakers, includeTranscripts, includeSpeakerNames]);
  // The preview is stamped when built; downloads are rebuilt and stamped at click time.
  const preview = useMemo(
    () =>
      open ? buildEvidenceExport(sessions, { ...exportOptions, exportedAt: new Date() }) : null,
    [open, sessions, exportOptions],
  );
  const report = useMemo(() => (preview ? renderEvidenceReport(preview) : ""), [preview]);
  const data = useMemo(() => (preview ? JSON.stringify(preview, null, 2) : ""), [preview]);
  const hasSessions = (preview?.sessions.length ?? 0) > 0;
  const download = (format: "report" | "data") => {
    try {
      if (!sharingAllowed) return;
      requireConsent(loadConsentLedger(), "clinicianSharing");
      const evidence = buildEvidenceExport(sessions, { ...exportOptions, exportedAt: new Date() });
      downloadFile(
        format === "report" ? "speaking-evidence.txt" : "speaking-evidence.json",
        format === "report" ? renderEvidenceReport(evidence) : JSON.stringify(evidence, null, 2),
        format === "report" ? "text/plain" : "application/json",
      );
    } catch {
      setSharingAllowed(false);
      setConsentMessage(
        "Sharing consent could not be confirmed. Grant consent before downloading.",
      );
    }
  };

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  return (
    <section className={`${panelClass} mt-4 p-4`} aria-label="Export for review">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-xl font-semibold">Export for review</h2>
          <p className={`m-0 mt-1 text-sm ${mutedTextClass}`}>
            Choose sessions to share with a therapist. Nothing is uploaded; you get a file to pass
            on yourself, and copies you share cannot be recalled.
          </p>
        </div>
        <button type="button" className={buttonClass} onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Choose sessions"}
        </button>
      </div>

      {open && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="grid content-start gap-3">
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-2 font-semibold">Sessions</legend>
              {sessions.length === 0 ? (
                <p className={`m-0 ${mutedTextClass}`}>No saved sessions yet.</p>
              ) : (
                sessions.map((session, index) => (
                  <label key={session.id} className="flex items-center gap-2 py-1">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(session.id)}
                      onChange={() => setSelectedIds((ids) => toggle(ids, session.id))}
                    />
                    Session {index + 1} · {new Date(session.startedAt).toLocaleString()} ·{" "}
                    {session.report.stutterCount} events
                  </label>
                ))
              )}
            </fieldset>
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-2 font-semibold">Include</legend>
              <label className="flex items-center gap-2 py-1">
                <input
                  type="checkbox"
                  checked={includeTranscripts}
                  onChange={(event) => setIncludeTranscripts(event.target.checked)}
                />
                Transcripts
              </label>
              {includeTranscripts && (
                <>
                  <label className="flex items-center gap-2 py-1">
                    <input
                      type="checkbox"
                      checked={includeSpeakerNames}
                      onChange={(event) => setIncludeSpeakerNames(event.target.checked)}
                    />
                    Speaker names (otherwise "Speaker 1", "Speaker 2")
                  </label>
                  {speakers.length > 0 && (
                    <div className="mt-1 pl-6">
                      <p className={`m-0 text-sm ${mutedTextClass}`}>
                        Words of these speakers are included:
                      </p>
                      {speakers.map((speaker) => (
                        <label key={speaker.id} className="flex items-center gap-2 py-1">
                          <input
                            type="checkbox"
                            checked={!excludedSpeakers.includes(speaker.id)}
                            onChange={() => setExcludedSpeakers((ids) => toggle(ids, speaker.id))}
                          />
                          {speaker.label}
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
            </fieldset>
            <p className={`m-0 text-sm ${mutedTextClass}`}>
              Never included: audio, voiceprints, device details and the app's severity label.
            </p>
            <label className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                checked={sharingAllowed}
                onChange={(event) => {
                  const granted = event.target.checked;
                  try {
                    recordConsentDecision({ purpose: "clinicianSharing", granted });
                    setSharingAllowed(granted);
                    setConsentMessage("");
                  } catch {
                    if (!granted) {
                      try {
                        appStorage().removeItem(CONSENT_LEDGER_KEY);
                      } catch {
                        /* Storage unavailable. */
                      }
                    }
                    setSharingAllowed(false);
                    setConsentMessage(
                      "Sharing consent could not be saved. Download is unavailable.",
                    );
                  }
                }}
              />
              I consent to sharing selected evidence with a clinician
            </label>
            {consentMessage && <p role="alert">{consentMessage}</p>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={!hasSessions || !sharingAllowed}
                onClick={() => download("report")}
              >
                <FileDown size={16} />
                Download report
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={!hasSessions || !sharingAllowed}
                onClick={() => download("data")}
              >
                <FileDown size={16} />
                Download data
              </button>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="m-0 font-semibold">Preview: exactly what will be exported</h3>
              <div role="group" aria-label="Preview format" className="flex gap-1">
                {(["report", "data"] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    aria-pressed={previewFormat === format}
                    className={`${buttonClass} ${previewFormat === format ? "font-semibold" : ""}`}
                    onClick={() => setPreviewFormat(format)}
                  >
                    {format === "report" ? "Report" : "Data (JSON)"}
                  </button>
                ))}
              </div>
            </div>
            <pre
              aria-label="Export preview"
              className="m-0 max-h-96 overflow-auto rounded-lg bg-[#f5f7f5] p-3 text-xs whitespace-pre-wrap"
            >
              {!hasSessions
                ? "Select at least one session."
                : previewFormat === "report"
                  ? report
                  : data}
            </pre>
            <p className={`m-0 mt-2 text-xs ${mutedTextClass}`}>
              The export time is set when you download.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

// Built in memory and handed to the browser's download; no temporary file is written.
function downloadFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
