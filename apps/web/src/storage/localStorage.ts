import {
  type ConsentLedger,
  EMPTY_CONSENT_LEDGER,
  hasConsent,
  parseConsentLedger,
  recordConsent,
  withdrawOtherScopes,
} from "@stutter-tracker/shared";
import type {
  SavedSession,
  SpeakerProfile,
  TranscriptionEngine,
  TranscriptionSettings,
  Voiceprint,
} from "../types";
import { parseStoredSession } from "./sessionBackup";
import { appStorage } from "./protectedStorage";

/** The saved sessions' ids, newest first; each session is stored under `sessionKey(id)`. */
export const STORE_KEY = "stutter-tracker:sessions";
export const SESSION_KEY_PREFIX = "stutter-tracker:session:";
/** Stored sessions this build cannot read; kept so a later save does not drop them. */
export const UNREADABLE_SESSIONS_KEY = "stutter-tracker:sessions:unreadable";
export const VOICE_KEY = "stutter-tracker:voiceprint";
export const SPEAKERS_KEY = "stutter-tracker:speakers";
export const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
/** Pre-ledger storage: the one server URL that had remote-analysis consent. Migrated on read. */
export const REMOTE_CONSENT_KEY = "stutter-tracker:remote-analysis-consent";
export const SOLO_SPEAKER_KEY = "stutter-tracker:solo-speaker";
export const CONSENT_LEDGER_KEY = "stutter-tracker:consent-ledger";
export const UNREADABLE_CONSENT_LEDGER_KEY = "stutter-tracker:consent-ledger:unreadable";

/** Loads the consent ledger, folding in a legacy remote-analysis grant once. */
export function loadConsentLedger(storage: Storage = appStorage()): ConsentLedger {
  let ledger: ConsentLedger | null;
  const raw = storage.getItem(CONSENT_LEDGER_KEY);
  try {
    ledger = parseConsentLedger(JSON.parse(raw ?? "[]"));
  } catch {
    ledger = null;
  }
  if (!ledger) {
    // Unreadable means no consent. Keep the raw value so the next write cannot erase it.
    try {
      if (raw && !storage.getItem(UNREADABLE_CONSENT_LEDGER_KEY)) {
        storage.setItem(UNREADABLE_CONSENT_LEDGER_KEY, raw);
      }
    } catch {
      // Storage unavailable.
    }
    // A legacy grant must not be revived on top of a ledger whose later decisions are unknown,
    // now or after the next write replaces the corrupt ledger, so it is retired here.
    try {
      storage.removeItem(REMOTE_CONSENT_KEY);
    } catch {
      // Storage unavailable.
    }
    return EMPTY_CONSENT_LEDGER;
  }
  try {
    const legacyUrl = storage.getItem(REMOTE_CONSENT_KEY);
    if (legacyUrl) {
      // The legacy key is only trusted while the ledger holds no remote-analysis decision at all;
      // otherwise the ledger is authoritative and the legacy grant is dropped, never added beside
      // another server's grant.
      const ledgerDecides = ledger.some((entry) => entry.purpose === "remoteAnalysis");
      if (!ledgerDecides && isHttpUrl(legacyUrl)) {
        ledger = recordConsent(ledger, {
          purpose: "remoteAnalysis",
          granted: true,
          scope: legacyUrl,
        });
        storage.setItem(CONSENT_LEDGER_KEY, JSON.stringify(ledger));
      }
      storage.removeItem(REMOTE_CONSENT_KEY);
    }
  } catch {
    // Storage unavailable: the legacy grant stays where it was and is retried next load.
  }
  return ledger;
}

export function recordConsentDecision(
  decision: Parameters<typeof recordConsent>[1],
  storage: Storage = appStorage(),
) {
  const ledger = recordConsent(loadConsentLedger(storage), decision);
  storage.setItem(CONSENT_LEDGER_KEY, JSON.stringify(ledger));
  return ledger;
}

/** Remote-analysis consent is bound to one server URL; another URL needs consent again. */
export function loadRemoteConsent(serverUrl: string, storage: Storage = appStorage()) {
  try {
    return (
      Boolean(serverUrl) && hasConsent(loadConsentLedger(storage), "remoteAnalysis", serverUrl)
    );
  } catch {
    return false;
  }
}

export function saveRemoteConsent(
  serverUrl: string,
  granted: boolean,
  storage: Storage = appStorage(),
) {
  let ledger = loadConsentLedger(storage);
  if (granted) {
    // Consent covers one server at a time; returning to an earlier server needs consent again.
    ledger = withdrawOtherScopes(ledger, "remoteAnalysis", serverUrl);
  }
  ledger = recordConsent(ledger, { purpose: "remoteAnalysis", granted, scope: serverUrl });
  try {
    storage.setItem(CONSENT_LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // Appending can fail when storage is full. Any decision that cannot be stored (a withdrawal,
    // or a grant that also withdraws another server) falls back to dropping the ledger: no grants
    // at all, which needs no quota.
    try {
      storage.removeItem(CONSENT_LEDGER_KEY);
      storage.removeItem(REMOTE_CONSENT_KEY);
    } catch {
      // Storage unavailable: reading it fails too, which also means no consent.
    }
  }
}

/** The storage key of one saved session's own value. */
export function sessionKey(id: string) {
  return `${SESSION_KEY_PREFIX}${id}`;
}

type ParsedSession = { raw: string; session: SavedSession };

// Per storage, each session value as last read or written and the session parsed from it
// (PRINCIPLE-008): an unchanged value is not parsed again on load, and a session object that is
// what its value holds is not serialized or written again on save.
const parsedSessions = new WeakMap<Storage, Map<string, ParsedSession>>();

function parsedCache(storage: Storage) {
  let cache = parsedSessions.get(storage);
  if (!cache) {
    cache = new Map();
    parsedSessions.set(storage, cache);
  }
  return cache;
}

/** Reads one session value, reusing its parse while the stored value is unchanged. */
function readStoredSession(
  storage: Storage,
  key: string,
  raw: string,
): { session: SavedSession } | { unreadable: unknown } {
  const cache = parsedCache(storage);
  const cached = cache.get(key);
  if (cached?.raw === raw) {
    return { session: cached.session };
  }
  cache.delete(key);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { unreadable: { unreadableSession: raw } };
  }
  let session: SavedSession | null;
  try {
    session = parseStoredSession(value);
  } catch {
    session = null;
  }
  if (!session) {
    return { unreadable: value };
  }
  cache.set(key, { raw, session });
  return { session };
}

/**
 * Loads saved sessions, migrating legacy records to the canonical schema. Entries this build
 * cannot read are kept under UNREADABLE_SESSIONS_KEY and retried on every load, so a later build
 * that can read them restores them.
 *
 * STORE_KEY holds the saved sessions' ids, newest first; each session is its own value under
 * `sessionKey(id)`, so a save writes that session and the id list only (vox#157). Session records
 * still inline in the list (earlier builds) are moved into their own values on load.
 */
export function loadSessionsFromStorage(storage: Storage = appStorage()): SavedSession[] {
  const quarantined = readJsonArray(storage, UNREADABLE_SESSIONS_KEY);
  const sessions: SavedSession[] = [];
  const ids = new Set<string>();
  const unreadable: unknown[] = [];
  let recovered = false;
  let stored = readJsonArray(storage, STORE_KEY);
  if (!stored) {
    // A corrupt primary store must not hide recoverable quarantined sessions. Its raw value is
    // kept in quarantine so the rewrite below cannot lose it.
    const raw = readRaw(storage, STORE_KEY);
    if (raw !== null) {
      unreadable.push({ unreadableStore: raw });
      recovered = true;
    }
    stored = [];
  }
  for (const [candidate, fromQuarantine] of [
    ...stored.map((entry) => [entry, false] as const),
    ...(quarantined ?? []).map((entry) => [entry, true] as const),
  ]) {
    let session: SavedSession | null = null;
    if (typeof candidate === "string" && !fromQuarantine) {
      const raw = readRaw(storage, sessionKey(candidate));
      if (raw === null) {
        // Listed but gone: the list is rewritten without it.
        recovered = true;
        continue;
      }
      const read = readStoredSession(storage, sessionKey(candidate), raw);
      if ("unreadable" in read) {
        unreadable.push(read.unreadable);
        recovered = true;
        continue;
      }
      session = read.session;
      recovered ||= session.id !== candidate;
    } else {
      try {
        session = parseStoredSession(candidate);
      } catch {
        session = null;
      }
      // An inline record is moved into its own value.
      recovered ||= Boolean(session);
    }
    if (!session) {
      unreadable.push(candidate);
    } else if (!ids.has(session.id)) {
      ids.add(session.id);
      sessions.push(session);
    } else {
      // A readable duplicate of a visible session is dropped; kept, it would reappear after that
      // session is deleted.
      recovered = true;
    }
  }
  try {
    if (recovered) {
      writeSessions(sessions, storage);
    }
    // Written only when it changes; an unreadable quarantine is left as it is unless there is
    // something new to keep.
    const quarantine = JSON.stringify(dedupe(unreadable));
    if (
      (quarantined !== null || unreadable.length > 0) &&
      quarantine !== (readRaw(storage, UNREADABLE_SESSIONS_KEY) ?? "[]")
    ) {
      storage.setItem(UNREADABLE_SESSIONS_KEY, quarantine);
    }
  } catch {
    // Storage full or unavailable: entries stay where they are until the next load.
  }
  return sessions;
}

/**
 * Stores exactly `next`, newest first: the value of each session that changed, the id list, and
 * the removal of sessions no longer listed. A session object read or written through here is
 * known to match its stored value and is not written again, so a save writes the saved session
 * and the id list only. A failed write puts back the values it replaced and throws.
 */
function writeSessions(next: SavedSession[], storage: Storage) {
  const cache = parsedCache(storage);
  const previousIds = (readJsonArray(storage, STORE_KEY) ?? []).filter(
    (entry): entry is string => typeof entry === "string",
  );
  const written: Array<[key: string, before: string | null]> = [];
  try {
    for (const session of next) {
      const key = sessionKey(session.id);
      if (cache.get(key)?.session === session) continue;
      const raw = JSON.stringify(session);
      const before = storage.getItem(key);
      if (before !== raw) {
        storage.setItem(key, raw);
        written.push([key, before]);
      }
      cache.set(key, { raw, session });
    }
    const index = JSON.stringify(next.map((session) => session.id));
    if (storage.getItem(STORE_KEY) !== index) {
      storage.setItem(STORE_KEY, index);
    }
  } catch (error) {
    for (const [key, before] of written.reverse()) {
      cache.delete(key);
      try {
        if (before === null) storage.removeItem(key);
        else storage.setItem(key, before);
      } catch {
        // Unavailable; the list still names only what it named before.
      }
    }
    throw error;
  }
  const kept = new Set(next.map((session) => session.id));
  for (const id of previousIds) {
    if (!kept.has(id)) {
      cache.delete(sessionKey(id));
      try {
        storage.removeItem(sessionKey(id));
      } catch {
        // Left behind unlisted; it is never read again.
      }
    }
  }
}

function readRaw(storage: Storage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function readJsonArray(storage: Storage, key: string): unknown[] | null {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function dedupe(entries: unknown[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = JSON.stringify(entry);
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

/** A restore replaces everything, including quarantined entries it was meant to remove. */
export function replaceStoredSessions(sessions: SavedSession[], storage: Storage = appStorage()) {
  writeSessions(sessions, storage);
  storage.removeItem(UNREADABLE_SESSIONS_KEY);
}

/** Stores `sessions` as the saved list; only sessions that changed are written. */
export function saveSessionsToStorage(sessions: SavedSession[], storage: Storage = appStorage()) {
  writeSessions(sessions, storage);
}

export function loadSpeakerProfilesFromStorage(storage: Storage = appStorage()): SpeakerProfile[] {
  try {
    const speakers = JSON.parse(storage.getItem(SPEAKERS_KEY) ?? "[]") as SpeakerProfile[];
    if (Array.isArray(speakers) && speakers.length > 0) {
      return normalizeSpeakerProfiles(speakers);
    }
    const legacy = JSON.parse(storage.getItem(VOICE_KEY) ?? "null") as Voiceprint | null;
    if (legacy?.embedding?.length) {
      return [
        {
          id: "legacy-speaker",
          label: "Enrolled speaker",
          embeddings: [legacy.embedding],
          sampleRate: legacy.sampleRate,
          sampleCount: legacy.sampleCount,
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
}

export function saveSpeakerProfilesToStorage(
  speakers: SpeakerProfile[],
  storage: Storage = appStorage(),
) {
  const normalized = normalizeSpeakerProfiles(speakers);
  storage.setItem(SPEAKERS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function loadTranscriptionSettingsFromStorage(
  engines: TranscriptionEngine[],
  storage: Storage = appStorage(),
): TranscriptionSettings {
  try {
    const parsed = JSON.parse(
      storage.getItem(TRANSCRIPTION_KEY) ?? "null",
    ) as Partial<TranscriptionSettings> | null;
    const engine = engines.find((item) => item.id === parsed?.engine) ?? engines[0];
    const model = engine.models.includes(parsed?.model ?? "")
      ? (parsed?.model ?? engine.models[0])
      : engine.models[0];
    return { engine: engine.id, model, device: parsed?.device === "cpu" ? "cpu" : "auto" };
  } catch {
    return { engine: engines[0].id, model: engines[0].models[0], device: "auto" };
  }
}

export function saveTranscriptionSettingsToStorage(
  settings: TranscriptionSettings,
  storage: Storage = appStorage(),
) {
  storage.setItem(TRANSCRIPTION_KEY, JSON.stringify(settings));
}

/** The user's standing "only I speak in my recordings" declaration; unset means not declared. */
export function loadSoloSpeakerDeclaration(storage: Storage = appStorage()): boolean {
  try {
    return storage.getItem(SOLO_SPEAKER_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveSoloSpeakerDeclaration(declared: boolean, storage: Storage = appStorage()) {
  try {
    if (declared) storage.setItem(SOLO_SPEAKER_KEY, "true");
    else storage.removeItem(SOLO_SPEAKER_KEY);
  } catch {
    // The declaration still applies for this page; it is only not remembered.
  }
}

export function normalizeSpeakerProfiles(speakers: SpeakerProfile[]) {
  return speakers.filter(
    (speaker) =>
      typeof speaker.id === "string" &&
      speaker.id.trim().length > 0 &&
      typeof speaker.label === "string" &&
      speaker.label.trim().length > 0 &&
      Array.isArray(speaker.embeddings) &&
      speaker.embeddings.length > 0,
  );
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
