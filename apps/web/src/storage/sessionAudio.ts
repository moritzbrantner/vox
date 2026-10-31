// Raw capture a user chose to keep with one saved session, for review on this device only
// (owner decision on vox#23: per-session opt-in; removed by delete, replaced by restore, not in
// backups). The samples are the app's input exactly as captured, keyed by session: in IndexedDB
// in a browser, in protected storage in the desktop app (see protectedStorage.ts).
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

/** Where kept audio lives when it is not in this browser's IndexedDB (desktop protected storage). */
export type SessionAudioStore = {
  put(audio: KeptSessionAudio): Promise<void>;
  get(sessionId: string): Promise<KeptSessionAudio | null>;
  delete(sessionId: string): Promise<void>;
  retain(sessionIds: string[]): Promise<void>;
};

let audioStore: SessionAudioStore | null = null;

/** Routes kept audio to `store`; null returns it to IndexedDB. Set once at startup. */
export function setSessionAudioStore(store: SessionAudioStore | null) {
  audioStore = store;
}

export async function putSessionAudio(audio: KeptSessionAudio): Promise<void> {
  if (audioStore) return audioStore.put(audio);
  await withStore("readwrite", (store) => store.put(audio, audio.sessionId));
}

export async function getSessionAudio(sessionId: string): Promise<KeptSessionAudio | null> {
  if (audioStore) return audioStore.get(sessionId);
  if (!hasIndexedDb()) return null;
  return (await withStore("readonly", (store) => store.get(sessionId))) ?? null;
}

export async function deleteSessionAudio(sessionId: string): Promise<void> {
  if (audioStore) return audioStore.delete(sessionId);
  if (!hasIndexedDb()) return;
  await withStore("readwrite", (store) => store.delete(sessionId));
}

/**
 * Moves every capture kept in IndexedDB into `target`, one at a time: each is removed from
 * IndexedDB only after `target` stored it, so an interrupted or failed move loses nothing and the
 * next start resumes it.
 */
export async function moveIndexedDbAudio(target: SessionAudioStore): Promise<void> {
  if (!hasIndexedDb()) return;
  const keys = (await withStore("readonly", (store) => store.getAllKeys())) as string[];
  for (const key of keys) {
    const audio = (await withStore("readonly", (store) => store.get(key))) as
      | KeptSessionAudio
      | undefined;
    if (audio) await target.put(audio);
    await withStore("readwrite", (store) => store.delete(key));
  }
}

/**
 * One kept capture as bytes: a little-endian u32 header length, the JSON header (every field but
 * the samples) padded to four bytes, then the samples as little-endian float32.
 */
export function encodeSessionAudio(audio: KeptSessionAudio): Uint8Array {
  const { samples, ...header } = audio;
  const json = new TextEncoder().encode(JSON.stringify(header));
  const headerBytes = Math.ceil((4 + json.length) / 4) * 4;
  const bytes = new Uint8Array(headerBytes + samples.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, json.length, true);
  bytes.set(json, 4);
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(headerBytes + index * 4, samples[index], true);
  }
  return bytes;
}

export function decodeSessionAudio(bytes: Uint8Array): KeptSessionAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as Omit<
    KeptSessionAudio,
    "samples"
  >;
  const headerBytes = Math.ceil((4 + length) / 4) * 4;
  const samples = new Float32Array((bytes.byteLength - headerBytes) / 4);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getFloat32(headerBytes + index * 4, true);
  }
  return { ...header, samples };
}

/** Removes kept audio of every session not in `sessionIds` (deleted, dropped or restored away). */
export async function retainSessionAudio(sessionIds: string[]): Promise<void> {
  if (audioStore) return audioStore.retain(sessionIds);
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
