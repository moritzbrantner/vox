//! Protected local storage for the desktop app (vox#85; threat review in
//! `docs/protected-storage.md`).
//!
//! Every stored value is sealed with XChaCha20-Poly1305 (RustCrypto `chacha20poly1305`) under one
//! random 256-bit data key. The key never touches the disk: it lives in the operating system's
//! credential store through the `keyring` crate (macOS Keychain, Windows Credential Manager, the
//! Secret Service on Linux). No cryptography is invented here; this module only chooses file names
//! and writes files atomically.
//!
//! Plain files written by earlier builds are moved into the store on open. A plain file that is
//! still present is authoritative: it is only removed after its protected copy was written, and the
//! app only writes plain files while nothing is protected yet, so re-running an interrupted or
//! failed migration never loses a write.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use chacha20poly1305::aead::{Aead, Generate, Key, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use sha2::{Digest, Sha256};

const KEYCHAIN_SERVICE: &str = "com.moenarch.stutter-tracker";
const KEYCHAIN_ACCOUNT: &str = "local-data-key";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
/// File header and associated data of every sealed file; a format change bumps the version.
const MAGIC: &[u8; 8] = b"VOXPROT1";
const EXTENSION: &str = "vxp";

/// Plain files of earlier builds, moved into [`Namespace::Documents`] under the same name.
pub const LEGACY_DOCUMENTS: [&str; 2] = [SPEECH_CORPUS_DOCUMENT, SPEAKER_PROFILES_DOCUMENT];
pub const SPEECH_CORPUS_DOCUMENT: &str = "speech-corpus.json";
pub const SPEAKER_PROFILES_DOCUMENT: &str = "known-speakers.json";
/// Written once the web view's local storage has been moved into [`Namespace::Web`].
const WEB_MIGRATED_DOCUMENT: &str = "web-storage-migrated";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Namespace {
    /// Whole files owned by the Rust side (speech corpus, speaker profiles).
    Documents,
    /// The web view's key/value storage (sessions, voiceprints, settings, capture checkpoints).
    Web,
    /// Raw capture a user chose to keep with a saved session, keyed by session id.
    Audio,
}

impl Namespace {
    fn directory(self) -> &'static str {
        match self {
            Namespace::Documents => "documents",
            Namespace::Web => "web",
            Namespace::Audio => "audio",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("protected storage I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("a protected file could not be opened (damaged, or sealed with another key)")]
    Unreadable,
    #[error("the protected data key is invalid")]
    InvalidKey,
}

pub type StoreResult<T> = std::result::Result<T, StoreError>;

/// Where the data key is kept. The keychain in the app, a fixed key in tests.
pub trait KeySource {
    /// The stored key, or `None` when none was ever stored.
    fn load(&self) -> std::result::Result<Option<Vec<u8>>, String>;
    fn save(&self, key: &[u8]) -> std::result::Result<(), String>;
    /// Shown to the user, e.g. "macOS Keychain".
    fn mechanism(&self) -> &'static str;
}

/// The operating system's credential store.
pub struct KeychainKeys;

impl KeychainKeys {
    fn entry() -> std::result::Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|error| error.to_string())
    }
}

impl KeySource for KeychainKeys {
    fn load(&self) -> std::result::Result<Option<Vec<u8>>, String> {
        match Self::entry()?.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn save(&self, key: &[u8]) -> std::result::Result<(), String> {
        Self::entry()?
            .set_secret(key)
            .map_err(|error| error.to_string())
    }

    fn mechanism(&self) -> &'static str {
        if cfg!(target_os = "macos") {
            "macOS Keychain"
        } else if cfg!(target_os = "windows") {
            "Windows Credential Manager"
        } else {
            "Secret Service keyring"
        }
    }
}

pub struct ProtectedStore {
    root: PathBuf,
    cipher: XChaCha20Poly1305,
}

impl ProtectedStore {
    pub fn with_key(root: impl Into<PathBuf>, key: &[u8]) -> StoreResult<Self> {
        if key.len() != KEY_BYTES {
            return Err(StoreError::InvalidKey);
        }
        let key = Key::<XChaCha20Poly1305>::try_from(key).map_err(|_| StoreError::InvalidKey)?;
        Ok(Self {
            root: root.into(),
            cipher: XChaCha20Poly1305::new(&key),
        })
    }

    pub fn read(&self, namespace: Namespace, name: &str) -> StoreResult<Option<Vec<u8>>> {
        match fs::read(self.path(namespace, name)) {
            Ok(sealed) => {
                let (stored_name, data) = self.open(&sealed)?;
                // The name is sealed with the value, so a file renamed onto another is refused.
                if stored_name != name {
                    return Err(StoreError::Unreadable);
                }
                Ok(Some(data))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Seals `data` into a temporary file beside the target and renames it into place, so an
    /// interrupted write leaves the previous value, and no plain copy ever reaches the disk.
    pub fn write(&self, namespace: Namespace, name: &str, data: &[u8]) -> StoreResult<()> {
        let path = self.path(namespace, name);
        let directory = self.root.join(namespace.directory());
        fs::create_dir_all(&directory)?;
        let sealed = self.seal(name, data);
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let temporary = directory.join(format!(
            ".{}-{}.tmp",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let written = (|| {
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&sealed)?;
            file.sync_all()?;
            fs::rename(&temporary, &path)
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(())
    }

    pub fn remove(&self, namespace: Namespace, name: &str) -> StoreResult<()> {
        match fs::remove_file(self.path(namespace, name)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    /// Every entry of a namespace by name. Only used for the small web namespace.
    pub fn entries(&self, namespace: Namespace) -> StoreResult<BTreeMap<String, Vec<u8>>> {
        let mut entries = BTreeMap::new();
        for path in sealed_files(&self.root.join(namespace.directory()))? {
            let (name, data) = self.open(&fs::read(&path)?)?;
            if path != self.path(namespace, &name) {
                return Err(StoreError::Unreadable);
            }
            entries.insert(name, data);
        }
        Ok(entries)
    }

    /// Removes every entry of a namespace whose name is not in `keep`.
    pub fn retain(&self, namespace: Namespace, keep: &BTreeSet<String>) -> StoreResult<()> {
        let kept: BTreeSet<PathBuf> = keep.iter().map(|name| self.path(namespace, name)).collect();
        for path in sealed_files(&self.root.join(namespace.directory()))? {
            if !kept.contains(&path) {
                match fs::remove_file(&path) {
                    Err(error) if error.kind() != io::ErrorKind::NotFound => {
                        return Err(error.into())
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }

    fn path(&self, namespace: Namespace, name: &str) -> PathBuf {
        let digest = Sha256::digest(name.as_bytes());
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        self.root
            .join(namespace.directory())
            .join(format!("{hex}.{EXTENSION}"))
    }

    fn seal(&self, name: &str, data: &[u8]) -> Vec<u8> {
        let mut plain = Vec::with_capacity(4 + name.len() + data.len());
        plain.extend_from_slice(&(name.len() as u32).to_le_bytes());
        plain.extend_from_slice(name.as_bytes());
        plain.extend_from_slice(data);
        let nonce = XNonce::generate();
        let ciphertext = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: &plain,
                    aad: MAGIC,
                },
            )
            .expect("XChaCha20-Poly1305 encryption of an in-memory buffer cannot fail");
        let mut sealed = Vec::with_capacity(MAGIC.len() + NONCE_BYTES + ciphertext.len());
        sealed.extend_from_slice(MAGIC);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&ciphertext);
        sealed
    }

    fn open(&self, sealed: &[u8]) -> StoreResult<(String, Vec<u8>)> {
        let header = MAGIC.len() + NONCE_BYTES;
        if sealed.len() < header || &sealed[..MAGIC.len()] != MAGIC {
            return Err(StoreError::Unreadable);
        }
        let nonce =
            XNonce::try_from(&sealed[MAGIC.len()..header]).map_err(|_| StoreError::Unreadable)?;
        let plain = self
            .cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &sealed[header..],
                    aad: MAGIC,
                },
            )
            .map_err(|_| StoreError::Unreadable)?;
        let length = plain
            .get(..4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()) as usize)
            .ok_or(StoreError::Unreadable)?;
        let name = plain
            .get(4..4 + length)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .ok_or(StoreError::Unreadable)?
            .to_string();
        Ok((name, plain[4 + length..].to_vec()))
    }
}

fn sealed_files(directory: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let listing = match fs::read_dir(directory) {
        Ok(listing) => listing,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(files),
        Err(error) => return Err(error),
    };
    for entry in listing {
        let path = entry?.path();
        if path
            .extension()
            .is_some_and(|extension| extension == EXTENSION)
        {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

/// Whether anything was ever sealed under `root`, so a missing key must not start a fresh store.
fn has_sealed_data(root: &Path) -> io::Result<bool> {
    for namespace in [Namespace::Documents, Namespace::Web, Namespace::Audio] {
        if !sealed_files(&root.join(namespace.directory()))?.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The app's local storage, decided once at startup.
pub enum LocalStore {
    Protected {
        store: ProtectedStore,
        mechanism: &'static str,
    },
    /// No credential store, or moving earlier plain data failed: data stays in plain files, as
    /// before, and the UI says so.
    Plain { directory: PathBuf, reason: String },
    /// Protected data exists but cannot be opened (key missing or keychain refused). Nothing is
    /// read or written, so the sealed files stay intact for when the keychain is back.
    Locked { reason: String },
}

/// Opens the store under `<data_dir>/protected`, creating the key on first use, and moves plain
/// files written by earlier builds into it.
pub fn open_local_store(data_dir: &Path, keys: &dyn KeySource) -> LocalStore {
    let root = data_dir.join("protected");
    let sealed = match has_sealed_data(&root) {
        Ok(sealed) => sealed,
        Err(error) => {
            return LocalStore::Locked {
                reason: format!("protected storage could not be read: {error}"),
            }
        }
    };
    let key = match keys.load() {
        Ok(Some(key)) => key,
        Ok(None) if sealed => {
            return LocalStore::Locked {
                reason: format!(
                    "the data key is missing from the {}; protected data was left untouched",
                    keys.mechanism()
                ),
            }
        }
        Ok(None) => match create_key(keys) {
            Ok(key) => key,
            Err(reason) => return plain(data_dir, reason, keys),
        },
        Err(reason) if sealed => {
            return LocalStore::Locked {
                reason: format!("the {} refused the data key: {reason}", keys.mechanism()),
            }
        }
        Err(reason) => return plain(data_dir, reason, keys),
    };
    let store = match ProtectedStore::with_key(root, &key) {
        Ok(store) => store,
        Err(error) => {
            return LocalStore::Locked {
                reason: error.to_string(),
            }
        }
    };
    if let Err(error) = migrate_legacy_documents(&store, data_dir) {
        return LocalStore::Plain {
            directory: data_dir.to_path_buf(),
            reason: format!("moving existing data into protected storage failed: {error}"),
        };
    }
    LocalStore::Protected {
        store,
        mechanism: keys.mechanism(),
    }
}

fn plain(data_dir: &Path, reason: String, keys: &dyn KeySource) -> LocalStore {
    LocalStore::Plain {
        directory: data_dir.to_path_buf(),
        reason: format!("the {} is unavailable: {reason}", keys.mechanism()),
    }
}

/// Stores a new random key and reads it back, so a credential store that silently drops writes
/// never leaves data sealed under a key that is gone after a restart.
fn create_key(keys: &dyn KeySource) -> std::result::Result<Vec<u8>, String> {
    let key = Key::<XChaCha20Poly1305>::generate().to_vec();
    keys.save(&key)?;
    match keys.load()? {
        Some(stored) if stored == key => Ok(key),
        _ => Err("the new data key could not be read back".to_string()),
    }
}

fn migrate_legacy_documents(store: &ProtectedStore, data_dir: &Path) -> StoreResult<()> {
    for name in LEGACY_DOCUMENTS {
        let path = data_dir.join(name);
        let content = match fs::read(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        store.write(Namespace::Documents, name, &content)?;
        fs::remove_file(&path)?;
    }
    Ok(())
}

impl LocalStore {
    pub fn document(&self, name: &'static str) -> std::result::Result<StoreDocument<'_>, String> {
        match self {
            LocalStore::Protected { store, .. } => Ok(StoreDocument::Protected { store, name }),
            LocalStore::Plain { directory, .. } => Ok(StoreDocument::Plain(directory.join(name))),
            LocalStore::Locked { reason } => Err(locked_message(reason)),
        }
    }

    pub fn protected(&self) -> std::result::Result<&ProtectedStore, String> {
        match self {
            LocalStore::Protected { store, .. } => Ok(store),
            LocalStore::Plain { reason, .. } => {
                Err(format!("protected storage is unavailable: {reason}"))
            }
            LocalStore::Locked { reason } => Err(locked_message(reason)),
        }
    }

    /// Whether the web view's local storage was already moved in.
    pub fn web_migrated(&self) -> StoreResult<bool> {
        match self {
            LocalStore::Protected { store, .. } => Ok(store
                .read(Namespace::Documents, WEB_MIGRATED_DOCUMENT)?
                .is_some()),
            _ => Ok(false),
        }
    }

    /// Replaces the web namespace with exactly `entries`, then marks the migration done. Until
    /// the mark is written, the web view keeps its plain copy and repeats the migration on the
    /// next start.
    pub fn migrate_web(
        &self,
        entries: &BTreeMap<String, String>,
    ) -> std::result::Result<(), String> {
        let store = self.protected()?;
        let migrate = || -> StoreResult<()> {
            for (key, value) in entries {
                store.write(Namespace::Web, key, value.as_bytes())?;
            }
            store.retain(Namespace::Web, &entries.keys().cloned().collect())?;
            store.write(Namespace::Documents, WEB_MIGRATED_DOCUMENT, b"1")
        };
        migrate().map_err(|error| error.to_string())
    }
}

fn locked_message(reason: &str) -> String {
    format!("protected storage is locked: {reason}")
}

/// One whole file, sealed or plain.
pub trait Document {
    fn load(&self) -> io::Result<Option<Vec<u8>>>;
    fn save(&self, content: &[u8]) -> io::Result<()>;
}

pub enum StoreDocument<'a> {
    Protected {
        store: &'a ProtectedStore,
        name: &'static str,
    },
    Plain(PathBuf),
}

impl Document for StoreDocument<'_> {
    fn load(&self) -> io::Result<Option<Vec<u8>>> {
        match self {
            StoreDocument::Protected { store, name } => store
                .read(Namespace::Documents, name)
                .map_err(io::Error::other),
            StoreDocument::Plain(path) => path.load(),
        }
    }

    fn save(&self, content: &[u8]) -> io::Result<()> {
        match self {
            StoreDocument::Protected { store, name } => store
                .write(Namespace::Documents, name, content)
                .map_err(io::Error::other),
            StoreDocument::Plain(path) => path.save(content),
        }
    }
}

/// A plain file, written atomically through a sibling temporary file.
impl Document for PathBuf {
    fn load(&self) -> io::Result<Option<Vec<u8>>> {
        match fs::read(self) {
            Ok(content) => Ok(Some(content)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn save(&self, content: &[u8]) -> io::Result<()> {
        if let Some(parent) = self.parent() {
            fs::create_dir_all(parent)?;
        }
        // Unique per process and write, so concurrent writers never share or delete each other's
        // file.
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let mut temporary = self.as_os_str().to_owned();
        temporary.push(format!(
            ".{}-{}.tmp",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let temporary = PathBuf::from(temporary);
        if let Err(error) =
            fs::write(&temporary, content).and_then(|()| fs::rename(&temporary, self))
        {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct TestKeys {
        key: RefCell<Option<Vec<u8>>>,
        fail: Option<&'static str>,
        drop_writes: bool,
    }

    impl TestKeys {
        fn empty() -> Self {
            Self {
                key: RefCell::new(None),
                fail: None,
                drop_writes: false,
            }
        }
        fn failing(reason: &'static str) -> Self {
            Self {
                fail: Some(reason),
                ..Self::empty()
            }
        }
    }

    impl KeySource for TestKeys {
        fn load(&self) -> std::result::Result<Option<Vec<u8>>, String> {
            match self.fail {
                Some(reason) => Err(reason.to_string()),
                None => Ok(self.key.borrow().clone()),
            }
        }
        fn save(&self, key: &[u8]) -> std::result::Result<(), String> {
            if let Some(reason) = self.fail {
                return Err(reason.to_string());
            }
            if !self.drop_writes {
                *self.key.borrow_mut() = Some(key.to_vec());
            }
            Ok(())
        }
        fn mechanism(&self) -> &'static str {
            "test keychain"
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vox-protected-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn protected(store: &LocalStore) -> &ProtectedStore {
        store.protected().unwrap()
    }

    fn all_bytes(dir: &Path) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(dir) = pending.pop() {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    bytes.extend(fs::read(path).unwrap());
                }
            }
        }
        bytes
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[test]
    fn values_round_trip_and_never_reach_the_disk_in_plain() {
        let dir = temp_dir("roundtrip");
        let keys = TestKeys::empty();
        let local = open_local_store(&dir, &keys);
        let store = protected(&local);
        store
            .write(
                Namespace::Web,
                "stutter-tracker:sessions",
                b"my private words",
            )
            .unwrap();
        store
            .write(Namespace::Audio, "session-1", &[1, 2, 3, 4])
            .unwrap();

        assert_eq!(
            store
                .read(Namespace::Web, "stutter-tracker:sessions")
                .unwrap()
                .as_deref(),
            Some(&b"my private words"[..])
        );
        assert_eq!(store.read(Namespace::Web, "missing").unwrap(), None);
        assert_eq!(
            store
                .entries(Namespace::Web)
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            vec!["stutter-tracker:sessions"]
        );
        let disk = all_bytes(&dir);
        assert!(!contains(&disk, b"my private words"));
        assert!(!contains(&disk, b"stutter-tracker:sessions"));
        // No temporary file is left behind.
        assert!(fs::read_dir(dir.join("protected/web"))
            .unwrap()
            .all(|entry| entry.unwrap().path().extension().unwrap() == EXTENSION));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_sealed_with_another_key_or_tampered_is_refused() {
        let dir = temp_dir("tamper");
        let store = ProtectedStore::with_key(dir.join("protected"), &[7; KEY_BYTES]).unwrap();
        store.write(Namespace::Web, "a", b"value").unwrap();
        let other = ProtectedStore::with_key(dir.join("protected"), &[8; KEY_BYTES]).unwrap();
        assert!(matches!(
            other.read(Namespace::Web, "a"),
            Err(StoreError::Unreadable)
        ));

        let path = store.path(Namespace::Web, "a");
        let mut sealed = fs::read(&path).unwrap();
        *sealed.last_mut().unwrap() ^= 1;
        fs::write(&path, &sealed).unwrap();
        assert!(matches!(
            store.read(Namespace::Web, "a"),
            Err(StoreError::Unreadable)
        ));

        // A sealed file renamed onto another name is refused too.
        store.write(Namespace::Web, "b", b"other").unwrap();
        fs::copy(
            store.path(Namespace::Web, "b"),
            store.path(Namespace::Web, "c"),
        )
        .unwrap();
        assert!(matches!(
            store.read(Namespace::Web, "c"),
            Err(StoreError::Unreadable)
        ));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_key_is_created_once_and_reused() {
        let dir = temp_dir("key");
        let keys = TestKeys::empty();
        protected(&open_local_store(&dir, &keys))
            .write(Namespace::Web, "k", b"v")
            .unwrap();
        let first = keys.key.borrow().clone().unwrap();
        let reopened = open_local_store(&dir, &keys);
        assert_eq!(keys.key.borrow().clone().unwrap(), first);
        assert_eq!(
            protected(&reopened)
                .read(Namespace::Web, "k")
                .unwrap()
                .as_deref(),
            Some(&b"v"[..])
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn without_a_credential_store_existing_plain_data_stays_in_use() {
        let dir = temp_dir("nokeychain");
        fs::write(dir.join(SPEECH_CORPUS_DOCUMENT), b"{\"sessions\":[]}").unwrap();
        let local = open_local_store(&dir, &TestKeys::failing("no secret service"));
        let LocalStore::Plain { reason, .. } = &local else {
            panic!("expected plain storage");
        };
        assert!(reason.contains("no secret service"));
        assert_eq!(
            local
                .document(SPEECH_CORPUS_DOCUMENT)
                .unwrap()
                .load()
                .unwrap()
                .as_deref(),
            Some(&b"{\"sessions\":[]}"[..])
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_key_store_that_drops_writes_is_not_trusted() {
        let dir = temp_dir("dropkey");
        let keys = TestKeys {
            drop_writes: true,
            ..TestKeys::empty()
        };
        assert!(matches!(
            open_local_store(&dir, &keys),
            LocalStore::Plain { .. }
        ));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn protected_data_without_its_key_is_locked_and_left_intact() {
        let dir = temp_dir("locked");
        let keys = TestKeys::empty();
        protected(&open_local_store(&dir, &keys))
            .write(Namespace::Web, "k", b"v")
            .unwrap();
        let before = all_bytes(&dir);

        for keys in [TestKeys::empty(), TestKeys::failing("keychain is locked")] {
            let local = open_local_store(&dir, &keys);
            assert!(matches!(local, LocalStore::Locked { .. }));
            assert!(local.document(SPEECH_CORPUS_DOCUMENT).is_err());
            // No new key was stored over the missing one.
            assert!(keys.key.borrow().is_none());
        }
        assert_eq!(all_bytes(&dir), before);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn plain_documents_move_into_the_store() {
        let dir = temp_dir("migrate");
        fs::write(dir.join(SPEECH_CORPUS_DOCUMENT), b"corpus words").unwrap();
        fs::write(dir.join(SPEAKER_PROFILES_DOCUMENT), b"voiceprints").unwrap();
        let local = open_local_store(&dir, &TestKeys::empty());

        assert!(!dir.join(SPEECH_CORPUS_DOCUMENT).exists());
        assert!(!dir.join(SPEAKER_PROFILES_DOCUMENT).exists());
        let corpus = local.document(SPEECH_CORPUS_DOCUMENT).unwrap();
        assert_eq!(
            corpus.load().unwrap().as_deref(),
            Some(&b"corpus words"[..])
        );
        assert!(!contains(&all_bytes(&dir), b"corpus words"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_interrupted_document_migration_is_completed_from_the_plain_file() {
        let dir = temp_dir("interrupted");
        let keys = TestKeys::empty();
        protected(&open_local_store(&dir, &keys));
        // The protected copy was written, the plain file not yet removed, and (since moving
        // failed) the plain file was updated afterwards: the plain file wins.
        let store =
            ProtectedStore::with_key(dir.join("protected"), &keys.key.borrow().clone().unwrap())
                .unwrap();
        store
            .write(Namespace::Documents, SPEECH_CORPUS_DOCUMENT, b"old")
            .unwrap();
        fs::write(dir.join(SPEECH_CORPUS_DOCUMENT), b"newer").unwrap();

        let local = open_local_store(&dir, &keys);
        assert!(matches!(local, LocalStore::Protected { .. }));
        assert_eq!(
            local
                .document(SPEECH_CORPUS_DOCUMENT)
                .unwrap()
                .load()
                .unwrap()
                .as_deref(),
            Some(&b"newer"[..])
        );
        assert!(!dir.join(SPEECH_CORPUS_DOCUMENT).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_document_migration_keeps_the_plain_corpus_in_use() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("failed");
        fs::write(dir.join(SPEECH_CORPUS_DOCUMENT), b"corpus words").unwrap();
        // The protected directory cannot be created.
        fs::create_dir_all(dir.join("protected")).unwrap();
        fs::set_permissions(dir.join("protected"), fs::Permissions::from_mode(0o500)).unwrap();
        let local = open_local_store(&dir, &TestKeys::empty());
        fs::set_permissions(dir.join("protected"), fs::Permissions::from_mode(0o700)).unwrap();

        let LocalStore::Plain { reason, .. } = &local else {
            panic!("expected plain storage after a failed migration");
        };
        assert!(reason.contains("moving existing data"));
        assert_eq!(
            local
                .document(SPEECH_CORPUS_DOCUMENT)
                .unwrap()
                .load()
                .unwrap()
                .as_deref(),
            Some(&b"corpus words"[..])
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_web_migration_replaces_the_namespace_and_is_marked_last() {
        let dir = temp_dir("web");
        let local = open_local_store(&dir, &TestKeys::empty());
        let store = protected(&local);
        // A partial earlier attempt left an entry the web view has since removed.
        store.write(Namespace::Web, "stale", b"gone").unwrap();
        assert!(!local.web_migrated().unwrap());

        let entries = BTreeMap::from([
            ("stutter-tracker:sessions".to_string(), "[1]".to_string()),
            ("stutter-tracker:speakers".to_string(), "[2]".to_string()),
        ]);
        local.migrate_web(&entries).unwrap();
        assert!(local.web_migrated().unwrap());
        let stored = store.entries(Namespace::Web).unwrap();
        assert_eq!(stored.len(), 2);
        assert_eq!(stored["stutter-tracker:sessions"], b"[1]");
        let _ = fs::remove_dir_all(dir);
    }
}
