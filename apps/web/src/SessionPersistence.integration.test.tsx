import { migrateSessionRecord } from "@stutter-tracker/shared";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { initializeAppStorage, resetAppStorage } from "./storage/protectedStorage";
import type { SavedSession, SpeechCorpusAnalysis } from "./types";

const STORE_KEY = "stutter-tracker:sessions";

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

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

function makeSession(id: string, text: string, startedAt: string): SavedSession {
  return migrateSessionRecord({
    id,
    startedAt,
    segments: [
      {
        text,
        startSeconds: 0,
        endSeconds: 1,
        confidence: 0.95,
        isFinal: true,
      },
    ],
    pauses: [],
    report: {
      totalDurationSeconds: 1,
      wordCount: 1,
      stutterCount: 0,
      stuttersPerMinute: 0,
      severity: "none",
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
    },
  });
}

function emptyCorpusAnalysis(): SpeechCorpusAnalysis {
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

function useDesktopInvokeMock(
  deleteResults: Array<ReturnType<typeof deferred<SpeechCorpusAnalysis>>>,
) {
  vi.mocked(isTauri).mockReturnValue(true);
  let deleteIndex = 0;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "delete_speech_corpus_session") {
      const result = deleteResults[deleteIndex++];
      if (!result) {
        return Promise.reject(new Error("unexpected delete invocation"));
      }
      return result.promise as Promise<never>;
    }
    return Promise.reject(new Error(`Tauri invoke unavailable for ${command}`));
  });
}

function deleteInvocationCount() {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "delete_speech_corpus_session").length;
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(isTauri).mockReset();
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async () => {
    throw new Error("Tauri invoke is unavailable in tests");
  });
});

describe("desktop saved-session persistence", () => {
  it("serializes corpus deletions and commits each result against the latest session snapshot", async () => {
    const firstDelete = deferred<SpeechCorpusAnalysis>();
    const secondDelete = deferred<SpeechCorpusAnalysis>();
    useDesktopInvokeMock([firstDelete, secondDelete]);

    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        makeSession("session-a", "alpha", "2026-05-19T10:00:00.000Z"),
        makeSession("session-b", "beta", "2026-05-19T11:00:00.000Z"),
      ]),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();

    const deleteButtons = await screen.findAllByTitle("Delete saved session");
    await userEvent.click(deleteButtons[0]);
    await userEvent.click(deleteButtons[1]);

    await waitFor(() => expect(deleteInvocationCount()).toBe(1));

    firstDelete.resolve(emptyCorpusAnalysis());
    await waitFor(() => expect(deleteInvocationCount()).toBe(2));

    secondDelete.resolve(emptyCorpusAnalysis());
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null")).toEqual([]);
    });
  });

  it("does not clear a newer active workspace when an earlier deletion finishes", async () => {
    const deletion = deferred<SpeechCorpusAnalysis>();
    useDesktopInvokeMock([deletion]);

    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        makeSession("session-a", "alpha active", "2026-05-19T10:00:00.000Z"),
        makeSession("session-b", "beta stays", "2026-05-19T11:00:00.000Z"),
      ]),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const { container } = renderApp();
    const sessionRows = await waitFor(() => {
      const rows = container.querySelectorAll<HTMLButtonElement>(".session-row");
      expect(rows).toHaveLength(2);
      return rows;
    });

    await userEvent.click(sessionRows[0]);
    expect(await screen.findAllByText("alpha active")).not.toHaveLength(0);

    await userEvent.click((await screen.findAllByTitle("Delete saved session"))[0]);
    await userEvent.click(container.querySelectorAll<HTMLButtonElement>(".session-row")[1]);
    expect(await screen.findAllByText("beta stays")).not.toHaveLength(0);

    deletion.resolve(emptyCorpusAnalysis());

    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as SavedSession[];
      expect(persisted.map((session) => session.id)).toEqual(["session-b"]);
    });
    expect(screen.queryByText("Transcript will appear here.")).not.toBeInTheDocument();
    expect(screen.getAllByText("beta stays").length).toBeGreaterThan(0);
  });

  it("clears a session selected after its desktop deletion has started", async () => {
    const deletion = deferred<SpeechCorpusAnalysis>();
    useDesktopInvokeMock([deletion]);

    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        makeSession("session-a", "alpha deleted", "2026-05-19T10:00:00.000Z"),
        makeSession("session-b", "beta initial", "2026-05-19T11:00:00.000Z"),
      ]),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const { container } = renderApp();
    const sessionRows = await waitFor(() => {
      const rows = container.querySelectorAll<HTMLButtonElement>(".session-row");
      expect(rows).toHaveLength(2);
      return rows;
    });

    await userEvent.click(sessionRows[1]);
    expect(await screen.findAllByText("beta initial")).not.toHaveLength(0);

    await userEvent.click((await screen.findAllByTitle("Delete saved session"))[0]);
    await waitFor(() => expect(deleteInvocationCount()).toBe(1));

    await userEvent.click(container.querySelectorAll<HTMLButtonElement>(".session-row")[0]);
    expect(await screen.findAllByText("alpha deleted")).not.toHaveLength(0);

    deletion.resolve(emptyCorpusAnalysis());

    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as SavedSession[];
      expect(persisted.map((session) => session.id)).toEqual(["session-b"]);
    });
    expect(screen.getByText("Transcript will appear here.")).toBeInTheDocument();
    expect(screen.queryByText("alpha deleted")).not.toBeInTheDocument();
  });
});

describe("desktop protected storage", () => {
  afterEach(() => resetAppStorage());

  it("moves plain sessions in, shows them, discloses the protection and writes changes through", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const protectedEntries = new Map<string, string>();
    const deletion = deferred<SpeechCorpusAnalysis>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const params = args as Record<string, unknown> | undefined;
      switch (command) {
        case "protected_storage_open":
          return { status: "protected", mechanism: "Test Keychain", migrated: false, entries: {} };
        case "protected_storage_migrate":
          for (const [key, value] of Object.entries(params?.entries as Record<string, string>)) {
            protectedEntries.set(key, value);
          }
          return null;
        case "protected_storage_set":
          protectedEntries.set(params?.key as string, params?.value as string);
          return null;
        case "protected_storage_remove":
          protectedEntries.delete(params?.key as string);
          return null;
        case "protected_audio_get":
          return new ArrayBuffer(0);
        case "protected_audio_delete":
        case "protected_audio_retain":
          return null;
        case "delete_speech_corpus_session":
          return deletion.promise;
        default:
          throw new Error(`Tauri invoke unavailable for ${command}`);
      }
    });
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        makeSession("session-a", "alpha", "2026-05-19T10:00:00.000Z"),
        makeSession("session-b", "beta", "2026-05-19T11:00:00.000Z"),
      ]),
    );

    expect((await initializeAppStorage()).kind).toBe("protected");
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();

    expect(await screen.findByText("Local data is encrypted on this device")).toBeInTheDocument();
    expect(screen.getByText(/key held in the Test Keychain/)).toBeInTheDocument();
    await userEvent.click((await screen.findAllByTitle("Delete saved session"))[0]);
    await waitFor(() => expect(deleteInvocationCount()).toBe(1));
    deletion.resolve(emptyCorpusAnalysis());

    await waitFor(() => {
      const persisted = JSON.parse(protectedEntries.get(STORE_KEY) ?? "[]") as SavedSession[];
      expect(persisted).toHaveLength(1);
    });
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it("tells a browser user that local data is not encrypted", async () => {
    renderApp();
    expect(await screen.findByText("Local data is not encrypted in a browser")).toBeInTheDocument();
  });
});
