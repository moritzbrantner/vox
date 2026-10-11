// Passphrase encryption for portable session backups (vox#100), built on WebCrypto only:
// PBKDF2-SHA-256 derives an AES-GCM-256 key; fields are standard base64, no additional data.

export const ENCRYPTED_BACKUP_FORMAT = "vox-encrypted-backup";
const ENVELOPE_VERSION = 1;
export const DEFAULT_BACKUP_ITERATIONS = 600_000;
/** Envelopes below this are rejected as a downgrade. */
const MIN_ITERATIONS = 100_000;
/** Bounds the work a crafted envelope can demand. */
const MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

// One message for every integrity failure, so a wrong passphrase and tampering look the same.
const WRONG_OR_DAMAGED = "The passphrase is wrong or the backup is damaged.";
const INVALID_ENVELOPE = "This file is not a valid encrypted backup.";

export type EncryptedBackupEnvelope = {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: typeof ENVELOPE_VERSION;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  ciphertext: string;
};

export function isEncryptedBackup(value: unknown): value is { format: string; ciphertext: string } {
  return (
    isRecord(value) &&
    value.format === ENCRYPTED_BACKUP_FORMAT &&
    typeof value.ciphertext === "string"
  );
}

/** Encrypts UTF-8 text and returns the envelope as JSON. */
export async function encryptBackup(
  plaintext: string,
  passphrase: string,
  { iterations = DEFAULT_BACKUP_ITERATIONS }: { iterations?: number } = {},
): Promise<string> {
  requirePassphrase(passphrase);
  if (!isAllowedIterations(iterations)) {
    throw new Error(`Iterations must be an integer from ${MIN_ITERATIONS} to ${MAX_ITERATIONS}.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, iterations, "encrypt");
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const envelope: EncryptedBackupEnvelope = {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: ENVELOPE_VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    ciphertext: toBase64(ciphertext),
  };
  return JSON.stringify(envelope);
}

/** Validates the envelope, then decrypts it; integrity failures share one message. */
export async function decryptBackup(envelope: unknown, passphrase: string): Promise<string> {
  const { iterations, salt, iv, ciphertext } = readEnvelope(envelope);
  requirePassphrase(passphrase);
  let plaintext: ArrayBuffer;
  try {
    const key = await deriveKey(passphrase, salt, iterations, "decrypt");
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    throw new Error(WRONG_OR_DAMAGED);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error(WRONG_OR_DAMAGED);
  }
}

function readEnvelope(value: unknown) {
  if (!isEncryptedBackup(value)) {
    throw new Error(INVALID_ENVELOPE);
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted backup version ${String(envelope.version)}.`);
  }
  const { kdf, cipher } = envelope;
  if (
    !isRecord(kdf) ||
    kdf.name !== "PBKDF2" ||
    kdf.hash !== "SHA-256" ||
    typeof kdf.iterations !== "number" ||
    typeof kdf.salt !== "string" ||
    !isRecord(cipher) ||
    cipher.name !== "AES-GCM" ||
    typeof cipher.iv !== "string"
  ) {
    throw new Error(INVALID_ENVELOPE);
  }
  if (!isAllowedIterations(kdf.iterations)) {
    throw new Error("The backup's key derivation settings are not supported.");
  }
  const salt = fromBase64(kdf.salt);
  const iv = fromBase64(cipher.iv);
  const ciphertext = fromBase64(envelope.ciphertext as string);
  if (salt?.length !== SALT_BYTES || iv?.length !== IV_BYTES || !ciphertext) {
    throw new Error(INVALID_ENVELOPE);
  }
  return { iterations: kdf.iterations, salt, iv, ciphertext };
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: KeyUsage,
) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

function requirePassphrase(passphrase: string) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("A backup passphrase is required.");
  }
}

function isAllowedIterations(value: number) {
  return Number.isInteger(value) && value >= MIN_ITERATIONS && value <= MAX_ITERATIONS;
}

function toBase64(bytes: Uint8Array) {
  // Chunked so large backups do not overflow the argument limit.
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> | null {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
