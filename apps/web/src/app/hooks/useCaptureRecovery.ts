import {
  canonicalSpokenLanguage,
  createSessionRecord,
  observationFingerprint,
} from "@stutter-tracker/shared";
import { useEffect, useRef, useState } from "react";
import {
  CAPTURE_CHECKPOINT_PREFIX,
  type CaptureCheckpoint,
  type InterruptedCapture,
  captureCheckpointKey,
  claimCapture,
  hasCheckpointedObservation,
  readCaptureCheckpoint,
  removeCaptureCheckpoint,
  writeCaptureCheckpoint,
} from "../../storage/captureCheckpoint";
import { loadSessionsFromStorage } from "../../storage/localStorage";
import { type SavedSession } from "../../types";
import { emptyReport } from "../analysis";
import {
  checkpointState,
  detectInterruptedCaptures,
  mergeInterruptedCaptures,
} from "../captureRecovery";
import { STORE_KEY } from "../config";
import { analyzeLocalCorpus, saveSpeechCorpusSession } from "../speechCorpus";
import type { useWorkspace } from "./useWorkspace";
import type { useSessionLibrary } from "./useSessionLibrary";
import type { useSpeakerProfiles } from "./useSpeakerProfiles";
import type { useLiveAnalysis } from "./useLiveAnalysis";
import type { useChunkTranscription } from "./useChunkTranscription";

type CaptureRecoveryDeps = Pick<
  ReturnType<typeof useWorkspace>,
  | "segments"
  | "setSegments"
  | "pauses"
  | "setPauses"
  | "report"
  | "setReport"
  | "reportRun"
  | "setReportRun"
  | "transcriptModelRef"
  | "transcriptProvenanceRef"
  | "setInterimText"
  | "setMessage"
  | "activeSessionIdRef"
  | "startedAtRef"
  | "samplesRef"
  | "capturedSampleCountRef"
  | "captureDescriptorRef"
  | "sessionLanguageRef"
  | "loadedSessionRef"
  | "viewedSessionRef"
  | "workspaceGenerationRef"
  | "setViewedSession"
  | "isRecordingRef"
> &
  Pick<
    ReturnType<typeof useSessionLibrary>,
    | "setSessions"
    | "setCorpusAnalysis"
    | "sessionsRef"
    | "persistSessions"
    | "serializeSessionMutation"
  > &
  Pick<ReturnType<typeof useSpeakerProfiles>, "setSpeakerMatch"> &
  Pick<ReturnType<typeof useLiveAnalysis>, "analysisRequest" | "analysisQuery" | "isAnalyzing"> &
  Pick<
    ReturnType<typeof useChunkTranscription>,
    "captureInProgress" | "cancelLiveTranscript" | "resetChunkTranscription"
  >;

/** Keeps the unsaved capture recoverable: checkpoints, window ownership and interrupted captures. */
export function useCaptureRecovery({
  segments,
  setSegments,
  pauses,
  setPauses,
  report,
  setReport,
  reportRun,
  setReportRun,
  transcriptModelRef,
  transcriptProvenanceRef,
  setInterimText,
  setMessage,
  activeSessionIdRef,
  startedAtRef,
  samplesRef,
  capturedSampleCountRef,
  captureDescriptorRef,
  sessionLanguageRef,
  loadedSessionRef,
  viewedSessionRef,
  workspaceGenerationRef,
  setViewedSession,
  isRecordingRef,
  setSessions,
  setCorpusAnalysis,
  sessionsRef,
  persistSessions,
  serializeSessionMutation,
  setSpeakerMatch,
  analysisRequest,
  analysisQuery,
  isAnalyzing,
  captureInProgress,
  cancelLiveTranscript,
  resetChunkTranscription,
}: CaptureRecoveryDeps) {
  // Captures that were not saved when a window last closed (or that the workspace set aside), until
  // the user recovers or discards them. Filled once startup knows which captures live windows own.
  const [interruptedCaptures, setInterruptedCaptures] = useState<InterruptedCapture[]>([]);
  // Set while checkpointing the unsaved capture fails, so an interruption would lose it.
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  // Set when this window could not take ownership of its capture.
  const [claimError, setClaimError] = useState<string | null>(null);
  // Id of the unsaved capture in the workspace; null when the workspace holds no unsaved capture.
  const captureIdRef = useRef<string | null>(null);
  // Releases this window's claim on the workspace capture.
  const releaseCaptureRef = useRef<(() => void) | null>(null);
  // Set while recovery waits for ownership of a capture; other workspace changes wait for it.
  const workspaceClaimPendingRef = useRef(false);
  // Set while a recording start waits for the model or the microphone.
  const startPendingRef = useRef(false);
  // The workspace capture as last checkpointed successfully, so setting it aside can tell whether
  // the stored copy is current.
  const checkpointedRef = useRef<{ state: string; checkpoint: CaptureCheckpoint | null } | null>(
    null,
  );

  // Checkpoints the unsaved capture on every observation or analysis change, so closing the tab, a
  // crash or a reload loses at most the change in flight. Failures stay visible until a write
  // succeeds.
  useEffect(() => {
    const id = captureIdRef.current;
    if (!id || viewedSessionRef.current) {
      return;
    }
    const checkpoint = workspaceCheckpoint(id);
    const state = checkpointState(checkpoint);
    if (!hasCheckpointedObservation(checkpoint)) {
      if (removeCaptureCheckpoint(captureCheckpointKey(id))) {
        checkpointedRef.current = { state, checkpoint: null };
        setCheckpointError(null);
      } else {
        // The stored copy is now outdated; keep it from being offered as this capture.
        setCheckpointError(
          "This recording's stored copy is out of date and browser storage refused to update it. Save the recording before replacing it.",
        );
      }
      return;
    }
    try {
      writeCaptureCheckpoint(checkpoint);
      checkpointedRef.current = { state, checkpoint };
      setCheckpointError(null);
    } catch {
      setCheckpointError(
        "This recording is not being kept safe: browser storage is full or unavailable. Save it as soon as it is finished; closing the app now would lose it.",
      );
    }
    // workspaceCheckpoint reads exactly these values from this render. The query state is a
    // dependency too: a new request (such as the final audio after stopping) invalidates the kept
    // analysis until its own run arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    segments,
    pauses,
    report,
    reportRun,
    analysisRequest,
    analysisQuery.isFetching,
    analysisQuery.data,
  ]);

  // Offers captures that no live window owns, and drops ones another window saved or discarded.
  // A window that closes or crashes releases its lock without any event, so ownership is checked
  // again when this window regains focus or becomes visible, when another window writes a
  // checkpoint this one does not offer yet, and periodically.
  useEffect(() => {
    let cancelled = false;
    const detect = () => {
      void detectInterruptedCaptures(sessionsRef.current).then((found) => {
        if (cancelled) {
          return;
        }
        const own = captureIdRef.current ? captureCheckpointKey(captureIdRef.current) : null;
        // Notices whose checkpoint is gone (for example removed above as already saved) go too;
        // ones still stored stay, as their owner may only be busy.
        setInterruptedCaptures((current) =>
          mergeInterruptedCaptures(
            current.filter((item) => readCaptureCheckpoint(item.key) !== null),
            found.filter((item) => item.key !== own),
          ),
        );
      });
    };
    detect();
    const onStorage = (event: StorageEvent) => {
      const key = event.key;
      // Another window saved or deleted sessions: later saves here build on its list instead of
      // overwriting it with this window's older copy.
      if (key === STORE_KEY) {
        try {
          const stored = loadSessionsFromStorage();
          sessionsRef.current = stored;
          setSessions(stored);
        } catch {
          // Unreadable now; keep this window's list rather than dropping it.
        }
        return;
      }
      if (!key?.startsWith(CAPTURE_CHECKPOINT_PREFIX)) {
        return;
      }
      const updated = event.newValue === null ? null : readCaptureCheckpoint(key);
      if (updated === "unavailable") {
        return;
      }
      setInterruptedCaptures((current) =>
        updated
          ? current.map((item) => (item.key === key ? updated : item))
          : current.filter((item) => item.key !== key),
      );
      if (updated) {
        detect();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        detect();
      }
    };
    const interval = window.setInterval(detect, 30_000);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", detect);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", detect);
      document.removeEventListener("visibilitychange", onVisible);
      releaseCaptureRef.current?.();
      releaseCaptureRef.current = null;
    };
  }, []);

  // The workspace capture as a checkpoint. The analysis is kept only when it is the finished
  // analysis of exactly this observation and audio, because it cannot be recomputed after recovery.
  function workspaceCheckpoint(id: string): CaptureCheckpoint {
    // The query's data belongs to the current request (observation and audio), so a run that came
    // from it matches the current audio without fingerprinting the samples again.
    const analysis =
      reportRun &&
      analysisQuery.data &&
      !analysisQuery.isFetching &&
      reportRun.id === analysisQuery.data.runId &&
      reportRun.inputId === observationFingerprint(segments, pauses)
        ? { report, run: reportRun }
        : null;
    return {
      version: 1,
      id,
      startedAt: (startedAtRef.current ?? new Date()).toISOString(),
      updatedAt: new Date().toISOString(),
      language: sessionLanguageRef.current,
      segments,
      pauses,
      analysis,
      recording:
        captureDescriptorRef.current?.sessionId === id ? captureDescriptorRef.current : null,
      transcription: transcriptModelRef.current,
    };
  }

  // Makes `id` the workspace capture, owned by this window until it is saved or set aside.
  function takeWorkspaceCapture(id: string, release: (() => void) | null) {
    releaseWorkspaceCapture();
    workspaceGenerationRef.current += 1;
    captureIdRef.current = id;
    if (release) {
      releaseCaptureRef.current = release;
    } else {
      void claimCapture(id).then((claimed) => {
        if (captureIdRef.current !== id || releaseCaptureRef.current) {
          claimed?.();
        } else if (claimed) {
          releaseCaptureRef.current = claimed;
        } else {
          setClaimError(
            "This recording could not be reserved for this window, so another open window may offer it for recovery. Save it as soon as it is finished.",
          );
        }
      });
    }
  }

  function releaseWorkspaceCapture() {
    releaseCaptureRef.current?.();
    releaseCaptureRef.current = null;
    setClaimError(null);
    captureIdRef.current = null;
    checkpointedRef.current = null;
    setCheckpointError(null);
  }

  // False, with a message, when the workspace holds an observation whose checkpoint is missing or
  // stale: replacing the workspace would lose it.
  function canSetAsideWorkspaceCapture() {
    const id = captureIdRef.current;
    if (!id) {
      return true;
    }
    // A running analysis may still use the capture's audio, which is not kept; its result would be
    // lost with the workspace.
    if (isAnalyzing) {
      setMessage("Wait for the analysis of the current recording to finish first");
      return false;
    }
    const checkpoint = workspaceCheckpoint(id);
    if (checkpointedRef.current?.state === checkpointState(checkpoint)) {
      return true;
    }
    // Nothing to keep, unless an outdated stored copy could not be removed and would be offered.
    if (!hasCheckpointedObservation(checkpoint) && !checkpointedRef.current?.checkpoint) {
      return true;
    }
    setMessage(
      "Save the current recording first: browser storage could not keep a copy of it, so replacing it would lose it",
    );
    return false;
  }

  // Replacing the workspace (a new capture, opening or recovering a recording) offers its unsaved
  // capture for recovery instead of dropping it. Callers check canSetAsideWorkspaceCapture first.
  function setAsideUnsavedCapture() {
    const id = captureIdRef.current;
    const checkpoint = checkpointedRef.current?.checkpoint;
    if (id && checkpoint) {
      setInterruptedCaptures((current) =>
        mergeInterruptedCaptures(current, [
          { key: captureCheckpointKey(id), kind: "checkpoint", checkpoint },
        ]),
      );
    }
    releaseWorkspaceCapture();
  }

  function replaceInterruptedCapture(capture: InterruptedCapture) {
    setInterruptedCaptures((current) =>
      current.map((item) => (item.key === capture.key ? capture : item)),
    );
  }

  function dropInterruptedCapture(key: string) {
    setInterruptedCaptures((current) => current.filter((item) => item.key !== key));
  }

  function showSavedSession(session: SavedSession) {
    startedAtRef.current = new Date(session.startedAt);
    activeSessionIdRef.current = session.id;
    setSegments(session.segments);
    setPauses(session.pauses);
    setReport(session.report);
    setReportRun(session.analysis);
    transcriptModelRef.current = session.analysis.transcription ?? null;
    transcriptProvenanceRef.current = session.transcript?.provenance ?? null;
    cancelLiveTranscript();
    sessionLanguageRef.current = session.context.spokenLanguage;
    loadedSessionRef.current = session;
    setViewedSession(session);
    // Audio is not stored with sessions; keeping the last recording's PCM would analyze
    // this session against someone else's audio.
    samplesRef.current = [];
    capturedSampleCountRef.current = 0;
    captureDescriptorRef.current = null;
  }

  async function recoverInterruptedCapture(capture: InterruptedCapture) {
    if (
      workspaceClaimPendingRef.current ||
      startPendingRef.current ||
      captureInProgress ||
      capture.kind !== "checkpoint" ||
      !canSetAsideWorkspaceCapture()
    ) {
      return;
    }
    // Other workspace changes wait until ownership is settled, so the checks above stay true.
    workspaceClaimPendingRef.current = true;
    let release: (() => void) | null;
    try {
      release = await claimCapture(capture.checkpoint.id);
    } finally {
      workspaceClaimPendingRef.current = false;
    }
    if (!release) {
      setMessage("This recording is open in another window");
      return;
    }
    // A recording may have started meanwhile; replacing its workspace would mix its live input into
    // the recovered capture.
    if (startPendingRef.current || isRecordingRef.current) {
      release();
      return;
    }
    // Another window may have recovered, changed or removed it before releasing it.
    const current = readCaptureCheckpoint(capture.key);
    if (current === "unavailable") {
      release();
      setMessage("Could not recover the recording: browser storage is unavailable");
      return;
    }
    if (current?.kind !== "checkpoint") {
      release();
      if (current) {
        replaceInterruptedCapture(current);
      } else {
        dropInterruptedCapture(capture.key);
      }
      setMessage("This recording changed in another window; check it again");
      return;
    }
    const { checkpoint } = current;
    // Another window may have saved sessions since this one loaded them; recovering against a stale
    // list would also overwrite them on save.
    let storedSessions: SavedSession[];
    try {
      storedSessions = loadSessionsFromStorage();
    } catch {
      release();
      setMessage("Could not recover the recording: saved sessions could not be read");
      return;
    }
    sessionsRef.current = storedSessions;
    setSessions(storedSessions);
    if (storedSessions.some((session) => session.id === checkpoint.id)) {
      release();
      removeCaptureCheckpoint(capture.key);
      dropInterruptedCapture(capture.key);
      setMessage("This recording was already saved");
      return;
    }
    setAsideUnsavedCapture();
    dropInterruptedCapture(capture.key);
    if (checkpoint.analysis) {
      // Its analysis used audio that was not kept, so it is saved as it was rather than reanalyzed
      // from the transcript alone.
      await saveRecoveredCapture(checkpoint, checkpoint.analysis, capture.key, release);
      return;
    }
    startedAtRef.current = new Date(checkpoint.startedAt);
    activeSessionIdRef.current = null;
    samplesRef.current = [];
    capturedSampleCountRef.current = 0;
    // The audio is gone, but the capture's provenance and speaker declaration still apply.
    captureDescriptorRef.current = checkpoint.recording;
    resetChunkTranscription();
    // The recovered transcript keeps the model that produced it.
    transcriptModelRef.current = checkpoint.transcription ?? null;
    transcriptProvenanceRef.current = null;
    sessionLanguageRef.current = checkpoint.language;
    loadedSessionRef.current = null;
    setViewedSession(null);
    takeWorkspaceCapture(checkpoint.id, release);
    setSegments(checkpoint.segments);
    setPauses(checkpoint.pauses);
    setReport(emptyReport());
    setReportRun(null);
    setInterimText("");
    setSpeakerMatch(null);
    setMessage(
      "Recovered the interrupted recording's transcript; its audio was not kept. Save it to keep it.",
    );
  }

  async function saveRecoveredCapture(
    checkpoint: CaptureCheckpoint,
    analysis: NonNullable<CaptureCheckpoint["analysis"]>,
    key: string,
    release: () => void,
  ) {
    // The workspace as recovery left it; opening a session or starting a capture changes it.
    const workspaceAtStart = workspaceGenerationRef.current;
    const session = createSessionRecord({
      id: checkpoint.id,
      recordings: checkpoint.recording ? [checkpoint.recording] : [],
      startedAt: checkpoint.startedAt,
      segments: checkpoint.segments,
      pauses: checkpoint.pauses,
      report: analysis.report,
      run: analysis.run,
      context: {
        spokenLanguage: canonicalSpokenLanguage(checkpoint.language),
        task: null,
        condition: null,
      },
    });
    // The checkpoint and its claim stay until the browser write succeeded under the lock.
    const outcome = await serializeSessionMutation(async () => {
      if (sessionsRef.current.some((candidate) => candidate.id === session.id)) {
        removeCaptureCheckpoint(key);
        release();
        return "already-saved" as const;
      }
      try {
        persistSessions([session, ...sessionsRef.current].slice(0, 50));
      } catch {
        release();
        setInterruptedCaptures((current) =>
          mergeInterruptedCaptures(current, [{ key, kind: "checkpoint", checkpoint }]),
        );
        return "failed" as const;
      }
      removeCaptureCheckpoint(key);
      release();
      // A capture, recording or opened session may have taken the workspace while this save waited.
      if (
        !captureIdRef.current &&
        !startPendingRef.current &&
        !isRecordingRef.current &&
        workspaceGenerationRef.current === workspaceAtStart
      ) {
        setInterimText("");
        setSpeakerMatch(null);
        resetChunkTranscription();
        showSavedSession(session);
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(session));
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
      }
      return "saved" as const;
    });
    setMessage(
      outcome === "failed"
        ? "Could not save the recovered recording: browser storage is full or unavailable"
        : outcome === "already-saved"
          ? "This recording was already saved"
          : "Recovered and saved the interrupted recording; its audio was not kept.",
    );
  }

  async function discardInterruptedCapture(capture: InterruptedCapture) {
    if (
      !window.confirm(
        "Discard the interrupted recording? Its transcript cannot be recovered afterwards.",
      )
    ) {
      return;
    }
    const release = await claimCapture(capture.key.slice(CAPTURE_CHECKPOINT_PREFIX.length));
    if (!release) {
      setMessage("This recording is open in another window");
      return;
    }
    const removed = removeCaptureCheckpoint(capture.key);
    release();
    if (!removed) {
      setMessage("Could not discard the interrupted recording: browser storage is unavailable");
      return;
    }
    dropInterruptedCapture(capture.key);
    setMessage("Interrupted recording discarded");
  }

  return {
    interruptedCaptures,
    checkpointError,
    claimError,
    captureIdRef,
    workspaceClaimPendingRef,
    startPendingRef,
    takeWorkspaceCapture,
    releaseWorkspaceCapture,
    canSetAsideWorkspaceCapture,
    setAsideUnsavedCapture,
    dropInterruptedCapture,
    showSavedSession,
    recoverInterruptedCapture,
    discardInterruptedCapture,
  };
}
