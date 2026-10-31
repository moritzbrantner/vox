import {
  REFERENCE_TRANSCRIPT_MODEL,
  type TranscriptCompute,
  UNKNOWN_SPOKEN_LANGUAGE,
  canonicalSpokenLanguage,
  isReplayable,
  markUnalignedTiming,
  reanalyzeSession,
  referenceTranscriptApplies,
  reviseTranscript,
  transcriptProvenance,
} from "@stutter-tracker/shared";
import { useRef, useState } from "react";
import { type KeptSessionAudio, clockSecondsAt } from "../../storage/sessionAudio";
import { type SavedSession, type TranscriptSegment, type TranscriptionSettings } from "../../types";
import { analyzeWithFallback } from "../analysis";
import {
  REFERENCE_CHUNK_SECONDS,
  TRANSCRIPTION_TARGET_SAMPLE_RATE,
  computeClient,
  isDesktopApp,
} from "../config";
import { errorMessage } from "../errors";
import { identifyTranscriptSpeakers } from "../speakerProfiles";
import { analyzeLocalCorpus, saveSpeechCorpusSession } from "../speechCorpus";
import { loadTranscriptionModels, resampleSamples, transcribeAudio } from "../transcription";
import type { useWorkspace } from "./useWorkspace";
import type { useSessionLibrary } from "./useSessionLibrary";
import type { useSpeakerProfiles } from "./useSpeakerProfiles";
import type { useTranscriptionModels } from "./useTranscriptionModels";
import type { useChunkTranscription } from "./useChunkTranscription";
import type { useSessionUpdates } from "./useSessionUpdates";

type ReanalysisDeps = Pick<
  ReturnType<typeof useWorkspace>,
  | "setSegments"
  | "setReport"
  | "setReportRun"
  | "transcriptModelRef"
  | "transcriptProvenanceRef"
  | "isNative"
  | "setMessage"
  | "loadedSessionRef"
  | "viewedSessionRef"
  | "setViewedSession"
> &
  Pick<
    ReturnType<typeof useSessionLibrary>,
    "setCorpusAnalysis" | "sessionsRef" | "persistSessions" | "serializeSessionMutation"
  > &
  Pick<ReturnType<typeof useSpeakerProfiles>, "speakersRef"> &
  Pick<ReturnType<typeof useTranscriptionModels>, "transcriptionRef"> &
  Pick<ReturnType<typeof useChunkTranscription>, "setLastCompute" | "captureInProgress"> &
  Pick<ReturnType<typeof useSessionUpdates>, "updateStoredSession">;

/** Reanalysis of saved sessions and the automatic post-session reference transcript. */
export function useReanalysis({
  setSegments,
  setReport,
  setReportRun,
  transcriptModelRef,
  transcriptProvenanceRef,
  isNative,
  setMessage,
  loadedSessionRef,
  viewedSessionRef,
  setViewedSession,
  setCorpusAnalysis,
  sessionsRef,
  persistSessions,
  serializeSessionMutation,
  speakersRef,
  transcriptionRef,
  setLastCompute,
  captureInProgress,
  updateStoredSession,
}: ReanalysisDeps) {
  // Session ids whose reference transcript is being made.
  const [referencePendingIds, setReferencePendingIds] = useState<string[]>([]);
  const referencePendingRef = useRef(new Set<string>());

  const reanalyzingRef = useRef(new Set<string>());
  const [reanalyzingSessionIds, setReanalyzingSessionIds] = useState<string[]>([]);

  // Explicit reanalysis of a saved transcript (no stored audio): appends a run, keeping the
  // earlier ones, and shows the new result if that session is on screen.
  async function reanalyzeSavedSession(session: SavedSession) {
    if (captureInProgress) {
      setMessage("Stop recording and let transcription finish before reanalyzing");
      return;
    }
    // Audio is not stored, so a session without transcript or pauses has nothing to replay;
    // analyzing empty input would replace an acoustic-only result with nothing.
    if (!isReplayable(session)) {
      setMessage("This session has no saved transcript to reanalyze");
      return;
    }
    // One run per session at a time, so runs are appended in the order they were started.
    if (reanalyzingRef.current.has(session.id)) {
      return;
    }
    reanalyzingRef.current.add(session.id);
    setReanalyzingSessionIds([...reanalyzingRef.current]);
    try {
      await runReanalysis(session);
    } finally {
      reanalyzingRef.current.delete(session.id);
      setReanalyzingSessionIds([...reanalyzingRef.current]);
    }
  }

  async function runReanalysis(session: SavedSession) {
    setMessage("Reanalyzing saved session");
    const analysis = await analyzeWithFallback({
      segments: session.segments,
      pauses: session.pauses,
      sessionStartedAt: session.startedAt,
    });
    const outcome = await serializeSessionMutation(async () => {
      const latest = sessionsRef.current.find((candidate) => candidate.id === session.id);
      if (!latest) {
        return "deleted" as const;
      }
      const updated = reanalyzeSession(
        latest,
        {
          id: analysis.runId,
          createdAt: analysis.createdAt,
          analyzer: analysis.analyzer,
          usedAudio: false,
          audioId: null,
          // The stored transcript is reanalyzed: the model that produced its current revision.
          transcription: latest.transcript?.provenance
            ? {
                engine: latest.transcript.provenance.engine,
                model: latest.transcript.provenance.model,
              }
            : (latest.analysis.transcription ?? null),
        },
        analysis.report,
      );
      try {
        persistSessions(
          sessionsRef.current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        );
      } catch {
        return "failed" as const;
      }
      if (viewedSessionRef.current?.id === updated.id) {
        loadedSessionRef.current = updated;
        setViewedSession(updated);
        setReport(updated.report);
        setReportRun(updated.analysis);
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(updated));
        return "saved" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    });
    setMessage(
      outcome === "saved"
        ? "Reanalysis added to the session"
        : outcome === "local"
          ? isDesktopApp()
            ? "Reanalysis saved locally; the desktop corpus still has the earlier analysis"
            : "Reanalysis added to the session"
          : outcome === "deleted"
            ? "Session was deleted; nothing reanalyzed"
            : "Could not save the reanalysis: browser storage is full or unavailable",
    );
  }

  /**
   * Automatic post-session reference transcript (vox#26, owner answer Q3 B): after a recording is
   * saved, its whole audio is transcribed again with the fixed REFERENCE_TRANSCRIPT_MODEL when
   * whisper.cpp can run here, that model is already on this device and it is larger than the
   * provisional model. The result is saved as a new current transcript revision next to the
   * provisional one and the session is reanalyzed. Nothing is downloaded for it.
   */
  async function startReferenceTranscript(session: SavedSession, audio: KeptSessionAudio) {
    const model = REFERENCE_TRANSCRIPT_MODEL;
    if (
      !(isNative || computeClient.destination.kind !== "onDevice") ||
      audio.sessionId !== session.id ||
      // A rolling capture window lost the start; a reference would not cover the recording.
      audio.droppedSeconds > 0 ||
      !referenceTranscriptApplies(
        session.transcript?.provenance ?? session.analysis.transcription ?? null,
      )
    ) {
      return;
    }
    if (referencePendingRef.current.has(session.id)) {
      return;
    }
    referencePendingRef.current.add(session.id);
    setReferencePendingIds([...referencePendingRef.current]);
    try {
      const settings: TranscriptionSettings = {
        engine: "whisperCpp",
        model,
        device: transcriptionRef.current.device,
      };
      const statuses = await loadTranscriptionModels("whisperCpp").catch(() => []);
      if (!statuses.some((status) => status.id === model && status.cached)) {
        return;
      }
      // Bound now: the session's own language, never the current selection.
      const spoken = canonicalSpokenLanguage(session.context.spokenLanguage);
      const language =
        session.transcript?.provenance?.language ??
        (spoken === UNKNOWN_SPOKEN_LANGUAGE ? "auto" : spoken);
      const chunk = Math.round(audio.sampleRate * REFERENCE_CHUNK_SECONDS);
      const segments: TranscriptSegment[] = [];
      let detectedLanguage: string | null = null;
      // The last chunk's: after a GPU failure every later chunk runs on the CPU.
      let compute: TranscriptCompute | null = null;
      for (let start = 0; start < audio.samples.length; start += chunk) {
        const end = Math.min(audio.samples.length, start + chunk);
        setMessage(
          `Reference transcript with ${model}: ${Math.round((start / audio.samples.length) * 100)}%`,
        );
        const samples = resampleSamples(
          Array.from(audio.samples.subarray(start, end)),
          audio.sampleRate,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
        );
        const result = await transcribeAudio(
          samples,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          settings,
          language,
        );
        detectedLanguage ??= result.language ?? null;
        compute = result.compute ?? compute;
        if (result.compute) setLastCompute(result.compute);
        const identified = await identifyTranscriptSpeakers(
          result.segments,
          samples,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          speakersRef.current,
        );
        // Chunk time to the session clock through the capture's sample index, across its gaps.
        const clock = (seconds: number) =>
          clockSecondsAt(
            audio,
            Math.min(end, start + Math.round(Math.max(0, seconds) * audio.sampleRate)),
          );
        segments.push(
          ...markUnalignedTiming(identified).map((segment) =>
            segment.alignment === "unaligned"
              ? {
                  ...segment,
                  startSeconds: clock(0),
                  endSeconds: clock(0),
                }
              : {
                  ...segment,
                  startSeconds: clock(segment.startSeconds),
                  endSeconds: clock(segment.endSeconds),
                },
          ),
        );
      }
      const provenance = transcriptProvenance({
        engine: "whisperCpp",
        model,
        language,
        detectedLanguage,
        preprocessing: {
          captureSampleRate: audio.sampleRate,
          modelSampleRate: TRANSCRIPTION_TARGET_SAMPLE_RATE,
          chunkSeconds: REFERENCE_CHUNK_SECONDS,
        },
        compute,
      });
      const revision: { record: SavedSession | null } = { record: null };
      const saved = await updateStoredSession(
        session.id,
        (latest) => {
          revision.record = reviseTranscript(
            latest,
            {
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              kind: "reference",
              provenance,
            },
            segments,
          );
          return revision.record;
        },
        "reference transcript",
      );
      const updated = revision.record;
      if (!saved || !updated) {
        return;
      }
      // Shown only if the user is still on that session; another session is never touched.
      if (viewedSessionRef.current?.id === updated.id) {
        setSegments(updated.segments);
        transcriptProvenanceRef.current = provenance;
        transcriptModelRef.current = { engine: provenance.engine, model: provenance.model };
      }
      await reanalyzeSavedSession(updated);
    } catch (error) {
      setMessage(`Reference transcript failed: ${errorMessage(error)}`);
    } finally {
      referencePendingRef.current.delete(session.id);
      setReferencePendingIds([...referencePendingRef.current]);
    }
  }

  return {
    referencePendingIds,
    reanalyzingSessionIds,
    reanalyzeSavedSession,
    startReferenceTranscript,
  };
}
