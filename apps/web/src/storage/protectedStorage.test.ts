import "fake-indexeddb/auto";
import { fallbackAnalyze } from "@stutter-tracker/shared";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CaptureCheckpoint,
  listCaptureCheckpoints,
  writeCaptureCheckpoint,
} from "./captureCheckpoint";
import {
  loadSessionsFromStorage,
  replaceStoredSessions,
  saveSessionsToStorage,
  STORE_KEY,
  SPEAKERS_KEY,
  UNREADABLE_SESSIONS_KEY,
} from "./localStorage";
import {
  appStorage,
  flushAppStorage,
  initializeAppStorage,
  type ProtectedBackend,
  resetAppStorage,
  storageProtection,
  storageWriteError,
} from "./protectedStorage";
import {
  decodeSessionAudio,
  encodeSessionAudio,
  getSessionAudio,
  type KeptSessionAudio,
  putSessionAudio,
  resetSessionAudioConnection,
  type SessionAudioStore,
} from "./sessionAudio";

const report = fallbackAnalyze({
  segments: [{ text: "hello", startSeconds: 0, endSeconds: 0.5, isFinal: true }],
  pauses: [],
});

function session(id: string) {
  return {
    id,
    startedAt: "2026-09-01T08:00:00.000Z",
    segments: [{ text: "hello", startSeconds: 0, endSeconds: 0.5, isFinal: true }],
    pauses: [],
    report,
  };
}

function kept(sessionId: string): KeptSessionAudio {
  return {
    sessionId,
    sampleRate: 10,
    samples: new Float32Array([0.25, -0.5, 1, 0]),
    startOffsetSeconds: 1.5,
    discontinuities: [{ startSeconds: 2, endSeconds: 2.5, reason: "paused" }],
    droppedSeconds: 0,
    audioId: "pcm-test",
    keptAt: "2026-10-17T10:00:00.000Z",
  };
}

function plainStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

/**
 * The Rust protected store as the web view sees it: what it holds survives between "starts" (new
 * `initializeAppStorage` calls on the same backend), like the sealed files on disk.
 */
function fakeBackend() {
  const state = {
    entries: new Map<string, string>(),
    migrated: false,
    audio: new Map<string, KeptSessionAudio>(),
    failMigrate: null as null | "before" | "midway",
    failSet: false,
    failAudioPut: false,
    open: "protected" as "protected" | "unprotected" | "locked" | "throws",
  };
  const audio: SessionAudioStore = {
    async put(value) {
      if (state.failAudioPut) throw new Error("disk full");
      state.audio.set(value.sessionId, value);
    },
    get: async (id) => state.audio.get(id) ?? null,
    delete: async (id) => void state.audio.delete(id),
    retain: async (ids) => {
      for (const id of state.audio.keys()) if (!ids.includes(id)) state.audio.delete(id);
    },
  };
  const backend: ProtectedBackend = {
    async open() {
      if (state.open === "throws") throw new Error("a protected file could not be opened");
      if (state.open === "unprotected") return { status: "unprotected", reason: "no keyring" };
      if (state.open === "locked") return { status: "locked", reason: "key missing" };
      return {
        status: "protected",
        mechanism: "Test Keychain",
        migrated: state.migrated,
        entries: Object.fromEntries(state.entries),
      };
    },
    async migrate(entries) {
      if (state.failMigrate === "before") throw new Error("disk full");
      // As in Rust: each entry is written, stale ones removed, and the mark is written last.
      const keys = Object.keys(entries);
      for (const [index, key] of keys.entries()) {
        if (state.failMigrate === "midway" && index === 1) throw new Error("app quit");
        state.entries.set(key, entries[key]);
      }
      for (const key of state.entries.keys()) if (!(key in entries)) state.entries.delete(key);
      state.migrated = true;
    },
    async set(key, value) {
      if (state.failSet) throw new Error("disk full");
      state.entries.set(key, value);
    },
    async remove(key) {
      state.entries.delete(key);
    },
    audio,
  };
  return { state, backend };
}

const checkpoint: CaptureCheckpoint = {
  version: 1,
  id: "capture-1",
  startedAt: "2026-10-09T10:00:00.000Z",
  updatedAt: "2026-10-09T10:01:00.000Z",
  language: "en-US",
  segments: [
    { text: "I I want", startSeconds: 0, endSeconds: 1.5, confidence: 0.9, isFinal: true },
  ],
  pauses: [],
  analysis: null,
  recording: null,
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetSessionAudioConnection();
});

afterEach(() => {
  resetAppStorage();
});

describe("protected local storage", () => {
  it("keeps the browser's unencrypted storage outside the desktop app and says so", async () => {
    expect(await initializeAppStorage({ backend: null })).toEqual({ kind: "browser" });
    expect(appStorage()).toBe(localStorage);
  });

  it("moves an earlier build's plain data in on the first desktop start", async () => {
    const { state, backend } = fakeBackend();
    const plain = plainStorage({
      [STORE_KEY]: JSON.stringify([session("s1")]),
      [SPEAKERS_KEY]: "[]",
      "another-app:key": "not ours",
    });

    expect(await initializeAppStorage({ backend, plain })).toEqual({
      kind: "protected",
      mechanism: "Test Keychain",
    });

    expect(loadSessionsFromStorage().map((item) => item.id)).toEqual(["s1"]);
    expect([...state.entries.keys()].sort()).toEqual([STORE_KEY, SPEAKERS_KEY]);
    expect(state.migrated).toBe(true);
    // The plain copy of the app's data is gone; other keys are not the app's to move.
    expect(plain.getItem(STORE_KEY)).toBeNull();
    expect(plain.getItem("another-app:key")).toBe("not ours");

    saveSessionsToStorage([session("s1"), session("s2")].map((item) => ({ ...item })) as never);
    await flushAppStorage();
    expect(JSON.parse(state.entries.get(STORE_KEY) ?? "[]")).toHaveLength(2);
    expect(plain.getItem(STORE_KEY)).toBeNull();
  });

  it("leaves the current corpus intact and in use when the migration fails", async () => {
    const { state, backend } = fakeBackend();
    state.failMigrate = "before";
    const stored = JSON.stringify([session("s1")]);
    const plain = plainStorage({ [STORE_KEY]: stored });

    const protection = await initializeAppStorage({ backend, plain });

    expect(protection.kind).toBe("unprotected");
    expect(protection.kind === "unprotected" && protection.reason).toContain("disk full");
    expect(plain.getItem(STORE_KEY)).toBe(stored);
    expect(state.migrated).toBe(false);
  });

  it("completes an interrupted migration from the intact plain copy on the next start", async () => {
    const { state, backend } = fakeBackend();
    // An earlier partial attempt left an entry that was since removed from the plain copy.
    state.entries.set("stutter-tracker:capture-checkpoint:old", "{}");
    const plain = plainStorage({
      [STORE_KEY]: JSON.stringify([session("s1")]),
      [SPEAKERS_KEY]: "[]",
    });
    state.failMigrate = "midway";
    expect((await initializeAppStorage({ backend, plain })).kind).toBe("unprotected");
    expect(state.migrated).toBe(false);
    expect(plain.getItem(STORE_KEY)).not.toBeNull();

    state.failMigrate = null;
    expect((await initializeAppStorage({ backend, plain })).kind).toBe("protected");
    expect([...state.entries.keys()].sort()).toEqual([STORE_KEY, SPEAKERS_KEY]);
    expect(loadSessionsFromStorage().map((item) => item.id)).toEqual(["s1"]);
    expect(plain.length).toBe(0);
  });

  it("drops plain leftovers of a migration interrupted while removing them", async () => {
    const { state, backend } = fakeBackend();
    state.migrated = true;
    state.entries.set(STORE_KEY, JSON.stringify([session("protected")]));
    const plain = plainStorage({ [STORE_KEY]: JSON.stringify([session("stale")]) });

    await initializeAppStorage({ backend, plain });

    expect(loadSessionsFromStorage().map((item) => item.id)).toEqual(["protected"]);
    expect(plain.getItem(STORE_KEY)).toBeNull();
  });

  it("saves nothing and touches nothing while protected storage is locked", async () => {
    for (const open of ["locked", "throws"] as const) {
      const { state, backend } = fakeBackend();
      state.open = open;
      state.entries.set(STORE_KEY, "sealed");
      const plain = plainStorage({});

      expect((await initializeAppStorage({ backend, plain })).kind).toBe("locked");
      saveSessionsToStorage([session("new")] as never);
      await flushAppStorage();

      expect(state.entries.get(STORE_KEY)).toBe("sealed");
      expect(plain.length).toBe(0);
      await expect(putSessionAudio(kept("new"))).rejects.toThrow("locked");
      resetAppStorage();
    }
  });

  it("uses the plain storage, as before, when the desktop has no credential store", async () => {
    const { state, backend } = fakeBackend();
    state.open = "unprotected";
    const plain = plainStorage({ [STORE_KEY]: JSON.stringify([session("s1")]) });

    expect(await initializeAppStorage({ backend, plain })).toEqual({
      kind: "unprotected",
      reason: "no keyring",
    });
    expect(plain.getItem(STORE_KEY)).not.toBeNull();
    expect(appStorage()).toBe(localStorage);
  });

  it("recovers an interrupted capture from protected storage after a crash", async () => {
    const { backend } = fakeBackend();
    await initializeAppStorage({ backend, plain: plainStorage() });
    writeCaptureCheckpoint(checkpoint);
    await flushAppStorage();

    // The app crashed; the next start sees only what reached protected storage.
    resetAppStorage();
    await initializeAppStorage({ backend, plain: plainStorage() });

    const found = listCaptureCheckpoints();
    expect(found).toHaveLength(1);
    expect(found[0].kind === "checkpoint" && found[0].checkpoint.segments[0].text).toBe("I I want");
  });

  it("persists a backup import into protected storage", async () => {
    const { state, backend } = fakeBackend();
    state.migrated = true;
    state.entries.set(STORE_KEY, JSON.stringify([session("current")]));
    state.entries.set(UNREADABLE_SESSIONS_KEY, JSON.stringify([{ broken: true }]));
    await initializeAppStorage({ backend, plain: plainStorage() });

    replaceStoredSessions([session("restored-1"), session("restored-2")] as never);
    await flushAppStorage();

    expect(
      JSON.parse(state.entries.get(STORE_KEY) ?? "[]").map((item: { id: string }) => item.id),
    ).toEqual(["restored-1", "restored-2"]);
    expect(state.entries.has(UNREADABLE_SESSIONS_KEY)).toBe(false);
  });

  it("reports a change protected storage could not save, keeping it for this session", async () => {
    const { state, backend } = fakeBackend();
    await initializeAppStorage({ backend, plain: plainStorage() });
    state.failSet = true;

    saveSessionsToStorage([session("s1")] as never);
    await flushAppStorage();

    expect(storageWriteError()).toBe("disk full");
    expect(loadSessionsFromStorage().map((item) => item.id)).toEqual(["s1"]);

    state.failSet = false;
    saveSessionsToStorage([session("s1")] as never);
    await flushAppStorage();
    expect(storageWriteError()).toBeNull();
  });

  it("moves kept audio out of IndexedDB, or leaves it there when that fails", async () => {
    await putSessionAudio(kept("a"));
    const failing = fakeBackend();
    failing.state.failAudioPut = true;
    const protection = await initializeAppStorage({
      backend: failing.backend,
      plain: plainStorage(),
    });
    expect(protection.kind === "protected" && protection.warning).toContain("disk full");
    // Still found where it was.
    expect((await getSessionAudio("a"))?.audioId).toBe("pcm-test");

    resetAppStorage();
    const { state, backend } = fakeBackend();
    await initializeAppStorage({ backend, plain: plainStorage() });
    expect(storageProtection()).toEqual({ kind: "protected", mechanism: "Test Keychain" });
    expect(state.audio.get("a")?.audioId).toBe("pcm-test");
    expect((await getSessionAudio("a"))?.audioId).toBe("pcm-test");

    // IndexedDB no longer holds it.
    resetAppStorage();
    expect(await getSessionAudio("a")).toBeNull();
  });

  it("encodes kept audio for the desktop store without loss", () => {
    const audio = kept("session/with spaces");
    const decoded = decodeSessionAudio(encodeSessionAudio(audio));
    expect(decoded).toEqual(audio);
    expect(Array.from(decoded.samples)).toEqual([0.25, -0.5, 1, 0]);
  });
});
