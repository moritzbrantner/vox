import { Download } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { buttonClass, controlClass, mutedTextClass, primaryButtonClass } from "./styles";

const alertClass =
  "m-0 mb-3 rounded-md border border-[#e3c9a8] bg-[#fbf3e8] p-3 text-sm text-[#7a4a12]";

/** Session export with an optional passphrase; `onDownload(null)` means a plain backup. */
export function ExportBackupDialog({
  onClose,
  onDownload,
}: {
  onClose: () => void;
  onDownload: (passphrase: string | null) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passphrase !== confirmation) {
      setError("The passphrases do not match.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onDownload(passphrase || null);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export the backup.");
      setBusy(false);
    }
  }

  const close = () => {
    if (!busy) {
      onClose();
    }
  };

  return (
    <ModalDialog title="Export sessions" onClose={close}>
      <form onSubmit={(event) => void submit(event)}>
        <p className={`m-0 mb-3 text-sm ${mutedTextClass}`}>
          Optionally protect the backup with a passphrase. Leave both fields empty for an
          unencrypted file.
        </p>
        <p className={alertClass}>
          The passphrase is not stored anywhere. If you lose it, an encrypted backup cannot be
          restored.
        </p>
        <label className="mb-3 grid gap-1 text-sm">
          Backup passphrase
          <input
            className={controlClass}
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            disabled={busy}
          />
        </label>
        <label className="mb-3 grid gap-1 text-sm">
          Confirm backup passphrase
          <input
            className={controlClass}
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
          />
        </label>
        {error && (
          <p className={alertClass} role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" className={buttonClass} onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={busy} aria-busy={busy}>
            <Download size={17} />
            Download backup
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
