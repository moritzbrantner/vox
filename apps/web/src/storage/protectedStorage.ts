// Where the app keeps its local data, decided once at startup (vox#85; threat review in
// docs/protected-storage.md).
//
// - Browser: `localStorage` and IndexedDB, which browsers do not encrypt. The UI says so.
// - Desktop app: the Rust side seals every value with a key held in the operating system's
//   credential store. This module mirrors that store in memory, so the existing synchronous
//   `Storage` callers keep working, and writes each change through in order.
//
// On the first desktop start, data an earlier build left in the web view's `localStorage` and
// IndexedDB is moved in. The plain copy is removed only after the protected store confirmed the
// whole move, so a failed or interrupted move leaves it intact and in use.
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  decodeSessionAudio,
  encodeSessionAudio,
  type KeptSessionAudio,
  moveIndexedDbAudio,
  type SessionAudioStore,
  setSessionAudioStore,
} from "./sessionAudio";

/** Every key the app stores starts with this prefix; other keys are not the app's to move. */
export const APP_STORAGE_PREFIX = "stutter-tracker:";

export type StorageProtection =
  /** A browser profile: nothing is encrypted by the app. */
  | { kind: "browser" }
  | {
      kind: "protected";
      /** The credential store holding the key, e.g. "macOS Keychain". */
      mechanism: string;
      /** A part that could not be moved in yet and stays unprotected for now. */
      warning?: string;
    }
  /** Desktop app without a usable credential store: plain files, as in earlier builds. */
  | { kind: "unprotected"; reason: string }
  /** Protected data exists but cannot be opened; nothing is saved this session. */
  | { kind: "locked"; reason: string };

export type ProtectedOpened =
  | {
      status: "protected";
      mechanism: string;
      migrated: boolean;
      entries: Record<string, string>;
    }
  | { status: "unprotected"; reason: string }
  | { status: "locked"; reason: string };

/** The desktop app's protected store (the `protected_storage_*` commands). */
export type ProtectedBackend = {
  open(): Promise<ProtectedOpened>;
  /** Replaces the protected key/value store with exactly `entries` and marks the move done. */
  migrate(entries: Record<string, string>): Promise<void>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  audio: SessionAudioStore;
};

let active: Storage | null = null;
let protection: StorageProtection = { kind: "browser" };
let writeError: string | null = null;
const listeners = new Set<() => void>();

/** The storage every app module reads and writes. `localStorage` until protected storage opens. */
export function appStorage(): Storage {
  return active ?? localStorage;
}

export function storageProtection(): StorageProtection {
  return protection;
}

/** The last change protected storage could not save, if any. */
export function storageWriteError(): string | null {
  return writeError;
}

export function subscribeStorageProtection(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of listeners) listener();
}

/** Writes still on their way to protected storage. */
export async function flushAppStorage() {
  if (active instanceof ProtectedStorage) await active.flush();
}

/** Test hook: back to the browser default. */
export function resetAppStorage() {
  active = null;
  protection = { kind: "browser" };
  writeError = null;
  setSessionAudioStore(null);
  notify();
}

/**
 * Chooses the app's storage. Never rejects: every failure keeps the data that exists intact and is
 * reported through `storageProtection()`.
 */
export async function initializeAppStorage(
  options: { backend?: ProtectedBackend | null; plain?: Storage } = {},
): Promise<StorageProtection> {
  const backend = options.backend === undefined ? desktopBackend() : options.backend;
  if (!backend) {
    return settle(null, { kind: "browser" });
  }
  let opened: ProtectedOpened;
  try {
    opened = await backend.open();
  } catch (error) {
    // The store exists but did not open (e.g. a damaged file): never fall back to the plain copy,
    // which may be older than what was protected.
    return settle(new MemoryStorage(), { kind: "locked", reason: message(error) });
  }
  if (opened.status === "unprotected") {
    return settle(null, { kind: "unprotected", reason: opened.reason });
  }
  if (opened.status === "locked") {
    return settle(new MemoryStorage(), { kind: "locked", reason: opened.reason });
  }

  const plain = options.plain ?? safeLocalStorage();
  const plainEntries = plain ? appEntries(plain) : {};
  let entries = opened.entries;
  if (!opened.migrated) {
    try {
      await backend.migrate(plainEntries);
    } catch (error) {
      return settle(null, {
        kind: "unprotected",
        reason: `moving existing data into protected storage failed: ${message(error)}`,
      });
    }
    entries = plainEntries;
  }
  // Moved (now or by an earlier start interrupted before it finished removing the plain copy).
  if (plain) {
    for (const key of Object.keys(plainEntries)) {
      try {
        plain.removeItem(key);
      } catch {
        // Removed on a later start.
      }
    }
  }

  let warning: string | undefined;
  try {
    await moveIndexedDbAudio(backend.audio);
    setSessionAudioStore(backend.audio);
  } catch (error) {
    // Kept audio stays in IndexedDB, where it is still found, until a later start moves it.
    setSessionAudioStore(null);
    warning = `Kept session audio is still unprotected: ${message(error)}`;
  }
  return settle(new ProtectedStorage(entries, backend), {
    kind: "protected",
    mechanism: opened.mechanism,
    ...(warning ? { warning } : {}),
  });
}

function settle(storage: Storage | null, next: StorageProtection) {
  active = storage;
  protection = next;
  writeError = null;
  if (next.kind === "locked") setSessionAudioStore(LOCKED_AUDIO);
  else if (next.kind !== "protected") setSessionAudioStore(null);
  notify();
  return next;
}

/** While locked, no audio is written anywhere, in particular not unprotected into IndexedDB. */
const LOCKED_AUDIO: SessionAudioStore = {
  put: () => Promise.reject(new Error("protected storage is locked; audio was not kept")),
  get: () => Promise.resolve(null),
  delete: () => Promise.resolve(),
  retain: () => Promise.resolve(),
};

function appEntries(storage: Storage) {
  const entries: Record<string, string> = {};
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(APP_STORAGE_PREFIX)) continue;
      const value = storage.getItem(key);
      if (value !== null) entries[key] = value;
    }
  } catch {
    // Unreadable storage holds nothing to move.
  }
  return entries;
}

function safeLocalStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** A `Storage` over an in-memory map. */
class MemoryStorage implements Storage {
  [name: string]: unknown;
  protected readonly entries: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  get length() {
    return this.entries.size;
  }

  key(index: number) {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.entries.set(key, String(value));
  }

  removeItem(key: string) {
    this.entries.delete(key);
  }

  clear() {
    for (const key of Array.from(this.entries.keys())) this.removeItem(key);
  }
}

/**
 * The protected store mirrored in memory. Each change is written through in order; a failed write
 * keeps the in-memory value (this session still sees it) and is reported to the UI.
 */
class ProtectedStorage extends MemoryStorage {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    entries: Record<string, string>,
    private readonly backend: ProtectedBackend,
  ) {
    super(entries);
  }

  override setItem(key: string, value: string) {
    const text = String(value);
    super.setItem(key, text);
    this.write(() => this.backend.set(key, text));
  }

  override removeItem(key: string) {
    super.removeItem(key);
    this.write(() => this.backend.remove(key));
  }

  flush() {
    return this.queue;
  }

  private write(operation: () => Promise<void>) {
    this.queue = this.queue.then(operation).then(
      () => {
        if (writeError !== null) {
          writeError = null;
          notify();
        }
      },
      (error: unknown) => {
        writeError = message(error);
        notify();
      },
    );
  }
}

function desktopBackend(): ProtectedBackend | null {
  let desktop = false;
  try {
    desktop = isTauri() || "__TAURI_INTERNALS__" in window;
  } catch {
    desktop = false;
  }
  if (!desktop) return null;
  // Session ids travel in a request header; encoding keeps any id header-safe, and every call
  // names a capture by the same encoded id.
  const audioName = (sessionId: string) => encodeURIComponent(sessionId);
  return {
    open: () => invoke<ProtectedOpened>("protected_storage_open"),
    migrate: (entries) => invoke("protected_storage_migrate", { entries }),
    set: (key, value) => invoke("protected_storage_set", { key, value }),
    remove: (key) => invoke("protected_storage_remove", { key }),
    audio: {
      put: (audio: KeptSessionAudio) =>
        invoke("protected_audio_put", encodeSessionAudio(audio), {
          headers: { "x-vox-session": audioName(audio.sessionId) },
        }),
      async get(sessionId) {
        const bytes = await invoke<ArrayBuffer>("protected_audio_get", {
          sessionId: audioName(sessionId),
        });
        return bytes.byteLength ? decodeSessionAudio(new Uint8Array(bytes)) : null;
      },
      delete: (sessionId) => invoke("protected_audio_delete", { sessionId: audioName(sessionId) }),
      retain: (sessionIds) =>
        invoke("protected_audio_retain", { sessionIds: sessionIds.map(audioName) }),
    },
  };
}
