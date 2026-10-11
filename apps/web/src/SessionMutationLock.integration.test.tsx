import { migrateSessionRecord } from "@stutter-tracker/shared";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createSessionBackup, parseSessionBackup } from "./storage/sessionBackup";
import type { SavedSession, SpeechCorpusAnalysis } from "./types";

// Acceptance tests for issue #102: session mutations that touch the browser store and/or the
// desktop corpus are serialized across windows through the Web Lock "vox:session-mutations".
// The test plays "the other window": it holds that lock on the shared (fake) navigator.locks and,
// while holding it, writes another session to localStorage without a storage event, as a window
// whose event has not been delivered yet. This window must neither write either store nor drop a
// checkpoint until the lock is released, and must then build on the stored list it finds.

const SESSION_MUTATION_LOCK = "vox:session-mutations";
const STORE_KEY = "stutter-tracker:sessions";
const CHECKPOINT_PREFIX = "stutter-tracker:capture-checkpoint:";
const SAVE_COMMAND = "save_speech_corpus_session";
const DELETE_COMMAND = "delete_speech_corpus_session";
const REPLACE_COMMAND = "replace_speech_corpus_sessions";
const ANALYZE_COMMAND = "analyze_speech_session";

// --- Shared fake Web Locks -------------------------------------------------------------------

type LockCallback = (lock: Lock | null) => unknown;

/** In-memory exclusive LockManager shared by the app and the test ("the other window"). */
class FakeLockManager {
  readonly requested: string[] = [];
  private readonly held = new Map<string, Lock>();
  private readonly waiting = new Map<string, Array<() => void>>();

  request(
    name: string,
    optionsOrCallback: LockOptions | LockCallback,
    maybeCallback?: LockCallback,
  ) {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = (
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
    ) as LockCallback;
    this.requested.push(name);
    if (options.ifAvailable && this.held.has(name)) {
      return Promise.resolve().then(() => callback(null));
    }
    return new Promise<unknown>((resolve, reject) => {
      const grant = () => {
        const lock = { name, mode: options.mode ?? "exclusive" } as Lock;
        this.held.set(name, lock);
        Promise.resolve()
          .then(() => callback(lock))
          .then(resolve, reject)
          .finally(() => {
            this.held.delete(name);
            this.waiting.get(name)?.shift()?.();
          });
      };
      if (this.held.has(name)) {
        const queue = this.waiting.get(name) ?? [];
        queue.push(grant);
        this.waiting.set(name, queue);
      } else {
        grant();
      }
    });
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: [...this.held.values()].map((lock) => ({ name: lock.name, mode: lock.mode })),
      pending: [],
    };
  }

  isHeld(name: string) {
    return this.held.has(name);
  }
}

let locks: FakeLockManager;

function installLocks() {
  locks = new FakeLockManager();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    get: () => locks as unknown as LockManager,
  });
}

function uninstallLocks() {
  delete (navigator as { locks?: unknown }).locks;
}

/** "The other window" takes the session-mutation lock and keeps it until `release` is called. */
async function holdLockInOtherWindow() {
  const acquired = deferred<void>();
  const held = deferred<void>();
  const done = locks.request(SESSION_MUTATION_LOCK, async () => {
    acquired.resolve();
    await held.promise;
  });
  await acquired.promise;
  return {
    async release() {
      held.resolve();
      await done;
    },
  };
}

// --- App and data helpers --------------------------------------------------------------------

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

function makeCheckpoint(id: string, withAnalysis: boolean) {
  return {
    version: 1,
    id,
    startedAt: "2026-10-09T10:00:00.000Z",
    updatedAt: "2026-10-09T10:02:00.000Z",
    language: "en-US",
    segments: [
      { text: "Recovered words", startSeconds: 0, endSeconds: 2, confidence: 0.9, isFinal: true },
    ],
    pauses: [],
    analysis: withAnalysis
      ? {
          report: makeReport(),
          run: {
            id: "run-recovered",
            createdAt: "2026-10-09T10:01:00.000Z",
            analyzer: null,
            usedAudio: true,
            audioId: "audio-gone",
            inputId: "input",
          },
        }
      : null,
    recording: null,
  };
}

function seedStoredSessions(sessions: SavedSession[]) {
  localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
  return localStorage.getItem(STORE_KEY);
}

function storedSessions() {
  return JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as SavedSession[] | null;
}

function storedIds() {
  return (storedSessions() ?? []).map((session) => session.id).sort();
}

/** Another window's write: lands in shared storage, but its storage event has not arrived yet. */
function otherWindowSaves(session: SavedSession) {
  localStorage.setItem(STORE_KEY, JSON.stringify([session, ...(storedSessions() ?? [])]));
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

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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

beforeEach(() => {
  installLocks();
  stubReload();
});

afterEach(() => {
  uninstallLocks();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(isTauri).mockReset();
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async () => {
    throw new Error("Tauri invoke is unavailable in tests");
  });
});

const otherSession = makeSession("other-window", "other window words", "2026-10-10T09:00:00.000Z");

describe("saves wait for another window's session mutation", () => {
  it("a new-session save writes nothing and keeps its checkpoint until the lock is released, then keeps both sessions", async () => {
    const captureId = "capture-new-save";
    const checkpointKey = `${CHECKPOINT_PREFIX}${captureId}`;
    localStorage.setItem(checkpointKey, JSON.stringify(makeCheckpoint(captureId, false)));
    const user = userEvent.setup();
    renderApp();

    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    expect((await screen.findAllByText("Recovered words")).length).toBeGreaterThan(0);
    await settle();
    expect(localStorage.getItem(STORE_KEY)).toBeNull();

    const otherWindow = await holdLockInOtherWindow();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await settle();

    // Nothing is written and the checkpoint stays while the other window mutates.
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
    expect(localStorage.getItem(checkpointKey)).not.toBeNull();

    otherWindowSaves(otherSession);
    await otherWindow.release();

    await waitFor(() => expect(storedIds()).toEqual([captureId, otherSession.id].sort()));
    await waitFor(() => expect(localStorage.getItem(checkpointKey)).toBeNull());
  });

  it("a recovered capture's desktop save touches neither store until the lock is released", async () => {
    useDesktopInvokeMock({ [SAVE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()) });
    const captureId = "capture-recovered";
    const checkpointKey = `${CHECKPOINT_PREFIX}${captureId}`;
    localStorage.setItem(checkpointKey, JSON.stringify(makeCheckpoint(captureId, true)));
    const user = userEvent.setup();
    renderApp();

    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await settle();
    const otherWindow = await holdLockInOtherWindow();
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    await settle();

    expect(invocations(SAVE_COMMAND)).toHaveLength(0);
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
    expect(localStorage.getItem(checkpointKey)).not.toBeNull();

    otherWindowSaves(otherSession);
    await otherWindow.release();

    await waitFor(() => expect(storedIds()).toEqual([captureId, otherSession.id].sort()));
    await waitFor(() => expect(localStorage.getItem(checkpointKey)).toBeNull());
    const savedIds = invocations(SAVE_COMMAND).map(
      ([, args]) => (args as { session: SavedSession }).session.id,
    );
    expect(savedIds).toEqual([captureId]);
  });

  it("holds the lock while its desktop save is in flight, so the other window waits for it", async () => {
    const nativeSave = deferred<SpeechCorpusAnalysis>();
    useDesktopInvokeMock({ [SAVE_COMMAND]: () => nativeSave.promise });
    const captureId = "capture-in-flight";
    const checkpointKey = `${CHECKPOINT_PREFIX}${captureId}`;
    localStorage.setItem(checkpointKey, JSON.stringify(makeCheckpoint(captureId, true)));
    const user = userEvent.setup();
    renderApp();

    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    await waitFor(() => expect(invocations(SAVE_COMMAND)).toHaveLength(1));

    expect(locks.isHeld(SESSION_MUTATION_LOCK)).toBe(true);
    let otherWindowRan = false;
    const otherWindow = locks.request(SESSION_MUTATION_LOCK, async () => {
      otherWindowRan = true;
    });
    await settle();
    expect(otherWindowRan).toBe(false);

    nativeSave.resolve(emptyCorpusAnalysis());
    await otherWindow;
    expect(otherWindowRan).toBe(true);
    expect(storedIds()).toEqual([captureId]);
  });

  it("a reanalysis save waits for the lock and keeps the other window's session", async () => {
    const target = makeSession("target", "alpha current", "2026-05-19T10:00:00.000Z");
    useDesktopInvokeMock({
      [ANALYZE_COMMAND]: () => Promise.resolve({ ...makeReport(), analyzerVersion: "test" }),
      [SAVE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()),
    });
    const before = seedStoredSessions([target]);
    renderApp();

    const reanalyze = await screen.findByRole("button", {
      name: `Reanalyze saved session from ${new Date(target.startedAt).toLocaleString()}`,
    });
    await settle();
    const analysesBefore = invocations(ANALYZE_COMMAND).length;
    const otherWindow = await holdLockInOtherWindow();
    await userEvent.click(reanalyze);
    await waitFor(() => expect(invocations(ANALYZE_COMMAND)).toHaveLength(analysesBefore + 1));
    await settle();

    expect(invocations(SAVE_COMMAND)).toHaveLength(0);
    expect(localStorage.getItem(STORE_KEY)).toBe(before);

    otherWindowSaves(otherSession);
    await otherWindow.release();

    await waitFor(() => expect(invocations(SAVE_COMMAND)).toHaveLength(1));
    await waitFor(() => expect(storedIds()).toEqual([otherSession.id, target.id].sort()));
    const updated = storedSessions()!.find((session) => session.id === target.id)!;
    expect(updated.priorAnalyses).toHaveLength(1);
  });
});

describe("deletes and restores wait for another window's session mutation", () => {
  it("a desktop delete waits for the lock and keeps the other window's session", async () => {
    useDesktopInvokeMock({ [DELETE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()) });
    const doomed = makeSession("doomed", "alpha doomed", "2026-05-19T10:00:00.000Z");
    const kept = makeSession("kept", "beta kept", "2026-05-19T11:00:00.000Z");
    const before = seedStoredSessions([doomed, kept]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();

    const deleteButtons = await screen.findAllByTitle("Delete saved session");
    await settle();
    const otherWindow = await holdLockInOtherWindow();
    await userEvent.click(deleteButtons[0]);
    await settle();

    expect(invocations(DELETE_COMMAND)).toHaveLength(0);
    expect(localStorage.getItem(STORE_KEY)).toBe(before);

    otherWindowSaves(otherSession);
    await otherWindow.release();

    await waitFor(() => expect(invocations(DELETE_COMMAND)).toHaveLength(1));
    await waitFor(() => expect(storedIds()).toEqual([kept.id, otherSession.id].sort()));
  });

  it("a desktop restore neither replaces the corpus nor writes storage while the lock is held", async () => {
    useDesktopInvokeMock({ [REPLACE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()) });
    const current = [makeSession("current-a", "alpha current", "2026-05-19T10:00:00.000Z")];
    const backup = [makeSession("backup-x", "xray restored", "2026-04-01T10:00:00.000Z")];
    const json = JSON.stringify(createSessionBackup(backup, new Date("2026-10-01T00:00:00.000Z")));
    const before = seedStoredSessions(current);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();

    const input = await screen.findByLabelText<HTMLInputElement>("Choose session backup");
    await waitFor(() => expect(input).not.toBeDisabled());
    await settle();
    const otherWindow = await holdLockInOtherWindow();
    await userEvent.upload(
      input,
      new File([json], "sessions-backup.json", { type: "application/json" }),
    );
    await settle();

    expect(invocations(REPLACE_COMMAND)).toHaveLength(0);
    expect(localStorage.getItem(STORE_KEY)).toBe(before);
    expect(reload).not.toHaveBeenCalled();

    otherWindowSaves(otherSession);
    await otherWindow.release();

    // The restore runs entirely after the other window's mutation: its result is the backup.
    await waitFor(() => expect(invocations(REPLACE_COMMAND)).toHaveLength(1));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const restored = parseSessionBackup(JSON.parse(json));
    expect(invocations(REPLACE_COMMAND)[0][1]).toEqual({ sessions: restored });
    expect(storedSessions()).toEqual(restored);
  });
});
