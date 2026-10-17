// Acceptance tests for vox#87 (deletion traversal), written before the implementation from the
// issue's "Slice contract under decision (a)". They drive the rendered app only.
import { migrateSessionRecord } from "@stutter-tracker/shared";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { SavedSession, SpeakerProfile, SpeechCorpusAnalysis } from "./types";

const STORE_KEY = "stutter-tracker:sessions";
const SPEAKERS_KEY = "stutter-tracker:speakers";
const CHECKPOINT_PREFIX = "stutter-tracker:capture-checkpoint:";
const LOCK_PREFIX = "stutter-tracker:capture:";

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeReport() {
  return {
    totalDurationSeconds: 1,
    wordCount: 1,
    stutterCount: 0,
    stuttersPerMinute: 0,
    severity: "none" as const,
    speechStats: {
      speakingDurationSeconds: 1,
      pauseDurationSeconds: 0,
      wordsPerMinute: 60,
      articulationRateWpm: 60,
      meanChunkWords: 1,
      meanChunkDurationSeconds: 1,
      eventDensityPer100Words: 0,
      fluencyPercentage: 100,
    },
    blockerStats: {
      blockCount: 0,
      totalBlockSeconds: 0,
      averageBlockSeconds: 0,
      longestBlockSeconds: 0,
      blocksPerMinute: 0,
      blockedTimePercentage: 0,
    },
    chunks: [],
    events: [],
    byKind: {},
  };
}

function makeSession(id: string, text: string, startedAt: string): SavedSession {
  return migrateSessionRecord({
    id,
    startedAt,
    segments: [{ text, startSeconds: 0, endSeconds: 1, confidence: 0.95, isFinal: true }],
    pauses: [],
    report: makeReport(),
  });
}

function makeCheckpoint(id: string, text: string) {
  return {
    version: 1,
    id,
    startedAt: "2026-05-19T10:00:00.000Z",
    updatedAt: "2026-05-19T10:00:05.000Z",
    language: null,
    segments: [{ text, startSeconds: 0, endSeconds: 1, confidence: 0.9, isFinal: true }],
    pauses: [],
    analysis: null,
    recording: null,
  };
}

const SPEAKERS: SpeakerProfile[] = [
  {
    id: "speaker-1",
    label: "Me",
    embeddings: [[0.1, 0.2, 0.3]],
    sampleRate: 16000,
    sampleCount: 16000,
  },
];

function corpusAnalysis(sessions: number): SpeechCorpusAnalysis {
  return {
    stats: {
      sessions,
      documents: sessions,
      speakers: 0,
      totalDurationSeconds: sessions,
      totalTerms: sessions,
      uniqueTerms: sessions,
      averageTermsPerDocument: sessions ? 1 : 0,
      wordCount: sessions,
      stutterCount: 0,
      stuttersPerMinute: 0,
      lexicalDiversity: 0,
      withheldSessions: 0,
    },
    text: { bytes: 0, chars: 0, words: 0, lines: 0, sentences: 0, uniqueTerms: 0 },
    readability: { sentenceCount: 0, wordCount: 0, averageSentenceWords: 0, averageWordChars: 0 },
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

type Handler = (args: Record<string, unknown> | undefined) => Promise<unknown>;

/** Desktop mode: listed commands are handled, every other command is rejected. */
function useDesktop(handlers: Record<string, Handler>) {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(((command: string, args?: Record<string, unknown>) => {
    const handler = handlers[command];
    return handler
      ? handler(args)
      : Promise.reject(new Error(`Tauri invoke unavailable for ${command}`));
  }) as typeof invoke);
}

function invokeCalls(command: string) {
  return vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
}

function corpusCommandsFor(sessionId: string) {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([name, args]) => {
      const payload = args as Record<string, unknown> | undefined;
      if (name === "delete_speech_corpus_session") return payload?.sessionId === sessionId;
      if (name === "save_speech_corpus_session") {
        return (payload?.session as { id?: string } | undefined)?.id === sessionId;
      }
      return false;
    })
    .map(([name]) => name);
}

function storedIds() {
  return (JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedSession[]).map(
    (session) => session.id,
  );
}

function keysMentioning(sessionId: string) {
  return Object.keys(localStorage).filter(
    (key) => key !== STORE_KEY && key !== SPEAKERS_KEY && key.includes(sessionId),
  );
}

function deleteButtonFor(session: SavedSession) {
  return screen.getByRole("button", {
    name: `Delete saved session from ${new Date(session.startedAt).toLocaleString()}`,
  });
}

function queryDeleteButtonFor(session: SavedSession) {
  return screen.queryByRole("button", {
    name: `Delete saved session from ${new Date(session.startedAt).toLocaleString()}`,
  });
}

function reanalyzeButtonFor(session: SavedSession) {
  return screen.getByRole("button", {
    name: `Reanalyze saved session from ${new Date(session.startedAt).toLocaleString()}`,
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Seeds the two-session store plus speaker profiles, renders, and seeds a capture checkpoint for
 * `withCheckpoint` after the startup sweep (which removes checkpoints of saved sessions on its own).
 */
async function renderSeeded(withCheckpoint: SavedSession) {
  const view = renderApp();
  await waitFor(() => expect(screen.getAllByTitle("Delete saved session")).toHaveLength(2));
  await settle();
  await settle();
  localStorage.setItem(
    CHECKPOINT_PREFIX + withCheckpoint.id,
    JSON.stringify(makeCheckpoint(withCheckpoint.id, "alpha deleted words")),
  );
  await settle();
  // The seeded checkpoint is still there, so its later removal is the deletion's doing.
  expect(localStorage.getItem(CHECKPOINT_PREFIX + withCheckpoint.id)).not.toBeNull();
  return view;
}

const ALPHA = makeSession("session-a", "alpha deleted words", "2026-05-19T10:00:00.000Z");
const BETA = makeSession("session-b", "beta kept words", "2026-05-19T11:00:00.000Z");

function seedStore(sessions: SavedSession[] = [ALPHA, BETA]) {
  localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
  localStorage.setItem(SPEAKERS_KEY, JSON.stringify(SPEAKERS));
}

/**
 * The restore prompt (main and vox#99 wording both say "... from this backup?"). The delete prompt
 * must itself mention backups (explanation test), so "backup" alone cannot tell them apart.
 */
const RESTORE_PROMPT = /from this backup/i;

/** window.confirm whose answer depends on the prompt; every prompt is recorded. */
function mockConfirm(answer: (message: string) => boolean) {
  const prompts: string[] = [];
  vi.spyOn(window, "confirm").mockImplementation((message?: string) => {
    prompts.push(String(message ?? ""));
    return answer(String(message ?? ""));
  });
  return prompts;
}

function deletePrompt(prompts: string[]) {
  return prompts.find((prompt) => !RESTORE_PROMPT.test(prompt) && /delete/i.test(prompt));
}

function stubReload() {
  const reload = vi.fn();
  try {
    vi.spyOn(window.location, "reload").mockImplementation(reload);
    return reload;
  } catch {
    // jsdom's Location is unforgeable; replace the whole location object instead.
  }
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, reload },
  });
  restoreLocation = () =>
    Object.defineProperty(window, "location", { configurable: true, value: original });
  return reload;
}
let restoreLocation: (() => void) | null = null;

afterEach(() => {
  restoreLocation?.();
  restoreLocation = null;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(isTauri).mockReset();
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async () => {
    throw new Error("Tauri invoke is unavailable in tests");
  });
});

describe("deleting a saved session (vox#87)", () => {
  describe("traversal", () => {
    it("removes the session from every store, and leaves other sessions and voiceprints alone", async () => {
      useDesktop({
        delete_speech_corpus_session: async () => corpusAnalysis(1),
      });
      seedStore();
      const prompts = mockConfirm(() => true);
      const otherBefore = JSON.stringify(
        (JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedSession[]).find(
          (session) => session.id === BETA.id,
        ),
      );

      const { container } = await renderSeeded(ALPHA);

      // Viewing it first, so the in-memory workspace holds it too.
      await userEvent.click(container.querySelectorAll<HTMLButtonElement>(".session-row")[0]);
      expect((await screen.findAllByText("alpha deleted words")).length).toBeGreaterThan(0);

      await userEvent.click(deleteButtonFor(ALPHA));
      expect(deletePrompt(prompts)).toBeDefined();

      await waitFor(() => expect(storedIds()).toEqual([BETA.id]));
      // The other session is byte-for-byte unchanged.
      expect(
        JSON.stringify(
          (JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedSession[]).find(
            (session) => session.id === BETA.id,
          ),
        ),
      ).toBe(otherBefore);
      // Capture checkpoint, capture lock and any other derived browser key are gone.
      expect(localStorage.getItem(CHECKPOINT_PREFIX + ALPHA.id)).toBeNull();
      expect(localStorage.getItem(LOCK_PREFIX + ALPHA.id)).toBeNull();
      expect(keysMentioning(ALPHA.id)).toEqual([]);
      expect(localStorage.getItem(CHECKPOINT_PREFIX + BETA.id)).toBeNull();
      // Desktop corpus copy.
      expect(invokeCalls("delete_speech_corpus_session")).toEqual([
        ["delete_speech_corpus_session", { sessionId: ALPHA.id }],
      ]);
      // Voiceprints are not part of recording deletion.
      expect(JSON.parse(localStorage.getItem(SPEAKERS_KEY) ?? "null")).toEqual(SPEAKERS);
      expect(invokeCalls("save_speaker_profiles")).toEqual([]);
      expect(invokeCalls("delete_speaker_profile")).toEqual([]);
      // No longer listed, no longer on screen, and not offered back as an interrupted recording.
      await waitFor(() => expect(queryDeleteButtonFor(ALPHA)).not.toBeInTheDocument());
      expect(deleteButtonFor(BETA)).toBeInTheDocument();
      expect(screen.queryByText("alpha deleted words")).not.toBeInTheDocument();
      expect(screen.queryByText(/interrupted recording/i)).not.toBeInTheDocument();
    });

    it("deletes nothing when the confirmation is cancelled", async () => {
      useDesktop({
        delete_speech_corpus_session: async () => corpusAnalysis(1),
      });
      seedStore();
      const storeBefore = localStorage.getItem(STORE_KEY);
      const prompts = mockConfirm(() => false);

      await renderSeeded(ALPHA);
      const checkpointBefore = localStorage.getItem(CHECKPOINT_PREFIX + ALPHA.id);

      await userEvent.click(deleteButtonFor(ALPHA));
      expect(deletePrompt(prompts)).toBeDefined();
      await settle();

      expect(localStorage.getItem(STORE_KEY)).toBe(storeBefore);
      expect(localStorage.getItem(CHECKPOINT_PREFIX + ALPHA.id)).toBe(checkpointBefore);
      expect(JSON.parse(localStorage.getItem(SPEAKERS_KEY) ?? "null")).toEqual(SPEAKERS);
      expect(invokeCalls("delete_speech_corpus_session")).toEqual([]);
      expect(deleteButtonFor(ALPHA)).toBeInTheDocument();
      expect(deleteButtonFor(BETA)).toBeInTheDocument();
    });
  });

  describe("races", () => {
    it("(a) a corpus save of the same session still pending does not resurrect it after deletion", async () => {
      const pendingSave = deferred<SpeechCorpusAnalysis>();
      const handlers: Record<string, Handler> = {
        analyze_speech_session: async () => ({ ...makeReport(), analyzerVersion: "test" }),
        save_speech_corpus_session: () => pendingSave.promise,
        delete_speech_corpus_session: async () => corpusAnalysis(1),
      };
      useDesktop(handlers);
      seedStore();
      mockConfirm(() => true);

      renderApp();
      await waitFor(() => expect(screen.getAllByTitle("Delete saved session")).toHaveLength(2));

      // Reanalysis writes the session and then holds its desktop corpus save open.
      await userEvent.click(reanalyzeButtonFor(ALPHA));
      await waitFor(() => expect(invokeCalls("save_speech_corpus_session")).toHaveLength(1));

      await userEvent.click(deleteButtonFor(ALPHA));
      await settle();

      pendingSave.resolve(corpusAnalysis(2));

      await waitFor(() => expect(storedIds()).toEqual([BETA.id]));
      await waitFor(() => expect(queryDeleteButtonFor(ALPHA)).not.toBeInTheDocument());
      await settle();
      await settle();
      // Still deleted after everything settled, and the corpus's last word on it is a deletion.
      expect(storedIds()).toEqual([BETA.id]);
      expect(queryDeleteButtonFor(ALPHA)).not.toBeInTheDocument();
      expect(corpusCommandsFor(ALPHA.id).at(-1)).toBe("delete_speech_corpus_session");
      expect(keysMentioning(ALPHA.id)).toEqual([]);
    });

    it("(b) a reanalysis queued while the session is deleted does not write it back", async () => {
      const pendingAnalysis = deferred<unknown>();
      useDesktop({
        analyze_speech_session: () => pendingAnalysis.promise,
        save_speech_corpus_session: async () => corpusAnalysis(2),
        delete_speech_corpus_session: async () => corpusAnalysis(1),
      });
      seedStore();
      mockConfirm(() => true);

      renderApp();
      await waitFor(() => expect(screen.getAllByTitle("Delete saved session")).toHaveLength(2));

      await settle();
      const analysesBefore = invokeCalls("analyze_speech_session").length;
      await userEvent.click(reanalyzeButtonFor(ALPHA));
      await waitFor(() =>
        expect(invokeCalls("analyze_speech_session")).toHaveLength(analysesBefore + 1),
      );

      await userEvent.click(deleteButtonFor(ALPHA));
      await waitFor(() => expect(storedIds()).toEqual([BETA.id]));

      pendingAnalysis.resolve({ ...makeReport(), analyzerVersion: "test" });
      await settle();
      await settle();

      expect(storedIds()).toEqual([BETA.id]);
      expect(queryDeleteButtonFor(ALPHA)).not.toBeInTheDocument();
      expect(corpusCommandsFor(ALPHA.id)).toEqual(["delete_speech_corpus_session"]);
      expect(keysMentioning(ALPHA.id)).toEqual([]);
    });

    // (b) is covered through the queued reanalysis above; annotation saves use the same queue.

    it.each([
      { accept: false, expected: [BETA.id] },
      { accept: true, expected: [ALPHA.id, BETA.id] },
    ])(
      "(c) restoring a backup with the deleted session brings it back only when the backup confirmation is accepted ($accept)",
      async ({ accept, expected }) => {
        seedStore();
        const reload = stubReload();
        const prompts = mockConfirm((message) => (RESTORE_PROMPT.test(message) ? accept : true));

        renderApp();
        await waitFor(() => expect(screen.getAllByTitle("Delete saved session")).toHaveLength(2));

        await userEvent.click(deleteButtonFor(ALPHA));
        await waitFor(() => expect(storedIds()).toEqual([BETA.id]));

        const backup = new File(
          [
            JSON.stringify({
              version: 2,
              exportedAt: "2026-05-20T00:00:00.000Z",
              sessions: [ALPHA, BETA],
            }),
          ],
          "backup.json",
          { type: "application/json" },
        );
        await userEvent.upload(screen.getByLabelText("Choose session backup"), backup);

        await waitFor(() =>
          expect(prompts.some((prompt) => RESTORE_PROMPT.test(prompt))).toBe(true),
        );
        await settle();

        if (accept) {
          await waitFor(() => expect([...storedIds()].sort()).toEqual(expected));
          expect(reload).toHaveBeenCalled();
        } else {
          expect(storedIds()).toEqual(expected);
          expect(reload).not.toHaveBeenCalled();
          expect(queryDeleteButtonFor(ALPHA)).not.toBeInTheDocument();
        }
      },
    );
  });

  describe("explanation", () => {
    it("says what deletion removes and what it leaves, without promising forensic erasure", async () => {
      useDesktop({
        delete_speech_corpus_session: async () => corpusAnalysis(1),
      });
      seedStore();
      const prompts = mockConfirm(() => false);

      renderApp();
      await waitFor(() => expect(screen.getAllByTitle("Delete saved session")).toHaveLength(2));
      await userEvent.click(deleteButtonFor(ALPHA));

      const text = deletePrompt(prompts);
      expect(text).toBeDefined();
      // What is removed.
      expect(text).toMatch(/transcript/i);
      expect(text).toMatch(/annotation/i);
      expect(text).toMatch(/analys[ie]s/i);
      // On desktop, its corpus copy.
      expect(text).toMatch(/corpus/i);
      // Its limits: exported or shared copies and backups are not changed.
      expect(text).toMatch(/export|shared/i);
      expect(text).toMatch(/backup/i);
      // Voiceprints are kept and have their own removal.
      expect(text).toMatch(/voiceprint/i);
      expect(text).toMatch(/kept|keep|stay|remain|not (be )?(removed|deleted|changed)/i);
      // No promise beyond "This cannot be undone".
      expect(text).not.toMatch(
        /permanent|forensic|secure(ly)? (eras|delet|wip)|irrecoverab|unrecoverab|wipe|shred|every trace|all traces|completely eras/i,
      );
    });
  });
});
