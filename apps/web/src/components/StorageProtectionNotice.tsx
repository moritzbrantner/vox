import { LockKeyhole, ShieldAlert } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
  type StorageProtection,
  storageProtection,
  storageWriteError,
  subscribeStorageProtection,
} from "../storage/protectedStorage";
import { cx } from "./styles";

const EXPORTS_NOTE =
  "Exports and backups you download are ordinary files outside this protection; use a backup passphrase for those.";

/**
 * Says what local storage protects on this platform and what it does not (vox#85,
 * docs/protected-storage.md). Shown on every start; never claims more than the platform gives.
 */
export function StorageProtectionNotice() {
  const protection = useSyncExternalStore(subscribeStorageProtection, storageProtection);
  const writeError = useSyncExternalStore(subscribeStorageProtection, storageWriteError);
  const { tone, title, detail } = describe(protection);
  return (
    <section
      aria-label="Local data protection"
      className={cx(
        "mb-4 flex items-start gap-3 rounded-lg border p-3 text-sm",
        tone === "ok" && "border-[#cfe0d7] bg-[#f1f7f3] text-[#1d4f40]",
        tone === "warn" && "border-[#e3c9a8] bg-[#fbf3e8] text-[#7a4a12]",
        tone === "error" && "border-[#e2b4b4] bg-[#fbeeee] text-[#7c2323]",
      )}
    >
      {tone === "ok" ? (
        <LockKeyhole size={18} aria-hidden />
      ) : (
        <ShieldAlert size={18} aria-hidden />
      )}
      <div>
        <p className="m-0 font-semibold">{title}</p>
        <p className="m-0">{detail}</p>
        {protection.kind === "protected" && protection.warning && (
          <p className="m-0">{protection.warning}</p>
        )}
        {writeError && (
          <p role="alert" className="m-0 font-semibold">
            A change could not be saved to protected storage: {writeError}
          </p>
        )}
      </div>
    </section>
  );
}

function describe(protection: StorageProtection): {
  tone: "ok" | "warn" | "error";
  title: string;
  detail: string;
} {
  switch (protection.kind) {
    case "protected":
      return {
        tone: "ok",
        title: "Local data is encrypted on this device",
        detail: `Sessions, voiceprints, settings, interrupted-capture checkpoints and kept audio are encrypted with a key held in the ${protection.mechanism}. This protects copies of the app's files (backups of your disk, other user accounts, a lost drive) but not someone using your unlocked account. ${EXPORTS_NOTE}`,
      };
    case "unprotected":
      return {
        tone: "warn",
        title: "Local data is not encrypted",
        detail: `Protected storage is unavailable (${protection.reason}), so sessions and voiceprints are kept unencrypted in this user's app data, as before. ${EXPORTS_NOTE}`,
      };
    case "locked":
      return {
        tone: "error",
        title: "Protected storage is locked",
        detail: `Your stored data could not be opened (${protection.reason}). It was left untouched; nothing you record now is saved. Unlock the keychain and restart the app.`,
      };
    case "browser":
      return {
        tone: "warn",
        title: "Local data is not encrypted in a browser",
        detail: `Sessions, voiceprints and settings are kept in this browser profile's storage, which browsers do not encrypt: anyone with access to this profile or its files can read them. The desktop app encrypts them with the system keychain. ${EXPORTS_NOTE}`,
      };
  }
}
