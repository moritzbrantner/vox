import {
  type RecordingDescriptor,
  UNKNOWN_INPUT_ID,
  audioFingerprint,
  canonicalSpokenLanguage,
  createSessionRecord,
  observationFingerprint,
  reanalyzeSession,
} from "@stutter-tracker/shared";
import { useRef } from "react";
import { captureCheckpointKey, removeCaptureCheckpoint } from "../../storage/captureCheckpoint";
import {
  type KeptSessionAudio,
  putSessionAudio,
  retainSessionAudio,
} from "../../storage/sessionAudio";
import { type SavedSession } from "../../types";
import { analysisAudioPayload } from "../analysis";
import { errorMessage } from "../errors";
import { analyzeLocalCorpus, saveSpeechCorpusSession } from "../speechCorpus";
import type { useWorkspace } from "./useWorkspace";
import type { useSessionLibrary } from "./useSessionLibrary";
import type { useLiveAnalysis } from "./useLiveAnalysis";
import type { useChunkTranscription } from "./useChunkTranscription";
import type { useCaptureRecovery } from "./useCaptureRecovery";
import type { useReanalysis } from "./useReanalysis";
import type { VoiceActivityEvidence } from "@stutter-tracker/shared";

type SessionSavingDeps = Pick<
  ReturnType<typeof useWorkspace>,
  | "segments"
  | "pauses"
  | "report"
  | "reportRun"
  | "transcriptProvenanceRef"
  | "setMessage"
  | "activeSessionIdRef"
  | "startedAtRef"
  | "sampleRateRef"
  | "samplesRef"
  | "capturedSampleCountRef"
  | "captureDescriptorRef"
  | "sessionLanguageRef"
  | "loadedSessionRef"
  | "setViewedAudio"
  | "keepAudio"
  | "viewedSessionRef"
  | "setViewedSession"
> &
  Pick<
    ReturnType<typeof useSessionLibrary>,
    | "setCorpusAnalysis"
    | "sessionsRef"
    | "restorePendingRef"
    | "persistSessions"
    | "serializeSessionMutation"
  > &
  Pick<ReturnType<typeof useLiveAnalysis>, "isAnalyzing"> &
  Pick<ReturnType<typeof useChunkTranscription>, "captureInProgress"> &
  Pick<ReturnType<typeof useCaptureRecovery>, "captureIdRef" | "releaseWorkspaceCapture"> &
  Pick<ReturnType<typeof useReanalysis>, "startReferenceTranscript"> & {
    voiceActivityEvidenceRef: { current: VoiceActivityEvidence | null };
  };

/** Saving the workspace as a new session or as a new analysis run of the loaded one. */
export function useSessionSaving({
  segments,
  pauses,
  report,
  reportRun,
  transcriptProvenanceRef,
  setMessage,
  activeSessionIdRef,
  startedAtRef,
  sampleRateRef,
  samplesRef,
  capturedSampleCountRef,
  captureDescriptorRef,
  sessionLanguageRef,
  loadedSessionRef,
  setViewedAudio,
  keepAudio,
  viewedSessionRef,
  setViewedSession,
  setCorpusAnalysis,
  sessionsRef,
  restorePendingRef,
  persistSessions,
  serializeSessionMutation,
  isAnalyzing,
  captureInProgress,
  captureIdRef,
  releaseWorkspaceCapture,
  startReferenceTranscript,
  voiceActivityEvidenceRef,
}: SessionSavingDeps) {
  const newSessionSavePendingRef = useRef(false);

  async function saveSession() {
    if (restorePendingRef.current > 0) {
      setMessage("Wait for the session restore to finish before saving");
      return;
    }
    if (!segments.length && !pauses.length && !report.events.length) {
      setMessage("Nothing to save");
      return;
    }
    // A saved session freezes the workspace's analysis, so the observation must be complete and
    // the shown report must be the analysis of exactly that observation.
    if (captureInProgress) {
      setMessage("Stop recording and let transcription finish before saving");
      return;
    }
    if (
      !viewedSessionRef.current &&
      (isAnalyzing ||
        (reportRun !== null &&
          (reportRun.inputId !== observationFingerprint(segments, pauses) ||
            reportRun.audioId !== currentAudioId())))
    ) {
      setMessage("Analysis is still updating; save again in a moment");
      return;
    }
    const loaded = loadedSessionRef.current;
    if (
      loaded &&
      observationFingerprint(segments, pauses) ===
        observationFingerprint(loaded.segments, loaded.pauses)
    ) {
      await saveLoadedSession(loaded);
      return;
    }
    // Until a queued save has stored the workspace, another click would store a second copy.
    if (newSessionSavePendingRef.current) {
      setMessage("Session is already being saved");
      return;
    }
    const captureId = captureIdRef.current;
    const descriptor = captureDescriptorRef.current;
    const voiceActivity = voiceActivityEvidenceRef.current;
    // The capture's audio, kept on the device when the user asked for it; either way it feeds the
    // automatic reference transcript of this recording.
    const capturedAudio =
      captureId && descriptor?.sessionId === captureId ? captureForKeeping(descriptor) : null;
    const keptCapture = keepAudio ? capturedAudio : null;
    const reference: { saved: { session: SavedSession; audio: KeptSessionAudio } | null } = {
      saved: null,
    };
    const startedAt = startedAtRef.current?.toISOString() ?? new Date().toISOString();
    const spokenLanguage = canonicalSpokenLanguage(sessionLanguageRef.current);
    newSessionSavePendingRef.current = true;
    let audioOutcome: "kept" | string | null = null;
    const outcome = await serializeSessionMutation(async () => {
      if (captureId && captureIdRef.current !== captureId) {
        // An earlier queued save stored it, or the workspace set it aside while this one waited.
        return sessionsRef.current.some((candidate) => candidate.id === captureId)
          ? ("unchanged" as const)
          : ("set-aside" as const);
      }
      // A capture is saved under its checkpoint id, so a checkpoint left behind by a crash between
      // the save and its removal is recognized as saved instead of being recovered as a duplicate.
      const sessionId =
        captureId && !sessionsRef.current.some((candidate) => candidate.id === captureId)
          ? captureId
          : crypto.randomUUID();
      const session: SavedSession = createSessionRecord({
        id: sessionId,
        // The capture's provenance travels with it; an edited saved session keeps the original's.
        recordings:
          descriptor && descriptor.sessionId === captureId
            ? [{ ...descriptor, sessionId }]
            : (loaded?.recordings.map((recording) => ({ ...recording, sessionId })) ?? []),
        startedAt,
        segments,
        pauses,
        // Speech detection of this very capture run only; a loaded session keeps its own runs.
        report:
          voiceActivity?.captureRunId &&
          descriptor?.sessionId === captureId &&
          voiceActivity.captureRunId === descriptor.runId
            ? { ...report, voiceActivity }
            : report,
        run: reportRun ?? {
          id: crypto.randomUUID(),
          createdAt: null,
          analyzer: null,
          usedAudio: null,
          audioId: null,
          // Saved before any analysis finished: the report was not computed from this observation.
          inputId: UNKNOWN_INPUT_ID,
        },
        context: { spokenLanguage, task: null, condition: null },
        transcript: transcriptProvenanceRef.current
          ? {
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              kind: "provisional",
              provenance: transcriptProvenanceRef.current,
              supersedes: null,
            }
          : undefined,
      });
      try {
        persistSessions([session, ...sessionsRef.current].slice(0, 50));
      } catch {
        return "failed" as const;
      }
      if (captureId) {
        // Left behind if this fails; the next start recognizes it as saved and removes it.
        removeCaptureCheckpoint(captureCheckpointKey(captureId));
        releaseWorkspaceCapture();
      }
      activeSessionIdRef.current = session.id;
      // Later saves of this workspace append runs to this record instead of creating copies.
      loadedSessionRef.current = session;
      setViewedSession(session);
      if (capturedAudio) {
        reference.saved = {
          session,
          audio: { ...capturedAudio, sessionId: session.id, keptAt: new Date().toISOString() },
        };
      }
      if (keptCapture) {
        const kept = { ...keptCapture, sessionId: session.id, keptAt: new Date().toISOString() };
        try {
          await putSessionAudio(kept);
          if (viewedSessionRef.current?.id === session.id) setViewedAudio(kept);
          audioOutcome = "kept";
        } catch (error) {
          audioOutcome = errorMessage(error);
        }
      }
      // Sessions past the limit were dropped above; so is any audio kept with them.
      await retainSessionAudio(sessionsRef.current.map((candidate) => candidate.id)).catch(
        () => undefined,
      );
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(session));
        return "corpus" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    }).finally(() => {
      newSessionSavePendingRef.current = false;
    });
    const audioNote =
      audioOutcome === null
        ? ""
        : audioOutcome === "kept"
          ? "; audio kept on this device for review"
          : `; the audio could not be kept (${audioOutcome})`;
    setMessage(
      (outcome === "failed"
        ? "Could not save the session: browser storage is full or unavailable"
        : outcome === "unchanged"
          ? "Session is already saved"
          : outcome === "set-aside"
            ? "The recording was set aside before it was saved; recover it to save it"
            : outcome === "corpus"
              ? "Session saved to corpus"
              : "Session saved locally") +
        (outcome === "corpus" || outcome === "local" ? audioNote : ""),
    );
    if ((outcome === "corpus" || outcome === "local") && reference.saved) {
      void startReferenceTranscript(reference.saved.session, reference.saved.audio);
    }
  }

  // The raw capture as the workspace holds it, with what is needed to place it on the session
  // clock. The browser engine keeps a rolling window, so earlier samples may be gone.
  function captureForKeeping(descriptor: RecordingDescriptor) {
    const samples = Float32Array.from(samplesRef.current);
    const sampleRate = sampleRateRef.current;
    if (!samples.length || sampleRate <= 0) return null;
    return {
      sampleRate,
      samples,
      startOffsetSeconds: descriptor.startOffsetSeconds,
      discontinuities: descriptor.discontinuities.map((gap) => ({ ...gap })),
      droppedSeconds: Math.max(0, capturedSampleCountRef.current - samples.length) / sampleRate,
      audioId: audioFingerprint(samples, sampleRate),
    };
  }

  // Fingerprint of the audio an analysis of the workspace would use now (null without audio).
  function currentAudioId() {
    const audio = analysisAudioPayload(samplesRef.current, sampleRateRef.current);
    return audio.samples && audio.sampleRate
      ? audioFingerprint(audio.samples, audio.sampleRate)
      : null;
  }

  // Saving the session already on screen never creates a copy: either it is unchanged, or a new
  // analysis run is appended to its history.
  async function saveLoadedSession(loaded: SavedSession) {
    const knownRuns = [loaded.analysis.id, ...loaded.priorAnalyses.map((run) => run.id)];
    if (!reportRun || knownRuns.includes(reportRun.id)) {
      setMessage("Session is already saved");
      return;
    }
    const run = reportRun;
    const savedReport = report;
    // Runs after every queued mutation and rebuilds from the latest stored record, so a session
    // deleted meanwhile is never written back and queued saves keep each other's runs.
    const outcome = await serializeSessionMutation(async () => {
      const latest = sessionsRef.current.find((candidate) => candidate.id === loaded.id);
      if (!latest) {
        return "deleted" as const;
      }
      if (
        latest.analysis.id === run.id ||
        latest.priorAnalyses.some((prior) => prior.id === run.id)
      ) {
        return "unchanged" as const;
      }
      const updated = reanalyzeSession(latest, run, savedReport);
      // The user may have opened another session while this save waited in the queue.
      if (loadedSessionRef.current?.id === updated.id) {
        loadedSessionRef.current = updated;
      }
      try {
        persistSessions(
          sessionsRef.current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        );
      } catch {
        return "failed" as const;
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(updated));
        return "corpus" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    });
    setMessage(
      outcome === "failed"
        ? "Could not save the session: browser storage is full or unavailable"
        : outcome === "deleted"
          ? "Session was deleted; nothing saved"
          : outcome === "unchanged"
            ? "Session is already saved"
            : outcome === "corpus"
              ? "New analysis saved to the session"
              : "New analysis saved locally",
    );
  }

  return { saveSession };
}
