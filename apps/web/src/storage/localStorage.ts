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

export const STORE_KEY = "stutter-tracker:sessions";
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
export function loadConsentLedger(storage: Storage = localStorage): ConsentLedger {
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
  storage: Storage = localStorage,
) {
  const ledger = recordConsent(loadConsentLedger(storage), decision);
  storage.setItem(CONSENT_LEDGER_KEY, JSON.stringify(ledger));
  return ledger;
}

/** Remote-analysis consent is bound to one server URL; another URL needs consent again. */
export function loadRemoteConsent(serverUrl: string, storage: Storage = localStorage) {
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
  storage: Storage = localStorage,
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

/**
 * Loads saved sessions, migrating legacy records to the canonical schema. Entries this build
 * cannot read are kept under UNREADABLE_SESSIONS_KEY and retried on every load, so a later build
 * that can read them restores them.
 */
export function loadSessionsFromStorage(storage: Storage = localStorage): SavedSession[] {
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
    let session: SavedSession | null;
    try {
      session = parseStoredSession(candidate);
    } catch {
      session = null;
    }
    if (!session) {
      unreadable.push(candidate);
    } else if (!ids.has(session.id)) {
      ids.add(session.id);
      sessions.push(session);
      recovered ||= fromQuarantine;
    } else {
      // A readable duplicate of a visible session is dropped; kept, it would reappear after that
      // session is deleted.
      recovered = true;
    }
  }
  if (unreadable.length || recovered) {
    try {
      if (recovered) {
        storage.setItem(STORE_KEY, JSON.stringify(sessions));
      }
      storage.setItem(UNREADABLE_SESSIONS_KEY, JSON.stringify(dedupe(unreadable)));
    } catch {
      // Storage full or unavailable: entries stay where they are until the next load.
    }
  }
  return sessions;
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
export function replaceStoredSessions(sessions: SavedSession[], storage: Storage = localStorage) {
  storage.setItem(STORE_KEY, JSON.stringify(sessions));
  storage.removeItem(UNREADABLE_SESSIONS_KEY);
}

export function saveSessionsToStorage(sessions: SavedSession[], storage: Storage = localStorage) {
  storage.setItem(STORE_KEY, JSON.stringify(sessions));
}

export function loadSpeakerProfilesFromStorage(storage: Storage = localStorage): SpeakerProfile[] {
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
  storage: Storage = localStorage,
) {
  const normalized = normalizeSpeakerProfiles(speakers);
  storage.setItem(SPEAKERS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function loadTranscriptionSettingsFromStorage(
  engines: TranscriptionEngine[],
  storage: Storage = localStorage,
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
  storage: Storage = localStorage,
) {
  storage.setItem(TRANSCRIPTION_KEY, JSON.stringify(settings));
}

/** The user's standing "only I speak in my recordings" declaration; unset means not declared. */
export function loadSoloSpeakerDeclaration(storage: Storage = localStorage): boolean {
  try {
    return storage.getItem(SOLO_SPEAKER_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveSoloSpeakerDeclaration(declared: boolean, storage: Storage = localStorage) {
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
