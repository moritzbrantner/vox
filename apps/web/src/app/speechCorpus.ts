// The speech corpus: desktop commands and the local analysis of saved sessions.
import { observationFingerprint } from "@stutter-tracker/shared";
import { invoke } from "@tauri-apps/api/core";
import { isScoreWithheld } from "../audio/captureQuality";
import {
  type PauseSpan,
  type SavedSession,
  type SpeechCorpusAnalysis,
  type TranscriptSegment,
} from "../types";
import { isDesktopApp } from "./config";

/**
 * Loads the desktop corpus. Rows saved before the corpus kept capture quality get the verdict of
 * the matching saved session first, so a known-unknown capture does not count as unchecked.
 */
export async function loadSpeechCorpus(sessions: SavedSession[]): Promise<SpeechCorpusAnalysis> {
  if (!isDesktopApp()) {
    throw new Error("desktop corpus is only available in the Tauri app");
  }
  const qualities = Object.fromEntries(
    sessions.flatMap((session) =>
      session.report.captureQuality ? [[session.id, session.report.captureQuality]] : [],
    ),
  );
  // The backend ships with this app, so the command exists. When it fails, the caller falls back to
  // the gated analysis of the saved sessions, never to ungated legacy rows.
  return Object.keys(qualities).length
    ? invoke<SpeechCorpusAnalysis>("backfill_speech_corpus_capture_quality", { qualities })
    : invoke<SpeechCorpusAnalysis>("load_speech_corpus");
}

/**
 * Counts desktop-corpus sessions whose analysis is not verified for their transcript: those
 * without stored provenance, and those whose `analysis.inputId` does not match the untouched
 * observation (`observedSegments` and `pauses`) the corpus keeps.
 */
export function countUnverifiedCorpusSessions(exported: unknown): number {
  const sessions =
    exported &&
    typeof exported === "object" &&
    Array.isArray((exported as { sessions?: unknown }).sessions)
      ? ((exported as { sessions: unknown[] }).sessions as Record<string, unknown>[])
      : [];
  return sessions.filter((session) => {
    const analysis = session.analysis as { inputId?: unknown } | undefined;
    if (!analysis || !Array.isArray(session.observedSegments) || !Array.isArray(session.pauses)) {
      return true;
    }
    return (
      analysis.inputId !==
      observationFingerprint(
        session.observedSegments as TranscriptSegment[],
        session.pauses as PauseSpan[],
      )
    );
  }).length;
}

export async function loadSpeechCorpusExport(sessions: SavedSession[]) {
  if (!isDesktopApp()) {
    return localSpeechCorpusExport(sessions);
  }
  try {
    return await invoke<unknown>("export_speech_corpus");
  } catch {
    return localSpeechCorpusExport(sessions);
  }
}

/** Sessions of this user's own speech: every saved session except review copies. */
export function ownSessions(sessions: SavedSession[]) {
  return sessions.filter((session) => !session.reviewCopy);
}

export async function saveSpeechCorpusSession(
  session: SavedSession,
): Promise<SpeechCorpusAnalysis> {
  if (session.reviewCopy) {
    throw new Error("review copies are not part of the speech corpus");
  }
  if (!isDesktopApp()) {
    throw new Error("desktop corpus is only available in the Tauri app");
  }
  return invoke<SpeechCorpusAnalysis>("save_speech_corpus_session", { session });
}

export async function deleteSpeechCorpusSession(
  sessionId: string,
  remainingSessions: SavedSession[],
): Promise<SpeechCorpusAnalysis> {
  if (!isDesktopApp()) {
    return analyzeLocalCorpus(remainingSessions);
  }
  return invoke<SpeechCorpusAnalysis>("delete_speech_corpus_session", { sessionId });
}

export function emptyCorpusAnalysis(): SpeechCorpusAnalysis {
  return {
    stats: {
      sessions: 0,
      documents: 0,
      speakers: 0,
      totalDurationSeconds: 0,
      totalTerms: 0,
      uniqueTerms: 0,
      averageTermsPerDocument: 0,
      wordCount: 0,
      stutterCount: 0,
      stuttersPerMinute: 0,
      lexicalDiversity: 0,
      withheldSessions: 0,
    },
    text: {
      bytes: 0,
      chars: 0,
      words: 0,
      lines: 0,
      sentences: 0,
      uniqueTerms: 0,
    },
    readability: {
      sentenceCount: 0,
      wordCount: 0,
      averageSentenceWords: 0,
      averageWordChars: 0,
    },
    sentiment: {
      positiveScore: 0,
      negativeScore: 0,
      compound: 0,
      tokenCount: 0,
      matchedTerms: 0,
      label: "neutral",
    },
    linguistic: {
      tokenCount: 0,
      sentenceCount: 0,
      lemmaCount: 0,
      entityCount: 0,
      entities: [],
      topics: [],
      register: "Neutral",
      disfluencyMarkers: 0,
      questionCount: 0,
      exclamationCount: 0,
    },
    topTerms: [],
    keywords: [],
    summary: [],
    speakers: [],
  };
}

function localSpeechCorpusExport(sessions: SavedSession[]) {
  return {
    sessions: ownSessions(sessions).map((session) => ({
      id: session.id,
      startedAt: session.startedAt,
      segments: session.segments.filter((segment) => segment.isFinal && segment.text.trim()),
      totalDurationSeconds: session.report.totalDurationSeconds,
      wordCount: session.report.wordCount,
      stutterCount: session.report.stutterCount,
      stuttersPerMinute: session.report.stuttersPerMinute,
      // Exact counts of an unknown-quality capture stay qualified by their verdict.
      ...(session.report.captureQuality ? { captureQuality: session.report.captureQuality } : {}),
    })),
  };
}

export function analyzeLocalCorpus(allSessions: SavedSession[]): SpeechCorpusAnalysis {
  // Review copies hold someone else's speech; they are not part of this user's corpus.
  const sessions = ownSessions(allSessions);
  const corpus = emptyCorpusAnalysis();
  const terms = new Map<string, { count: number; documents: Set<string> }>();
  const speakerTerms = new Map<string, Map<string, number>>();
  const speakerSummaries = new Map<
    string,
    { label: string; documents: number; words: number; duration: number; stutters: number }
  >();
  let documents = 0;
  let duration = 0;
  let scoredDuration = 0;
  let stutters = 0;
  let withheldSessions = 0;

  for (const session of sessions) {
    // A capture that failed the quality gate has no score; its counts stay out of the totals.
    const withheld = isScoreWithheld(session.report);
    const sessionStutters = withheld ? 0 : session.report.stutterCount;
    duration += session.report.totalDurationSeconds;
    if (withheld) {
      withheldSessions += 1;
    } else {
      scoredDuration += session.report.totalDurationSeconds;
    }
    stutters += sessionStutters;
    for (const [index, segment] of session.segments.entries()) {
      if (!segment.isFinal || !segment.text.trim()) {
        continue;
      }
      documents += 1;
      const documentId = `${session.id}:${index}`;
      const speakerKey = segment.speakerId ?? segment.speakerLabel ?? "Unknown speaker";
      const speakerLabel = segment.speakerLabel ?? segment.speakerId ?? "Unknown speaker";
      const words = corpusTerms(segment.text);
      const segmentStutters =
        session.report.wordCount > 0
          ? Math.round((sessionStutters * words.length) / session.report.wordCount)
          : 0;
      const speaker = speakerSummaries.get(speakerKey) ?? {
        label: speakerLabel,
        documents: 0,
        words: 0,
        duration: 0,
        stutters: 0,
      };
      speaker.documents += 1;
      speaker.words += words.length;
      speaker.duration += Math.max(0, segment.endSeconds - segment.startSeconds);
      speaker.stutters += segmentStutters;
      speakerSummaries.set(speakerKey, speaker);
      const perSpeaker = speakerTerms.get(speakerKey) ?? new Map<string, number>();
      speakerTerms.set(speakerKey, perSpeaker);
      for (const word of words) {
        const entry = terms.get(word) ?? { count: 0, documents: new Set<string>() };
        entry.count += 1;
        entry.documents.add(documentId);
        terms.set(word, entry);
        perSpeaker.set(word, (perSpeaker.get(word) ?? 0) + 1);
      }
    }
  }

  const totalTerms = [...terms.values()].reduce((sum, term) => sum + term.count, 0);
  corpus.stats = {
    sessions: sessions.length,
    documents,
    speakers: speakerSummaries.size,
    totalDurationSeconds: duration,
    totalTerms,
    uniqueTerms: terms.size,
    averageTermsPerDocument: documents ? totalTerms / documents : 0,
    wordCount: sessions.reduce((sum, session) => sum + session.report.wordCount, 0),
    stutterCount: stutters,
    stuttersPerMinute: stutters / Math.max(1 / 60, scoredDuration / 60),
    lexicalDiversity: totalTerms ? terms.size / totalTerms : 0,
    withheldSessions,
  };
  corpus.text.words = totalTerms;
  corpus.text.uniqueTerms = terms.size;
  corpus.topTerms = termEntries(terms, documents);
  corpus.keywords = corpus.topTerms.slice(0, 10).map((term) => ({
    text: term.term,
    score: term.collectionFrequency,
    count: term.collectionCount,
  }));
  corpus.speakers = [...speakerSummaries.entries()]
    .map(([key, speaker]) => ({
      speakerId: key === "Unknown speaker" ? null : key,
      speakerLabel: speaker.label,
      documents: speaker.documents,
      wordCount: speaker.words,
      durationSeconds: speaker.duration,
      stutterCount: speaker.stutters,
      lexicalDiversity: speaker.words ? (speakerTerms.get(key)?.size ?? 0) / speaker.words : 0,
      topTerms: termEntries(speakerTerms.get(key) ?? new Map<string, number>(), speaker.documents),
      keywords: termEntries(speakerTerms.get(key) ?? new Map<string, number>(), speaker.documents)
        .slice(0, 8)
        .map((term) => ({
          text: term.term,
          score: term.collectionFrequency,
          count: term.collectionCount,
        })),
    }))
    .sort((left, right) => right.wordCount - left.wordCount);
  return corpus;
}

function corpusTerms(text: string) {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9]+(?:'[a-z0-9]+)?/g)
      ?.filter((term) => term.length > 1) ?? []
  );
}

function termEntries(
  terms: Map<string, { count: number; documents: Set<string> } | number>,
  documentCount: number,
) {
  const total = [...terms.values()].reduce<number>(
    (sum, value) => sum + (typeof value === "number" ? value : value.count),
    0,
  );
  return [...terms.entries()]
    .map(([term, value]) => {
      const count = typeof value === "number" ? value : value.count;
      return {
        term,
        collectionCount: count,
        documentCount: typeof value === "number" ? documentCount : value.documents.size,
        collectionFrequency: total ? count / total : 0,
      };
    })
    .sort((left, right) => right.collectionCount - left.collectionCount)
    .slice(0, 12);
}
