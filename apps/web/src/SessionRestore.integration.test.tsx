import { migrateSessionRecord, SESSION_SCHEMA_VERSION } from "@stutter-tracker/shared";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createSessionBackup, parseSessionBackup } from "./storage/sessionBackup";
import type { SavedSession, SpeechCorpusAnalysis } from "./types";
import { storedSessions, storedSessionsSnapshot } from "./test/storedSessions";

// Acceptance tests for issue #86, decision (a) "replace all": a valid backup becomes the whole set
// of saved sessions after one confirmation, serialized behind pending session mutations, written
// all-or-nothing to localStorage and (on desktop) to the native speech corpus.

const STORE_KEY = "stutter-tracker:sessions";
const REPLACE_COMMAND = "replace_speech_corpus_sessions";
const DELETE_COMMAND = "delete_speech_corpus_session";

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

const currentSessions = [
  makeSession("current-a", "alpha current", "2026-05-19T10:00:00.000Z"),
  makeSession("current-b", "beta current", "2026-05-19T11:00:00.000Z"),
  makeSession("current-c", "gamma current", "2026-05-19T12:00:00.000Z"),
];
const backupSessions = [
  makeSession("backup-x", "xray restored", "2026-04-01T10:00:00.000Z"),
  makeSession("backup-y", "yankee restored", "2026-04-02T10:00:00.000Z"),
];

function backupJson(sessions: SavedSession[] = backupSessions) {
  return JSON.stringify(createSessionBackup(sessions, new Date("2026-10-01T00:00:00.000Z")));
}

/** The sessions a restore of `json` must leave behind, as the backup parser reads them. */
function restoredSessions(json: string) {
  return parseSessionBackup(JSON.parse(json));
}

function backupFile(json: string) {
  return new File([json], "sessions-backup.json", { type: "application/json" });
}

function seedStoredSessions(sessions: SavedSession[]) {
  localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
  return storedSessionsSnapshot();
}

async function uploadBackup(json: string) {
  const input = await screen.findByLabelText<HTMLInputElement>("Choose session backup");
  await waitFor(() => expect(input).not.toBeDisabled());
  await userEvent.upload(input, backupFile(json));
}

let reload: ReturnType<typeof vi.fn>;

/** jsdom cannot navigate; the restore's page reload is observed through a stubbed location. */
function stubReload() {
  reload = vi.fn();
  const original = window.location;
  const fake = {
    ancestorOrigins: original.ancestorOrigins,
    hash: original.hash,
    host: original.host,
    hostname: original.hostname,
    href: original.href,
    origin: original.origin,
    pathname: original.pathname,
    port: original.port,
    protocol: original.protocol,
    search: original.search,
    assign: vi.fn(),
    replace: vi.fn(),
    reload,
    toString: () => original.href,
  } as unknown as Location;
  vi.spyOn(window, "location", "get").mockReturnValue(fake);
}

/** Only the restore confirmation ("... from this backup?"); the delete confirmation also mentions backups. */
function restoreConfirmMessages(confirm: { mock: { calls: Array<[message?: string]> } }) {
  return confirm.mock.calls
    .map(([message]) => String(message))
    .filter((message) => /from this backup/i.test(message));
}

type InvokeHandlers = Partial<Record<string, (args: unknown) => Promise<unknown>>>;

function useDesktopInvokeMock(handlers: InvokeHandlers = {}) {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation((command, args) => {
    const handler = handlers[command];
    if (handler) {
      return handler(args) as Promise<never>;
    }
    if (command === "load_speech_corpus" || command === "backfill_speech_corpus_capture_quality") {
      return Promise.resolve(emptyCorpusAnalysis()) as Promise<never>;
    }
    return Promise.reject(new Error(`Tauri invoke unavailable for ${command}`));
  });
}

function invocations(command: string) {
  return vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
}

function alertTexts() {
  return screen
    .queryAllByRole("alert")
    .map((alert) => (alert.textContent ?? "").trim())
    .filter(Boolean);
}

/** Waits for an error alert that was not on screen when `baseline` was taken. */
async function findRestoreError(baseline: string[]) {
  return waitFor(() => {
    const added = alertTexts().filter((text) => !baseline.includes(text));
    expect(added.length).toBeGreaterThan(0);
    return added;
  });
}

/** Lets any stray async continuation (a late mutation, a late write) run before asserting. */
async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  stubReload();
});

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

describe("restore confirmation", () => {
  it("names the current saved-session count, the backup count and the loss; cancel changes nothing", async () => {
    const before = seedStoredSessions(currentSessions);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    renderApp();
    await uploadBackup(backupJson());

    await waitFor(() => expect(restoreConfirmMessages(confirm)).toHaveLength(1));
    const [message] = restoreConfirmMessages(confirm);
    expect(message).toMatch(/\b3 current saved sessions\b/);
    expect(message).toMatch(/\b2 sessions from this backup\b/);
    expect(message).toMatch(/will be lost/i);

    await settle();
    expect(storedSessionsSnapshot()).toBe(before);
    expect(reload).not.toHaveBeenCalled();
    expect(invocations(REPLACE_COMMAND)).toHaveLength(0);
  });
});

describe("serialized, all-or-nothing replace", () => {
  it("waits for a pending desktop deletion and nothing from it lands after the restore", async () => {
    const deletion = deferred<SpeechCorpusAnalysis>();
    useDesktopInvokeMock({
      [DELETE_COMMAND]: () => deletion.promise,
      [REPLACE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()),
    });
    seedStoredSessions(currentSessions);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();
    await userEvent.click((await screen.findAllByTitle("Delete saved session"))[0]);
    await waitFor(() => expect(invocations(DELETE_COMMAND)).toHaveLength(1));

    const json = backupJson();
    await uploadBackup(json);
    await waitFor(() => expect(restoreConfirmMessages(confirm)).toHaveLength(1));
    await settle();

    // The restore is queued behind the deletion: the native corpus is not replaced yet.
    expect(invocations(REPLACE_COMMAND)).toHaveLength(0);

    deletion.resolve(emptyCorpusAnalysis());

    await waitFor(() => expect(invocations(REPLACE_COMMAND)).toHaveLength(1));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    await settle();
    expect(storedSessions()).toEqual(restoredSessions(json));
  });

  it("leaves stored sessions unchanged and shows an error when the storage quota is exhausted", async () => {
    const before = seedStoredSessions(currentSessions);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();
    await screen.findAllByTitle("Delete saved session");

    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === STORE_KEY) {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    });

    const baseline = alertTexts();
    await uploadBackup(backupJson());
    await findRestoreError(baseline);
    await settle();

    expect(storedSessionsSnapshot()).toBe(before);
    expect(reload).not.toHaveBeenCalled();
    // In-memory state is unchanged as well: the current sessions are still listed.
    expect(screen.getAllByTitle("Delete saved session")).toHaveLength(currentSessions.length);
  });

  it("replaces the desktop corpus with exactly the restored sessions", async () => {
    useDesktopInvokeMock({
      [REPLACE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()),
    });
    seedStoredSessions(currentSessions);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();
    const json = backupJson();
    await uploadBackup(json);

    await waitFor(() => expect(reload).toHaveBeenCalled());
    const calls = invocations(REPLACE_COMMAND);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ sessions: restoredSessions(json) });
    expect(storedSessions()).toEqual(restoredSessions(json));
  });

  it("puts the previous sessions back and shows an error when the desktop replace fails", async () => {
    useDesktopInvokeMock({
      [REPLACE_COMMAND]: () => Promise.reject(new Error("corpus file is not writable")),
    });
    const before = seedStoredSessions(currentSessions);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();
    await screen.findAllByTitle("Delete saved session");
    const baseline = alertTexts();
    await uploadBackup(backupJson());

    await waitFor(() => expect(invocations(REPLACE_COMMAND)).toHaveLength(1));
    await findRestoreError(baseline);
    await settle();

    expect(storedSessionsSnapshot()).toBe(before);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getAllByTitle("Delete saved session")).toHaveLength(currentSessions.length);
  });
});

describe("invalid backups", () => {
  const valid = backupJson();
  const parsedValid = JSON.parse(valid) as { version: number; sessions: unknown[] };
  const cases: Array<[string, string]> = [
    ["corrupt JSON", "{ this is not json"],
    ["truncated JSON", valid.slice(0, Math.floor(valid.length / 2))],
    ["an unsupported backup version", JSON.stringify({ ...parsedValid, version: 99 })],
    [
      "an unsupported session schema version",
      JSON.stringify({
        ...parsedValid,
        sessions: [
          { ...(parsedValid.sessions[0] as object), schemaVersion: SESSION_SCHEMA_VERSION + 1 },
          parsedValid.sessions[1],
        ],
      }),
    ],
  ];

  it.each(cases)(
    "rejects %s before confirming and leaves the corpus unchanged",
    async (_label, json) => {
      useDesktopInvokeMock({
        [REPLACE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()),
      });
      const before = seedStoredSessions(currentSessions);
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

      renderApp();
      await screen.findAllByTitle("Delete saved session");
      const baseline = alertTexts();
      await uploadBackup(json);
      await findRestoreError(baseline);
      await settle();

      expect(confirm).not.toHaveBeenCalled();
      expect(storedSessionsSnapshot()).toBe(before);
      expect(invocations(REPLACE_COMMAND)).toHaveLength(0);
      expect(reload).not.toHaveBeenCalled();
    },
  );
});

describe("idempotence", () => {
  it("restoring the same backup twice yields identical stored state", async () => {
    useDesktopInvokeMock({
      [REPLACE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()),
    });
    seedStoredSessions(currentSessions);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const json = backupJson();

    const first = renderApp();
    await uploadBackup(json);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await settle();
    const afterFirst = storedSessionsSnapshot();
    // The real app reloads after a restore; remount to start from the restored state.
    first.unmount();

    renderApp();
    await uploadBackup(json);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    await settle();

    expect(storedSessionsSnapshot()).toBe(afterFirst);
    expect(storedSessions()).toEqual(restoredSessions(json));
    const calls = invocations(REPLACE_COMMAND);
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(calls[0][1]);
  });
});

// --- Implementation regression test (not acceptance): Codex P1 on vox#99. A reanalysis whose
// analysis finishes after the restore was queued must not write replaced sessions back.
function makeRegressionReport() {
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

describe("queued work behind a restore", () => {
  it("a reanalysis that completes after the restore does not resurrect a replaced session", async () => {
    const analysis = deferred<unknown>();
    useDesktopInvokeMock({
      analyze_speech_session: () => analysis.promise,
      save_speech_corpus_session: () => Promise.resolve(emptyCorpusAnalysis()),
      [REPLACE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()),
    });
    seedStoredSessions(currentSessions);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();
    const target = currentSessions[0];
    const reanalyzeButton = await screen.findByRole("button", {
      name: `Reanalyze saved session from ${new Date(target.startedAt).toLocaleString()}`,
    });
    await settle();
    const analysesBefore = invocations("analyze_speech_session").length;
    await userEvent.click(reanalyzeButton);
    await waitFor(() =>
      expect(invocations("analyze_speech_session")).toHaveLength(analysesBefore + 1),
    );

    const json = backupJson();
    await uploadBackup(json);
    await waitFor(() => expect(invocations(REPLACE_COMMAND)).toHaveLength(1));

    analysis.resolve({ ...makeRegressionReport(), analyzerVersion: "test" });
    await settle();

    expect(storedSessions()).toEqual(restoredSessions(json));
    const savedIds = invocations("save_speech_corpus_session").map(
      ([, args]) => (args as { session: SavedSession }).session.id,
    );
    expect(savedIds).not.toContain(target.id);
  });
});

// --- Implementation regression test (not acceptance): second Codex P1 on vox#99. While the
// desktop replace is still pending, interrupted-capture detection must not treat the provisional
// restored ids as saved and drop their checkpoints; a failed restore would lose unsaved speech.
function makeRegressionCheckpoint(id: string, text: string) {
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

describe("checkpoints during a provisional restore", () => {
  it("keeps an interrupted capture whose id is in the backup when the desktop replace fails", async () => {
    const replace = deferred<SpeechCorpusAnalysis>();
    useDesktopInvokeMock({ [REPLACE_COMMAND]: () => replace.promise });
    seedStoredSessions(currentSessions);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();
    await screen.findAllByTitle("Delete saved session");
    await settle();
    const checkpointKey = `stutter-tracker:capture-checkpoint:${backupSessions[0].id}`;
    localStorage.setItem(
      checkpointKey,
      JSON.stringify(makeRegressionCheckpoint(backupSessions[0].id, "unsaved words")),
    );

    await uploadBackup(backupJson());
    await waitFor(() => expect(invocations(REPLACE_COMMAND)).toHaveLength(1));
    // The detector runs on focus while the native replace is still pending.
    window.dispatchEvent(new Event("focus"));
    await settle();

    replace.reject(new Error("disk full"));
    await settle();

    expect(localStorage.getItem(checkpointKey)).not.toBeNull();
    expect(storedSessions()).toEqual(currentSessions);
  });
});

describe("recovery during a provisional restore", () => {
  // Implementation regression test (not acceptance): third Codex P1 on vox#99.
  it("does not recover against provisional storage and keeps the checkpoint when the restore fails", async () => {
    const replace = deferred<SpeechCorpusAnalysis>();
    useDesktopInvokeMock({ [REPLACE_COMMAND]: () => replace.promise });
    seedStoredSessions(currentSessions);
    const checkpointKey = `stutter-tracker:capture-checkpoint:${backupSessions[0].id}`;
    localStorage.setItem(
      checkpointKey,
      JSON.stringify(makeRegressionCheckpoint(backupSessions[0].id, "unsaved words")),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();
    const recover = await screen.findByRole("button", { name: /Recover recording/ });

    await uploadBackup(backupJson());
    await waitFor(() => expect(invocations(REPLACE_COMMAND)).toHaveLength(1));
    await userEvent.click(recover);
    await settle();

    replace.reject(new Error("disk full"));
    await settle();

    expect(localStorage.getItem(checkpointKey)).not.toBeNull();
    expect(storedSessions()).toEqual(currentSessions);
  });
});

describe("shared storage during a pending desktop replace", () => {
  // Implementation regression test (not acceptance): fourth Codex P1 on vox#99. Browser storage is
  // shared with other windows, so it must not expose the backup before the native replace succeeds.
  it("keeps browser storage on the current sessions until the native replace succeeds", async () => {
    const replace = deferred<SpeechCorpusAnalysis>();
    useDesktopInvokeMock({ [REPLACE_COMMAND]: () => replace.promise });
    seedStoredSessions(currentSessions);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();
    await screen.findAllByTitle("Delete saved session");
    const json = backupJson();
    await uploadBackup(json);
    await waitFor(() => expect(invocations(REPLACE_COMMAND)).toHaveLength(1));
    await settle();
    expect(storedSessions()).toEqual(currentSessions);

    replace.resolve(emptyCorpusAnalysis());
    await waitFor(() => expect(storedSessions()).toEqual(restoredSessions(json)));
  });
});
