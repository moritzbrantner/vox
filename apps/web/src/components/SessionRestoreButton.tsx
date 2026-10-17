import { Upload } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { decryptBackup, isEncryptedBackup } from "../storage/encryptedBackup";
import { parseSessionBackup } from "../storage/sessionBackup";
import type { SavedSession } from "../types";
import { ModalDialog } from "./ModalDialog";
import { buttonClass, controlClass, mutedTextClass, primaryButtonClass } from "./styles";

function sessionsLabel(count: number) {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

/** Restore replaces every saved session with the backup (owner decision, vox#86 (a)). */
export function restoreConfirmation(currentCount: number, backupCount: number) {
  const current = `${currentCount} current saved ${currentCount === 1 ? "session" : "sessions"}`;
  return `Replace all ${current} with ${sessionsLabel(backupCount)} from this backup? The ${current.replace(" saved", "")} will be lost, and so will any audio kept for review: backups do not contain audio.`;
}

export function SessionRestoreButton({
  disabled = false,
  currentSessionCount,
  onRestore,
}: {
  disabled?: boolean;
  currentSessionCount: number;
  onRestore: (sessions: SavedSession[]) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [encrypted, setEncrypted] = useState<unknown>(null);

  async function restoreFile(file: File) {
    try {
      const backup: unknown = JSON.parse(await file.text());
      if (isEncryptedBackup(backup)) {
        setEncrypted(backup);
        return;
      }
      await replaceWith(parseSessionBackup(backup));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this backup.");
    }
  }

  /** Decrypts and validates the whole backup; nothing is confirmed or changed before both pass. */
  async function decrypt(passphrase: string) {
    const plaintext = await decryptBackup(encrypted, passphrase);
    let backup: unknown;
    try {
      backup = JSON.parse(plaintext);
    } catch {
      // The parser's message would quote decrypted content.
      throw new Error("The decrypted backup is not valid JSON.");
    }
    const sessions = parseSessionBackup(backup);
    setEncrypted(null);
    try {
      await replaceWith(sessions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this backup.");
    }
  }

  async function replaceWith(sessions: SavedSession[]) {
    if (!window.confirm(restoreConfirmation(currentSessionCount, sessions.length))) {
      return;
    }
    await onRestore(sessions);
    window.location.reload();
  }

  return (
    <>
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept=".json,application/json"
        aria-label="Choose session backup"
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            setError(null);
            void restoreFile(file);
          }
        }}
      />
      <button
        className={buttonClass}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title={
          disabled ? "Finish or clear the current session before restoring sessions" : undefined
        }
      >
        <Upload size={17} />
        Restore sessions
      </button>
      {encrypted != null && (
        <DecryptBackupDialog onClose={() => setEncrypted(null)} onDecrypt={decrypt} />
      )}
      {error && (
        <span className={`self-center text-sm ${mutedTextClass}`} role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function DecryptBackupDialog({
  onClose,
  onDecrypt,
}: {
  onClose: () => void;
  onDecrypt: (passphrase: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onDecrypt(passphrase);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not decrypt this backup.");
      setBusy(false);
    }
  }

  const close = () => {
    if (!busy) {
      onClose();
    }
  };

  return (
    <ModalDialog title="Restore encrypted backup" onClose={close}>
      <form onSubmit={(event) => void submit(event)}>
        <p className={`m-0 mb-3 text-sm ${mutedTextClass}`}>
          This backup is encrypted. Enter its passphrase; nothing is replaced until it has been
          decrypted and checked.
        </p>
        <label className="mb-3 grid gap-1 text-sm">
          Backup passphrase
          <input
            className={controlClass}
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            disabled={busy}
          />
        </label>
        {error && (
          <p
            className="m-0 mb-3 rounded-md border border-[#e3c9a8] bg-[#fbf3e8] p-3 text-sm text-[#7a4a12]"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" className={buttonClass} onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className={primaryButtonClass}
            disabled={busy || passphrase.length === 0}
            aria-busy={busy}
          >
            Decrypt backup
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
