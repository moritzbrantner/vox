// Raw capture a user chose to keep with one saved session, for review on this device only
// (owner decision on vox#23: per-session opt-in; removed by delete, replaced by restore, not in
// backups). The samples are the app's input exactly as captured, in IndexedDB, keyed by session.
import type { CaptureInterval } from "@stutter-tracker/shared";

export type KeptSessionAudio = {
  sessionId: string;
  sampleRate: number;
  samples: Float32Array;
  /** Session-clock seconds at which the capture's first sample was taken. */
  startOffsetSeconds: number;
  /** Session-clock intervals without samples (see `RecordingDescriptor.discontinuities`). */
  discontinuities: CaptureInterval[];
  /** Capture seconds dropped before `samples[0]` (the browser engine keeps a rolling window). */
  droppedSeconds: number;
  /** `audioFingerprint` of `samples`. */
  audioId: string;
  keptAt: string;
};

const DATABASE = "vox-session-audio";
const STORE = "captures";

export async function putSessionAudio(audio: KeptSessionAudio): Promise<void> {
  await withStore("readwrite", (store) => store.put(audio, audio.sessionId));
}

export async function getSessionAudio(sessionId: string): Promise<KeptSessionAudio | null> {
  if (!hasIndexedDb()) return null;
  return (await withStore("readonly", (store) => store.get(sessionId))) ?? null;
}

export async function deleteSessionAudio(sessionId: string): Promise<void> {
  if (!hasIndexedDb()) return;
  await withStore("readwrite", (store) => store.delete(sessionId));
}

/** Removes kept audio of every session not in `sessionIds` (deleted, dropped or restored away). */
export async function retainSessionAudio(sessionIds: string[]): Promise<void> {
  if (!hasIndexedDb()) return;
  const keep = new Set(sessionIds);
  const keys = (await withStore("readonly", (store) => store.getAllKeys())) as string[];
  const stale = keys.filter((key) => !keep.has(key));
  if (!stale.length) return;
  await withStore("readwrite", (store) => {
    let last: IDBRequest | undefined;
    for (const key of stale) last = store.delete(key);
    return last!;
  });
}

/**
 * Index into `samples` of a session-clock time, or null when the capture has no sample there
 * (before it, inside a gap, dropped from the rolling window, or after it).
 */
export function sampleIndexAt(audio: KeptSessionAudio, clockSeconds: number): number | null {
  let captureSeconds = clockSeconds - audio.startOffsetSeconds;
  if (captureSeconds < 0) return null;
  for (const gap of audio.discontinuities) {
    if (gap.startSeconds >= clockSeconds) continue;
    if (gap.endSeconds > clockSeconds) return null;
    captureSeconds -= gap.endSeconds - gap.startSeconds;
  }
  const index = Math.round((captureSeconds - audio.droppedSeconds) * audio.sampleRate);
  return index >= 0 && index < audio.samples.length ? index : null;
}

/** Session-clock time of a sample index (inverse of `sampleIndexAt`). */
export function clockSecondsAt(audio: KeptSessionAudio, index: number): number {
  let clock = audio.startOffsetSeconds + audio.droppedSeconds + index / audio.sampleRate;
  const gaps = [...audio.discontinuities].sort((a, b) => a.startSeconds - b.startSeconds);
  for (const gap of gaps) {
    if (gap.startSeconds <= clock) clock += gap.endSeconds - gap.startSeconds;
  }
  return clock;
}

function hasIndexedDb() {
  return typeof indexedDB !== "undefined";
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) {
    return Promise.reject(new Error("this browser has no IndexedDB storage"));
  }
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      const database = request.result;
      // Another window upgrading or deleting the database closes this connection.
      database.onversionchange = () => {
        database.close();
        opening = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error("audio storage could not be opened"));
    };
  });
  return opening;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    // Resolved on commit, so a write is durable before the caller reports it kept.
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("audio storage aborted"));
  });
}

/** Test hook: forget the cached connection (e.g. after the database was deleted). */
export function resetSessionAudioConnection() {
  opening = null;
}
