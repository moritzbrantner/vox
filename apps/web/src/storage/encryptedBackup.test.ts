import { afterEach, describe, expect, test, vi } from "vitest";
import {
  decryptBackup,
  encryptBackup,
  ENCRYPTED_BACKUP_FORMAT,
  isEncryptedBackup,
} from "./encryptedBackup";

// Acceptance tests for issue #100: optional passphrase encryption of portable session backups.
// The envelope is `{ format, version: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt },
// cipher: { name: "AES-GCM", iv }, ciphertext }` with standard base64 fields, built on WebCrypto.

type Envelope = {
  format: string;
  version: number;
  kdf: { name: string; hash: string; iterations: number; salt: string };
  cipher: { name: string; iv: string };
  ciphertext: string;
};

/** The lowest iteration count an envelope may carry; anything below is a downgrade. */
const ITERATION_FLOOR = 100_000;
const PASSPHRASE = "correct horse battery staple";
const PLAINTEXT = JSON.stringify({
  version: 2,
  exportedAt: "2026-10-01T00:00:00.000Z",
  sessions: [{ id: "secret-session-id-4711", segments: [{ text: "confidential transcript" }] }],
});

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

/** Flips one bit of a base64 field, keeping its length. */
function flipBase64(value: string, index = 0) {
  const bytes = fromBase64(value);
  bytes[index] ^= 0x01;
  return toBase64(bytes);
}

async function encryptFast(plaintext: string, passphrase = PASSPHRASE) {
  return JSON.parse(
    await encryptBackup(plaintext, passphrase, { iterations: ITERATION_FLOOR }),
  ) as Envelope;
}

/** Builds an envelope straight from the format description, independent of the module under test. */
async function specEnvelope(
  plaintext: string,
  passphrase: string,
  iterations: number,
): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    ciphertext: toBase64(ciphertext),
  };
}

async function rejectionMessage(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message.length).toBeGreaterThan(0);
  return message;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("envelope format", () => {
  test("uses the vox-encrypted-backup format name", () => {
    expect(ENCRYPTED_BACKUP_FORMAT).toBe("vox-encrypted-backup");
  });

  test("default encryption round-trips and uses at least 600000 PBKDF2-SHA-256 iterations", async () => {
    const json = await encryptBackup(PLAINTEXT, PASSPHRASE);
    const envelope = JSON.parse(json) as Envelope;

    expect(envelope.format).toBe(ENCRYPTED_BACKUP_FORMAT);
    expect(envelope.version).toBe(1);
    expect(envelope.kdf.name).toBe("PBKDF2");
    expect(envelope.kdf.hash).toBe("SHA-256");
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    expect(envelope.cipher.name).toBe("AES-GCM");
    expect(fromBase64(envelope.kdf.salt)).toHaveLength(16);
    expect(fromBase64(envelope.cipher.iv)).toHaveLength(12);
    expect(typeof envelope.ciphertext).toBe("string");
    expect(isEncryptedBackup(envelope)).toBe(true);

    await expect(decryptBackup(envelope, PASSPHRASE)).resolves.toBe(PLAINTEXT);
  });

  test("salt, iv and ciphertext are fresh for every encryption", async () => {
    const first = await encryptFast(PLAINTEXT);
    const second = await encryptFast(PLAINTEXT);

    expect(second.kdf.salt).not.toBe(first.kdf.salt);
    expect(second.cipher.iv).not.toBe(first.cipher.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  test("the envelope carries no plaintext and no passphrase", async () => {
    const json = await encryptBackup(PLAINTEXT, PASSPHRASE, { iterations: ITERATION_FLOOR });

    for (const secret of [
      "secret-session-id-4711",
      "confidential transcript",
      "sessions",
      PASSPHRASE,
      btoa(PLAINTEXT).slice(0, 24),
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  test("decrypts an envelope built directly from the format description", async () => {
    const envelope = await specEnvelope(PLAINTEXT, PASSPHRASE, ITERATION_FLOOR);
    await expect(decryptBackup(envelope, PASSPHRASE)).resolves.toBe(PLAINTEXT);
  });
});

describe("round trip", () => {
  test.each([
    ["ASCII JSON", PLAINTEXT],
    ["non-ASCII text", "Grüße aus Köln — 日本語のテキスト, emoji 🗣️🎙️, RTL שלום"],
  ])("restores %s exactly", async (_label, plaintext) => {
    const envelope = await encryptFast(plaintext, "pässwörd ✓ 鍵");
    await expect(decryptBackup(envelope, "pässwörd ✓ 鍵")).resolves.toBe(plaintext);
  });

  test("an empty passphrase is rejected", async () => {
    await rejectionMessage(encryptBackup(PLAINTEXT, ""));
  });
});

describe("integrity failures", () => {
  test("a wrong passphrase and every kind of tampering reject with one wrong-or-damaged message", async () => {
    const envelope = await encryptFast(PLAINTEXT);

    const wrongPassphrase = await rejectionMessage(decryptBackup(envelope, `${PASSPHRASE}!`));
    expect(wrongPassphrase).toMatch(/passphrase/i);
    expect(wrongPassphrase).toMatch(/damaged/i);

    const tampered: Array<[string, Envelope]> = [
      ["ciphertext start", { ...envelope, ciphertext: flipBase64(envelope.ciphertext) }],
      [
        "ciphertext tag",
        {
          ...envelope,
          ciphertext: flipBase64(envelope.ciphertext, fromBase64(envelope.ciphertext).length - 1),
        },
      ],
      ["iv", { ...envelope, cipher: { ...envelope.cipher, iv: flipBase64(envelope.cipher.iv) } }],
      ["salt", { ...envelope, kdf: { ...envelope.kdf, salt: flipBase64(envelope.kdf.salt) } }],
      [
        "iterations",
        { ...envelope, kdf: { ...envelope.kdf, iterations: envelope.kdf.iterations + 1 } },
      ],
    ];
    for (const [label, candidate] of tampered) {
      const message = await rejectionMessage(decryptBackup(candidate, PASSPHRASE));
      expect(message, `tampered ${label}`).toBe(wrongPassphrase);
    }
  });

  test("an envelope below the iteration floor is rejected even with the right passphrase", async () => {
    for (const iterations of [1, 1000, ITERATION_FLOOR - 1]) {
      const downgraded = await specEnvelope(PLAINTEXT, PASSPHRASE, iterations);
      await rejectionMessage(decryptBackup(downgraded, PASSPHRASE));
    }
  });
});

describe("malformed envelopes", () => {
  test("an unsupported version is rejected with a message naming the version", async () => {
    const envelope = await encryptFast(PLAINTEXT);
    const message = await rejectionMessage(decryptBackup({ ...envelope, version: 2 }, PASSPHRASE));
    expect(message).toMatch(/version/i);
  });

  test("structurally invalid envelopes are rejected", async () => {
    const envelope = await encryptFast(PLAINTEXT);
    const { ciphertext: _ciphertext, ...withoutCiphertext } = envelope;
    const candidates: unknown[] = [
      null,
      "not an envelope",
      42,
      [],
      {},
      { ...envelope, format: "something-else" },
      withoutCiphertext,
      { ...envelope, kdf: undefined },
      { ...envelope, cipher: { ...envelope.cipher, name: "AES-CBC" } },
      { ...envelope, kdf: { ...envelope.kdf, name: "scrypt" } },
      { ...envelope, kdf: { ...envelope.kdf, iterations: "600000" } },
      { ...envelope, kdf: { ...envelope.kdf, salt: 12345 } },
    ];
    for (const candidate of candidates) {
      await rejectionMessage(decryptBackup(candidate, PASSPHRASE));
    }
  });
});

describe("isEncryptedBackup", () => {
  test("recognises an envelope and nothing else", async () => {
    const envelope = await encryptFast(PLAINTEXT);
    expect(isEncryptedBackup(envelope)).toBe(true);

    const { ciphertext: _ciphertext, ...withoutCiphertext } = envelope;
    for (const value of [
      JSON.parse(PLAINTEXT),
      { sessions: [] },
      null,
      undefined,
      "vox-encrypted-backup",
      [envelope],
      { ...envelope, format: "something-else" },
      withoutCiphertext,
    ]) {
      expect(isEncryptedBackup(value)).toBe(false);
    }
  });
});

describe("logging", () => {
  test("neither the passphrase nor the plaintext reaches the console", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }

    const envelope = await encryptFast(PLAINTEXT);
    await decryptBackup(envelope, PASSPHRASE);
    await decryptBackup(envelope, "wrong passphrase").catch(() => undefined);
    await decryptBackup(
      { ...envelope, ciphertext: flipBase64(envelope.ciphertext) },
      PASSPHRASE,
    ).catch(() => undefined);

    const text = logged
      .map((value) => (value instanceof Error ? `${value.message} ${value.stack}` : String(value)))
      .join("\n");
    for (const secret of [PASSPHRASE, "wrong passphrase", "confidential transcript", "4711"]) {
      expect(text).not.toContain(secret);
    }
  });
});
