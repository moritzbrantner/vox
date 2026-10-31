import {
  type AnnotationExchange,
  type AnnotationRater,
  adjudicationRevision,
  annotateSession,
  audioFingerprint,
  currentRevisionBy,
  declareValidation,
  decodeSamples,
  mergeAnnotationExchange,
  parseAnnotationExchange,
  reviewCopyFromExchange,
  tagSessionContext,
} from "@stutter-tracker/shared";
import { type AnnotationSaveRequest } from "../../components/AnnotationWorkbench";
import { type ContextTags } from "../../components/SessionComparisonPanel";
import { type AdjudicationRequest } from "../../components/ValidationPanel";
import {
  type KeptSessionAudio,
  getSessionAudio,
  putSessionAudio,
} from "../../storage/sessionAudio";
import { type SavedSession } from "../../types";
import { emptyReport } from "../analysis";
import { isDesktopApp } from "../config";
import { errorMessage } from "../errors";
import { analyzeLocalCorpus, saveSpeechCorpusSession } from "../speechCorpus";
import type { useWorkspace } from "./useWorkspace";
import type { useSessionLibrary } from "./useSessionLibrary";

type SessionUpdatesDeps = Pick<
  ReturnType<typeof useWorkspace>,
  "setMessage" | "loadedSessionRef" | "setViewedAudio" | "viewedSessionRef" | "setViewedSession"
> &
  Pick<
    ReturnType<typeof useSessionLibrary>,
    | "setCorpusAnalysis"
    | "sessionsRef"
    | "restorePendingRef"
    | "persistSessions"
    | "serializeSessionMutation"
  >;

/** Changes to one stored session: annotations, adjudication, imports, context and validation. */
export function useSessionUpdates({
  setMessage,
  loadedSessionRef,
  setViewedAudio,
  viewedSessionRef,
  setViewedSession,
  setCorpusAnalysis,
  sessionsRef,
  restorePendingRef,
  persistSessions,
  serializeSessionMutation,
}: SessionUpdatesDeps) {
  // Applies one change to the latest stored copy of a session through the mutation queue. Returns
  // false when nothing was saved, so the caller keeps what the user entered.
  async function updateStoredSession(
    sessionId: string,
    update: (latest: SavedSession) => SavedSession,
    what: string,
  ) {
    if (restorePendingRef.current > 0) {
      setMessage(`Wait for the session restore to finish before saving the ${what}`);
      return false;
    }
    const outcome = await serializeSessionMutation(async () => {
      const latest = sessionsRef.current.find((candidate) => candidate.id === sessionId);
      if (!latest) {
        return "deleted" as const;
      }
      let updated: SavedSession;
      try {
        updated = update(latest);
      } catch (error) {
        return { rejected: errorMessage(error) };
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
      if (viewedSessionRef.current?.id === updated.id) {
        loadedSessionRef.current = updated;
        setViewedSession(updated);
      }
      if (updated.reviewCopy) {
        return "saved" as const;
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(updated));
        return "saved" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    });
    const capitalized = what[0].toUpperCase() + what.slice(1);
    setMessage(
      typeof outcome === "object"
        ? `${capitalized} not saved: ${outcome.rejected}`
        : outcome === "saved"
          ? `${capitalized} saved to the session`
          : outcome === "local"
            ? isDesktopApp()
              ? `${capitalized} saved locally; the desktop corpus still has the earlier version`
              : `${capitalized} saved to the session`
            : outcome === "deleted"
              ? `Session was deleted; ${what} not saved`
              : `Could not save the ${what}: browser storage is full or unavailable`,
    );
    return outcome === "saved" || outcome === "local";
  }

  // Appends the rater's revision, replacing only that rater's previous revision.
  function saveAnnotation(sessionId: string, request: AnnotationSaveRequest) {
    return updateStoredSession(
      sessionId,
      (latest) =>
        annotateSession(latest, {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          author: request.author,
          // Outside blind review the analysis is on screen next to the workbench; a review copy
          // has no analysis to show.
          basedOnRunId: request.blind || latest.reviewCopy ? null : latest.analysis.id,
          events: request.events,
          status: request.status,
          supersedes: currentRevisionBy(latest, request.author)?.id ?? null,
        }),
      "annotation",
    );
  }

  // Records the adjudicator's per-item decisions for the session's current ratings; both rater
  // revisions stay unchanged.
  function saveAdjudication(sessionId: string, request: AdjudicationRequest) {
    return updateStoredSession(
      sessionId,
      (latest) =>
        annotateSession(
          latest,
          adjudicationRevision(latest, {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            ...request,
          }),
        ),
      "adjudication",
    );
  }

  // Adds a rater's annotation file: merged into the session it describes, or kept as a review
  // copy when this device does not have that session. Nothing local is changed or removed.
  async function importAnnotationFile(file: File) {
    if (restorePendingRef.current > 0) {
      setMessage("Wait for the session restore to finish before importing annotations");
      return;
    }
    let exchange: AnnotationExchange;
    let audio: KeptSessionAudio | null = null;
    try {
      exchange = parseAnnotationExchange(JSON.parse(await file.text()));
      if (exchange.audio) {
        const samples = decodeSamples(exchange.audio.samples);
        if (audioFingerprint(samples, exchange.audio.sampleRate) !== exchange.audio.audioId) {
          throw new Error("the file's audio does not match its fingerprint");
        }
        const { samples: _encoded, ...placement } = exchange.audio;
        audio = {
          ...placement,
          samples,
          sessionId: exchange.session.id,
          keptAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      setMessage(`Import failed: ${errorMessage(error)}`);
      return;
    }
    const outcome = await serializeSessionMutation(async () => {
      const existing = sessionsRef.current.find((session) => session.id === exchange.session.id);
      let result: ReturnType<typeof mergeAnnotationExchange>;
      try {
        result = mergeAnnotationExchange(
          existing ??
            reviewCopyFromExchange(exchange, {
              importedAt: new Date(),
              emptyReport: emptyReport(),
            }),
          exchange,
        );
      } catch (error) {
        return { failed: errorMessage(error) };
      }
      try {
        persistSessions(
          existing
            ? sessionsRef.current.map((session) =>
                session.id === result.record.id ? result.record : session,
              )
            : [result.record, ...sessionsRef.current],
        );
      } catch {
        return { failed: "browser storage is full or unavailable" };
      }
      if (viewedSessionRef.current?.id === result.record.id) {
        loadedSessionRef.current = result.record;
        setViewedSession(result.record);
      }
      let audioNote = "";
      if (audio) {
        try {
          const kept = await getSessionAudio(result.record.id);
          if (!kept) {
            await putSessionAudio(audio);
            if (viewedSessionRef.current?.id === result.record.id) setViewedAudio(audio);
            audioNote = "; its audio is kept on this device for review";
          } else if (kept.audioId !== audio.audioId) {
            audioNote = "; its audio differs from the audio kept here, which was left unchanged";
          }
        } catch (error) {
          audioNote = `; its audio could not be kept (${errorMessage(error)})`;
        }
      }
      if (existing && !existing.reviewCopy) {
        try {
          setCorpusAnalysis(await saveSpeechCorpusSession(result.record));
        } catch {
          setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        }
      }
      return { ...result, created: !existing, audioNote };
    });
    setMessage(
      "failed" in outcome
        ? `Import failed: ${outcome.failed}`
        : `${outcome.created ? "Added a review copy with" : "Imported"} ${outcome.added} new annotation revision${outcome.added === 1 ? "" : "s"}${outcome.alreadyPresent ? ` (${outcome.alreadyPresent} already here)` : ""}${outcome.audioNote}`,
    );
  }

  function tagContext(sessionId: string, tags: ContextTags) {
    return updateStoredSession(
      sessionId,
      (latest) => {
        const previous = latest.context.condition;
        // Re-tagging the same aid keeps the settings recorded with it.
        const condition =
          tags.condition?.kind === "assisted" &&
          previous?.kind === "assisted" &&
          previous.aidId === tags.condition.aidId
            ? previous
            : tags.condition;
        return tagSessionContext(latest, { ...tags, condition });
      },
      "session context",
    );
  }

  function declareSessionValidation(sessionId: string, raters: [AnnotationRater, AnnotationRater]) {
    return updateStoredSession(
      sessionId,
      (latest) => declareValidation(latest, { declaredAt: new Date().toISOString(), raters }),
      "validation declaration",
    );
  }

  return {
    updateStoredSession,
    saveAnnotation,
    saveAdjudication,
    importAnnotationFile,
    tagContext,
    declareSessionValidation,
  };
}
