import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { captureCheckpointKey, removeCaptureCheckpoint } from "../../storage/captureCheckpoint";
import { replaceStoredSessions } from "../../storage/localStorage";
import { deleteSessionAudio, retainSessionAudio } from "../../storage/sessionAudio";
import { type SavedSession } from "../../types";
import { emptyReport } from "../analysis";
import { isDesktopApp } from "../config";
import { errorMessage } from "../errors";
import {
  analyzeLocalCorpus,
  deleteSpeechCorpusSession,
  loadSpeechCorpus,
  ownSessions,
} from "../speechCorpus";
import type { useWorkspace } from "./useWorkspace";
import type { useSessionLibrary } from "./useSessionLibrary";
import type { useSpeakerProfiles } from "./useSpeakerProfiles";
import type { useChunkTranscription } from "./useChunkTranscription";
import type { useCaptureRecovery } from "./useCaptureRecovery";

type SessionRemovalDeps = Pick<
  ReturnType<typeof useWorkspace>,
  | "setSegments"
  | "setPauses"
  | "setReport"
  | "setReportRun"
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
  | "setViewedAudio"
  | "viewedSessionRef"
  | "setViewedSession"
> &
  Pick<
    ReturnType<typeof useSessionLibrary>,
    | "setSessions"
    | "setCorpusAnalysis"
    | "sessionsRef"
    | "restorePendingRef"
    | "persistSessions"
    | "serializeSessionMutation"
  > &
  Pick<ReturnType<typeof useSpeakerProfiles>, "setSpeakerMatch"> &
  Pick<ReturnType<typeof useChunkTranscription>, "resetChunkTranscription"> &
  Pick<ReturnType<typeof useCaptureRecovery>, "dropInterruptedCapture">;

/** Deleting a session and replacing all sessions from a backup. */
export function useSessionRemoval({
  setSegments,
  setPauses,
  setReport,
  setReportRun,
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
  setViewedAudio,
  viewedSessionRef,
  setViewedSession,
  setSessions,
  setCorpusAnalysis,
  sessionsRef,
  restorePendingRef,
  persistSessions,
  serializeSessionMutation,
  setSpeakerMatch,
  resetChunkTranscription,
  dropInterruptedCapture,
}: SessionRemovalDeps) {
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);

  async function deleteSession(session: SavedSession) {
    setDeletingSessionId(session.id);
    try {
      const corpus = await serializeSessionMutation(async () => {
        // A checkpoint of this capture that outlived its save would bring it back as an
        // interrupted recording, so deletion stops while it cannot be removed.
        if (!removeCaptureCheckpoint(captureCheckpointKey(session.id))) {
          throw new Error("its unsaved copy in browser storage could not be removed");
        }
        dropInterruptedCapture(captureCheckpointKey(session.id));
        try {
          await deleteSessionAudio(session.id);
        } catch (error) {
          throw new Error(`its kept audio could not be removed (${errorMessage(error)})`);
        }
        if (viewedSessionRef.current?.id === session.id) setViewedAudio(null);
        const remainingSessions = sessionsRef.current.filter(
          (candidate) => candidate.id !== session.id,
        );
        // A review copy was never in the desktop corpus; its figures stay as they are.
        const analysis = session.reviewCopy
          ? isDesktopApp()
            ? await loadSpeechCorpus(ownSessions(remainingSessions)).catch(() =>
                analyzeLocalCorpus(remainingSessions),
              )
            : analyzeLocalCorpus(remainingSessions)
          : await deleteSpeechCorpusSession(session.id, remainingSessions);
        const next = sessionsRef.current.filter((candidate) => candidate.id !== session.id);
        persistSessions(next);
        if (activeSessionIdRef.current === session.id) {
          startedAtRef.current = null;
          samplesRef.current = [];
          capturedSampleCountRef.current = 0;
          captureDescriptorRef.current = null;
          setSegments([]);
          setPauses([]);
          setReport(emptyReport());
          setReportRun(null);
          sessionLanguageRef.current = null;
          loadedSessionRef.current = null;
          setViewedSession(null);
          setInterimText("");
          setSpeakerMatch(null);
          resetChunkTranscription();
          transcriptProvenanceRef.current = null;
          activeSessionIdRef.current = null;
        }
        return analysis;
      });
      setCorpusAnalysis(corpus);
      setMessage("Session deleted");
    } catch (error) {
      setMessage(`Delete failed: ${errorMessage(error)}`);
    } finally {
      setDeletingSessionId(null);
    }
  }

  /**
   * Replaces every saved session with a validated backup (vox#86 (a)). Runs after every queued
   * save/delete/annotation mutation, writes browser storage first and, on desktop, replaces the
   * native speech corpus too; a failure leaves both stores as they were.
   */
  function restoreSessions(restored: SavedSession[]): Promise<void> {
    // The gate covers the queued wait too: a save accepted before the restore starts would write
    // browser storage that the restore then overwrites.
    // Counted, so a failed restore does not reopen saves while another one is still queued.
    restorePendingRef.current += 1;
    const operation = serializeSessionMutation(() => applyRestore(restored));
    void operation.then(
      () => undefined,
      () => {
        restorePendingRef.current -= 1;
      },
    );
    return operation;
  }

  async function applyRestore(restored: SavedSession[]) {
    // Backups never contain audio, so a restore replaces kept audio with none. Removed first, in
    // one transaction: if it fails, nothing has been replaced.
    try {
      await retainSessionAudio([]);
    } catch (error) {
      throw new Error(`audio kept for review could not be removed: ${errorMessage(error)}`);
    }
    setViewedAudio(null);
    // The native corpus is replaced first, so browser storage (shared with other windows) never
    // holds a restore that could still fail; a native failure therefore changes nothing.
    if (isDesktopApp()) {
      try {
        await invoke("replace_speech_corpus_sessions", { sessions: ownSessions(restored) });
      } catch (error) {
        throw new Error(`the desktop corpus could not be replaced: ${errorMessage(error)}`);
      }
    }
    try {
      replaceStoredSessions(restored);
    } catch (error) {
      // Browser storage refused the write (quota, blocked storage): put the native corpus back to
      // this window's sessions, which it mirrored before the restore.
      if (isDesktopApp()) {
        try {
          await invoke("replace_speech_corpus_sessions", {
            sessions: ownSessions(sessionsRef.current),
          });
        } catch (rollbackError) {
          throw new Error(
            `browser storage refused the restore (${errorMessage(error)}) and the desktop corpus could not be put back (${errorMessage(rollbackError)}); it now holds the backup's sessions, so restore the same backup again once storage has room`,
          );
        }
      }
      throw error;
    }
    // Mutations queued behind the restore must see the restored set.
    sessionsRef.current = restored;
    setSessions(restored);
  }

  return { deletingSessionId, deleteSession, restoreSessions };
}
