# Protected local storage: threat review

Vox keeps sensitive speech data on the device: saved sessions (transcripts, analyses, annotations,
capture descriptors), voiceprints and speaker profiles, settings and the consent ledger,
checkpoints of interrupted captures, the speech corpus and, when the user opts in, kept raw audio.
This document states what each platform protects against and what it does not (vox#85). The app
shows the same disclosure on every start (`StorageProtectionNotice`) and never claims more than its
platform gives.

No cryptography is invented here. The desktop app uses a vetted AEAD (XChaCha20-Poly1305 from
RustCrypto's `chacha20poly1305`) and the operating system's credential store (through the
`keyring` crate). Browser storage is described as unencrypted, because it is.

## Desktop app (Tauri: macOS, Windows, Linux)

**Mechanism.** On first start the app creates a random 256-bit data key and stores it in the
platform credential store: macOS Keychain, Windows Credential Manager, or the Secret Service
keyring on Linux (GNOME Keyring, KWallet). The key is read back once before use, so a credential
store that drops writes never leaves data sealed under a lost key. The key never touches the disk.

Everything the app keeps locally is sealed with that key under
`<app data>/protected/` (`src-tauri/src/protected_store.rs`):

| Data | Where |
| --- | --- |
| Saved sessions, unreadable-session quarantine, speaker profiles, settings, consent ledger, auditory-feedback settings, interrupted-capture checkpoints | `protected/web/` (the web view's key/value storage) |
| Speech corpus, known speakers (Rust side) | `protected/documents/` |
| Kept session audio (opt-in) | `protected/audio/` |

Each file holds a random 24-byte nonce and the ciphertext of the entry's name plus its value; file
names are SHA-256 digests of entry names, so names such as session ids are not visible either. A
file that was changed, sealed under another key or renamed onto another entry is refused, never
partly read. Writes go to a sealed temporary file in the same directory, which is synced and renamed
into place: an interrupted write leaves the previous value, and no plain copy is written.

The web view keeps a decrypted copy in memory while the app runs, so its synchronous callers keep
working. Every change is written through in order. A write that fails keeps the change for this
session and shows "A change could not be saved to protected storage" in the app.

Transcription writes the capture to a temporary WAV for the native engine. That directory is
created readable only by the current user (mode 0700 on Unix; temp directories on Windows and macOS
are already per user) and removed when transcription ends.

**Protects against**

- Reading the app's files without the user's credential store: another user account on the
  computer, a copied or stolen disk or laptop that is turned off, disk images, cloud or Time
  Machine backups of the app data directory, and support bundles.
- Silent modification or substitution of stored entries (tampering is detected and the entry is
  refused).
- Session content leaking through plain temporary files during writes.

**Does not protect against**

- Anyone or anything running as the user while the credential store is unlocked: malware, a
  script, another app the keychain allows, or a person at the unlocked computer. On Linux, any
  process of the user can usually ask the Secret Service for the key.
- Memory inspection of the running app, and swap or hibernation files written by the OS.
- A credential store that is itself backed up or synced (for example iCloud Keychain): whoever can
  restore it can open the data.
- Files the user exports: backups (`stutter-tracker-export.json`), evidence exports, corpus JSON,
  annotation exchange files. These are ordinary files the user chose to create. A backup can be
  encrypted with a passphrase in the export dialog (PBKDF2 and AES-GCM via WebCrypto); evidence
  and exchange files are plain.
- Data sent to a remote compute server after the user granted consent for it.
- Loss of the key. If the credential store loses the entry, the protected data cannot be opened;
  keep a backup export.

**When the credential store is unavailable** (for example Linux without a Secret Service, or a
store that drops writes) and nothing has been protected yet, the app keeps working as earlier
builds did: unencrypted files in the user's app data directory and web view storage. The notice
says "Local data is not encrypted" and gives the reason.

**When protected data exists but the key cannot be read** (keychain locked, entry deleted, access
refused), the app is *locked*: it reads and writes nothing, leaves the sealed files untouched, does
not create a new key over the missing one, and says so. Unlock the keychain and restart.

### Migration of earlier plain data

Earlier builds kept the same data unencrypted: the web view's `localStorage` (`stutter-tracker:*`
keys), IndexedDB (`vox-session-audio`) and `speech-corpus.json` / `known-speakers.json` in the app
data directory. On the first start with a working credential store they are moved in:

1. Rust-side documents: each plain file is sealed into the store and the plain file is removed
   only after the sealed copy was written. A plain file that is still present is authoritative and
   moved again on the next start, so an interrupted or failed move never loses a write. If moving
   fails, the app keeps using the plain files for that run and shows why.
2. Web view storage: every `stutter-tracker:*` entry is written into the store, entries an earlier
   partial attempt left behind are removed, and a completion mark is written last. Only then are
   the plain entries removed. If the move fails, the plain entries stay intact and in use for that
   run ("Local data is not encrypted: moving existing data into protected storage failed"), and the
   next start repeats it. If the app stops after the mark but before every plain entry was removed,
   the next start removes the leftovers and uses the protected copy.
3. Kept audio: each capture is copied into the store and removed from IndexedDB only after the
   copy was stored. If that fails, the remaining captures stay in IndexedDB, are still found there,
   and the notice says kept audio is still unprotected; the next start resumes.

The fault tests for these paths are in `src-tauri/src/protected_store.rs` and
`apps/web/src/storage/protectedStorage.test.ts`.

## Browser (the web app)

**Mechanism.** Data is kept in the browser profile's `localStorage` and IndexedDB. Browsers do not
encrypt these; the app does not either, and does not invent a key system on top. (A key the page
could read would sit beside the data it protects.)

**Protects against.** Other websites (same-origin policy). Whatever the operating system's disk
encryption (FileVault, BitLocker, LUKS) gives when the device is off.

**Does not protect against.** Anyone with access to the browser profile or its files, browser
extensions with access to the site, other users of a shared profile, profile sync or backups,
and the browser clearing site data (which deletes it). The notice says "Local data is not
encrypted in a browser". Use the desktop app for keychain-protected storage, and export backups.

## Mobile app (Expo: iOS, Android)

**Mechanism.** The mobile app keeps no sessions, voiceprints or settings between launches: the
consent ledger, API token and results live only in memory for the app session. A recording is
written by the OS recorder into the app's private cache directory, uploaded for transcription and
then deleted (also when the recording is cancelled).

**Protects against.** Other apps (app sandbox). On a locked or turned-off device, the platform's
file encryption: iOS Data Protection (by default until the first unlock after boot) and Android
file-based encryption of app-private storage.

**Does not protect against.** Someone using the unlocked device, a compromised or rooted device,
and data sent to the compute server. If the mobile app ever keeps sessions or secrets, they belong
in the platform keystore (iOS Keychain, Android Keystore, for example through `expo-secure-store`
for keys) rather than plain files.

## Logs

The app does not log transcripts, audio, voiceprints or keys. Errors name the failing operation
only.
