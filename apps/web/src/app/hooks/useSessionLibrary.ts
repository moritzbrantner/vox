import { isAnalysisVerified } from "@stutter-tracker/shared";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { isScoreWithheld } from "../../audio/captureQuality";
import { loadSessionsFromStorage } from "../../storage/localStorage";
import { retainSessionAudio } from "../../storage/sessionAudio";
import { createSessionMutationQueue } from "../../storage/sessionMutations";
import { type SavedSession, type SpeechCorpusAnalysis } from "../../types";
import { STORE_KEY } from "../config";
import {
  analyzeLocalCorpus,
  countUnverifiedCorpusSessions,
  emptyCorpusAnalysis,
  loadSpeechCorpus,
  ownSessions,
} from "../speechCorpus";
import type { useWorkspace } from "./useWorkspace";

type SessionLibraryDeps = Pick<ReturnType<typeof useWorkspace>, "isNative">;

/** Saved sessions, the mutation queue they change through, and the corpus figures derived from them. */
export function useSessionLibrary({ isNative }: SessionLibraryDeps) {
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSessions());

  const [corpusAnalysis, setCorpusAnalysis] = useState<SpeechCorpusAnalysis>(() =>
    emptyCorpusAnalysis(),
  );

  const sessionsRef = useRef(sessions);

  // Saves, deletes and restores run one at a time across every window of the app.
  const [sessionMutationQueue] = useState(() => createSessionMutationQueue());
  // True while a restore is running; saves wait for it (their browser write would race the restore).
  const restorePendingRef = useRef(0);

  // Kept audio whose session is gone (deleted, dropped past the session limit, or an earlier
  // removal failed) is removed on start.
  useEffect(() => {
    void serializeSessionMutation(() =>
      retainSessionAudio(sessionsRef.current.map((session) => session.id)),
    ).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isNative) {
      return;
    }
    let cancelled = false;
    loadSpeechCorpus(sessionsRef.current)
      .then((analysis) => {
        if (!cancelled) {
          setCorpusAnalysis(analysis);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCorpusAnalysis(analyzeLocalCorpus(sessions));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isNative]);

  useEffect(() => {
    if (!isNative) {
      setCorpusAnalysis(analyzeLocalCorpus(sessions));
    }
  }, [isNative, sessions]);

  // Sessions whose saved analysis is not verified for their transcript, flagged next to the corpus
  // (local or desktop) instead of being counted silently.
  const localUnverifiedCount = useMemo(
    () => sessions.filter((session) => !isAnalysisVerified(session)).length,
    [sessions],
  );
  // The desktop corpus keeps sessions the browser history has pruned, so in the desktop app the
  // warning is counted over the corpus actually shown.
  const [desktopUnverifiedCount, setDesktopUnverifiedCount] = useState<number | null>(null);
  useEffect(() => {
    if (!isNative) {
      setDesktopUnverifiedCount(null);
      return;
    }
    let cancelled = false;
    // A small payload (inputId and observation per session), not the full store.
    void invoke<unknown>("speech_corpus_observations")
      .then((exported) => {
        if (!cancelled) {
          setDesktopUnverifiedCount(countUnverifiedCorpusSessions(exported));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopUnverifiedCount(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isNative, corpusAnalysis]);
  const unverifiedSessionCount = desktopUnverifiedCount ?? localUnverifiedCount;

  const todayStats = useMemo(() => {
    const now = new Date().toDateString();
    const todays = ownSessions(sessions).filter(
      (session) => new Date(session.startedAt).toDateString() === now,
    );
    // Sessions whose capture failed the quality gate have no event count to add.
    const totalEvents = todays.reduce(
      (sum, session) => sum + (isScoreWithheld(session.report) ? 0 : session.report.stutterCount),
      0,
    );
    const totalMinutes = todays.reduce(
      (sum, session) => sum + session.report.totalDurationSeconds / 60,
      0,
    );
    const unverified = todays.filter((session) => !isAnalysisVerified(session)).length;
    return { count: todays.length, totalEvents, totalMinutes, unverified };
  }, [sessions]);

  // Writes storage first, so a failed write (quota, blocked storage) leaves memory unchanged.
  function persistSessions(next: SavedSession[]) {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    sessionsRef.current = next;
    setSessions(next);
  }

  // Each mutation starts from the stored list: another window may have changed it before its
  // storage event arrived here.
  function serializeSessionMutation<T>(mutation: () => Promise<T>): Promise<T> {
    return sessionMutationQueue(() => {
      try {
        const stored = loadSessionsFromStorage();
        sessionsRef.current = stored;
        setSessions(stored);
      } catch {
        // Unreadable now; keep this window's list rather than dropping it.
      }
      return mutation();
    });
  }

  return {
    sessions,
    setSessions,
    corpusAnalysis,
    setCorpusAnalysis,
    sessionsRef,
    restorePendingRef,
    unverifiedSessionCount,
    todayStats,
    persistSessions,
    serializeSessionMutation,
  };
}

function loadSessions(): SavedSession[] {
  try {
    return loadSessionsFromStorage();
  } catch {
    return [];
  }
}
