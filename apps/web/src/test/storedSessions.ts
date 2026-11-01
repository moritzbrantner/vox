// What the saved session list holds in storage, read the way the app stores it (vox#157): the id
// list under STORE_KEY, each session under its own key. Null when nothing was ever stored.
import { STORE_KEY, sessionKey } from "../storage/localStorage";
import type { SavedSession } from "../types";

export function storedSessions(storage: Storage = localStorage): SavedSession[] | null {
  const raw = storage.getItem(STORE_KEY);
  if (raw === null) return null;
  return (JSON.parse(raw) as unknown[]).map((entry) =>
    typeof entry === "string"
      ? (JSON.parse(storage.getItem(sessionKey(entry)) ?? "null") as SavedSession)
      : (entry as SavedSession),
  );
}

/** Everything the saved session list consists of, to compare before and after a change. */
export function storedSessionsSnapshot(storage: Storage = localStorage): string | null {
  const raw = storage.getItem(STORE_KEY);
  return raw === null ? null : JSON.stringify(storedSessions(storage));
}
