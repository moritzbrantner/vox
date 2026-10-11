import { migrateSessionRecord, SESSION_SCHEMA_VERSION } from "@stutter-tracker/shared";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createSessionBackup, parseSessionBackup } from "./storage/sessionBackup";
import type { SavedSession, SpeechCorpusAnalysis } from "./types";

// Acceptance tests for issue #100: optional passphrase-encrypted session backups.
// Export: the "Export" button opens a dialog named "Export sessions" with two optional password
// inputs ("Backup passphrase", "Confirm backup passphrase"), a warning that a lost passphrase
// means the backup cannot be restored, and a "Download backup" button. Restore: choosing an
// encrypted file shows a password input "Backup passphrase" and a "Decrypt backup" button;
// decryption and full validation happen before the replace-all confirmation.
//
// Encrypted fixtures and the decryption of exported files are built here straight from the
// envelope format (PBKDF2-SHA-256 + AES-GCM, standard base64, no additional data), so these tests
// do not depend on the module under test.

const STORE_KEY = "stutter-tracker:sessions";
const REPLACE_COMMAND = "replace_speech_corpus_sessions";
const ENCRYPTED_BACKUP_FORMAT = "vox-encrypted-backup";
const FIXTURE_ITERATIONS = 600_000;
const PASSPHRASE = "orbit lantern quiet harbor";
const WRONG_PASSPHRASE = "orbit lantern quiet harbour";

type Envelope = {
  format: string;
  version: number;
  kdf: { name: string; hash: string; iterations: number; salt: string };
  cipher: { name: string; iv: string };
  ciphertext: string;
};

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function makeSession(id: string, text: string, startedAt: string): SavedSession {
  return migrateSessionRecord({
    id,
    startedAt,
    segments: [
      {
        text,
        startSeconds: 0,
        endSeconds: 1,
        confidence: 0.95,
        isFinal: true,
      },
    ],
    pauses: [],
    report: {
      totalDurationSeconds: 1,
      wordCount: 1,
      stutterCount: 0,
      stuttersPerMinute: 0,
      severity: "none",
      speechStats: {
        speakingDurationSeconds: 1,
        pauseDurationSeconds: 0,
        wordsPerMinute: 60,
        articulationRateWpm: 60,
        meanChunkWords: 1,
        meanChunkDurationSeconds: 1,
        eventDensityPer100Words: 0,
        fluencyPercentage: 100,
      },
      blockerStats: {
        blockCount: 0,
        totalBlockSeconds: 0,
        averageBlockSeconds: 0,
        longestBlockSeconds: 0,
        blocksPerMinute: 0,
        blockedTimePercentage: 0,
      },
      chunks: [],
      events: [],
      byKind: {},
    },
  });
}

function emptyCorpusAnalysis(): SpeechCorpusAnalysis {
  return {
    stats: {
      sessions: 0,
      documents: 0,
      speakers: 0,
      totalDurationSeconds: 0,
      totalTerms: 0,
      uniqueTerms: 0,
      averageTermsPerDocument: 0,
      wordCount: 0,
      stutterCount: 0,
      stuttersPerMinute: 0,
      lexicalDiversity: 0,
      withheldSessions: 0,
    },
    text: { bytes: 0, chars: 0, words: 0, lines: 0, sentences: 0, uniqueTerms: 0 },
    readability: { sentenceCount: 0, wordCount: 0, averageSentenceWords: 0, averageWordChars: 0 },
    sentiment: {
      positiveScore: 0,
      negativeScore: 0,
      compound: 0,
      tokenCount: 0,
      matchedTerms: 0,
      label: "neutral",
    },
    linguistic: {
      tokenCount: 0,
      sentenceCount: 0,
      lemmaCount: 0,
      entityCount: 0,
      entities: [],
      topics: [],
      register: "Neutral",
      disfluencyMarkers: 0,
      questionCount: 0,
      exclamationCount: 0,
    },
    topTerms: [],
    keywords: [],
    summary: [],
    speakers: [],
  };
}

const currentSessions = [
  makeSession("current-alpha-7f3e", "alpha private words", "2026-05-19T10:00:00.000Z"),
  makeSession("current-bravo-91c2", "bravo private words", "2026-05-19T11:00:00.000Z"),
  makeSession("current-charlie-55d0", "charlie private words", "2026-05-19T12:00:00.000Z"),
];
const backupSessions = [
  makeSession("backup-xray-0a1b", "xray restored words", "2026-04-01T10:00:00.000Z"),
  makeSession("backup-yankee-2c3d", "yankee restored words", "2026-04-02T10:00:00.000Z"),
];
/** Text that must never appear in an encrypted file or in a console call. */
const SECRETS = [...currentSessions, ...backupSessions].flatMap((session) => [
  session.id,
  session.segments[0].text,
]);

function backupJson(sessions: SavedSession[] = backupSessions) {
  return JSON.stringify(createSessionBackup(sessions, new Date("2026-10-01T00:00:00.000Z")));
}

function restoredSessions(json: string) {
  return parseSessionBackup(JSON.parse(json));
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: "encrypt" | "decrypt",
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

async function encryptFixture(plaintext: string, passphrase = PASSPHRASE): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, FIXTURE_ITERATIONS, "encrypt");
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: 1,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: FIXTURE_ITERATIONS,
      salt: toBase64(salt),
    },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    ciphertext: toBase64(ciphertext),
  };
}

async function decryptEnvelope(envelope: Envelope, passphrase: string) {
  const key = await deriveKey(
    passphrase,
    fromBase64(envelope.kdf.salt),
    envelope.kdf.iterations,
    "decrypt",
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.cipher.iv) },
    key,
    fromBase64(envelope.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

function tamperCiphertext(envelope: Envelope): Envelope {
  const bytes = fromBase64(envelope.ciphertext);
  bytes[0] ^= 0x01;
  return { ...envelope, ciphertext: toBase64(bytes) };
}

function backupFile(json: string) {
  return new File([json], "sessions-backup.json", { type: "application/json" });
}

function seedStoredSessions(sessions: SavedSession[]) {
  localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
  return localStorage.getItem(STORE_KEY);
}

function storedSessions() {
  return JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as SavedSession[] | null;
}

async function uploadBackup(json: string) {
  const input = await screen.findByLabelText<HTMLInputElement>("Choose session backup");
  await waitFor(() => expect(input).not.toBeDisabled());
  await userEvent.upload(input, backupFile(json));
}

let reload: ReturnType<typeof vi.fn>;

/** jsdom cannot navigate; the restore's page reload is observed through a stubbed location. */
function stubReload() {
  reload = vi.fn();
  const original = window.location;
  const fake = {
    ancestorOrigins: original.ancestorOrigins,
    hash: original.hash,
    host: original.host,
    hostname: original.hostname,
    href: original.href,
    origin: original.origin,
    pathname: original.pathname,
    port: original.port,
    protocol: original.protocol,
    search: original.search,
    assign: vi.fn(),
    replace: vi.fn(),
    reload,
    toString: () => original.href,
  } as unknown as Location;
  vi.spyOn(window, "location", "get").mockReturnValue(fake);
}

function restoreConfirmMessages(confirm: { mock: { calls: Array<[message?: string]> } }) {
  return confirm.mock.calls
    .map(([message]) => String(message))
    .filter((message) => /from this backup/i.test(message));
}

type InvokeHandlers = Partial<Record<string, (args: unknown) => Promise<unknown>>>;

function useDesktopInvokeMock(handlers: InvokeHandlers = {}) {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation((command, args) => {
    const handler = handlers[command];
    if (handler) {
      return handler(args) as Promise<never>;
    }
    if (command === "load_speech_corpus" || command === "backfill_speech_corpus_capture_quality") {
      return Promise.resolve(emptyCorpusAnalysis()) as Promise<never>;
    }
    return Promise.reject(new Error(`Tauri invoke unavailable for ${command}`));
  });
}

function invocations(command: string) {
  return vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
}

function alertTexts() {
  return screen
    .queryAllByRole("alert")
    .map((alert) => (alert.textContent ?? "").trim())
    .filter(Boolean);
}

async function findNewAlerts(baseline: string[]) {
  return waitFor(() => {
    const added = alertTexts().filter((text) => !baseline.includes(text));
    expect(added.length).toBeGreaterThan(0);
    return added;
  });
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// --- downloads: the export goes through a Blob object URL and an anchor click, as today.
let downloads: Array<{ blob: Blob; filename: string }>;
let createdBlobs: Blob[];
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function captureDownloads() {
  downloads = [];
  createdBlobs = [];
  const urls = new Map<string, Blob>();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      const url = `blob:test/${createdBlobs.length}`;
      createdBlobs.push(blob);
      urls.set(url, blob);
      return url;
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      const blob = urls.get(this.href);
      if (blob) {
        downloads.push({ blob, filename: this.download });
      }
    },
  );
}

function restoreDownloadGlobals() {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: originalCreateObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: originalRevokeObjectURL,
  });
}

async function openExportDialog() {
  await screen.findAllByTitle("Delete saved session");
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  return screen.findByRole("dialog", { name: "Export sessions" });
}

async function fillExportPassphrase(dialog: HTMLElement, passphrase: string, confirmation: string) {
  const input = within(dialog).getByLabelText("Backup passphrase");
  const confirm = within(dialog).getByLabelText("Confirm backup passphrase");
  expect(input).toHaveAttribute("type", "password");
  expect(confirm).toHaveAttribute("type", "password");
  await userEvent.type(input, passphrase);
  await userEvent.type(confirm, confirmation);
}

async function downloadedText() {
  await waitFor(() => expect(downloads).toHaveLength(1));
  return { text: await downloads[0].blob.text(), filename: downloads[0].filename };
}

// --- console: nothing secret may be logged.
let logged: unknown[];

function spyOnConsole() {
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(...args);
      // Keep React's own diagnostics visible while still capturing them.
      if (method === "error" || method === "warn") {
        original(...args);
      }
    });
  }
}

function expectNothingSecretLogged(extra: string[] = []) {
  const text = logged
    .map((value) => {
      if (value instanceof Error) {
        return `${value.message} ${value.stack ?? ""}`;
      }
      if (typeof value === "string") {
        return value;
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join("\n");
  for (const secret of [PASSPHRASE, WRONG_PASSPHRASE, ...SECRETS, ...extra]) {
    expect(text).not.toContain(secret);
  }
}

beforeEach(() => {
  stubReload();
  captureDownloads();
  spyOnConsole();
});

afterEach(() => {
  restoreDownloadGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(isTauri).mockReset();
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async () => {
    throw new Error("Tauri invoke is unavailable in tests");
  });
});

describe("export", () => {
  it("without a passphrase downloads the plain backup as before", async () => {
    seedStoredSessions(currentSessions);
    renderApp();

    const dialog = await openExportDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Download backup" }));

    const { text, filename } = await downloadedText();
    expect(filename).toMatch(/\.json$/);
    const parsed = JSON.parse(text) as { format?: unknown; sessions: unknown };
    expect(parsed.format).toBeUndefined();
    expect(parseSessionBackup(parsed).map((session) => session.id)).toEqual(
      expect.arrayContaining(currentSessions.map((session) => session.id)),
    );
    expect(text).toContain(currentSessions[0].segments[0].text);
  });

  it("with a passphrase downloads an envelope without plaintext that decrypts to the backup", async () => {
    seedStoredSessions(currentSessions);
    renderApp();

    const dialog = await openExportDialog();
    expect(dialog).toHaveTextContent(/passphrase/i);
    expect(dialog).toHaveTextContent(/cannot be restored/i);
    await fillExportPassphrase(dialog, PASSPHRASE, PASSPHRASE);
    await userEvent.click(within(dialog).getByRole("button", { name: "Download backup" }));

    const { text, filename } = await downloadedText();
    expect(filename).toMatch(/\.json$/);
    for (const secret of [...SECRETS, PASSPHRASE]) {
      expect(text).not.toContain(secret);
    }
    // Every Blob handed to the browser is the envelope; no plaintext copy was materialized.
    for (const blob of createdBlobs) {
      const content = await blob.text();
      for (const secret of SECRETS) {
        expect(content).not.toContain(secret);
      }
    }

    const envelope = JSON.parse(text) as Envelope;
    expect(envelope.format).toBe(ENCRYPTED_BACKUP_FORMAT);
    expect(envelope.version).toBe(1);
    expect(envelope.kdf).toMatchObject({ name: "PBKDF2", hash: "SHA-256" });
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    expect(envelope.cipher.name).toBe("AES-GCM");

    const plaintext = await decryptEnvelope(envelope, PASSPHRASE);
    expect(parseSessionBackup(JSON.parse(plaintext)).map((session) => session.id)).toEqual(
      expect.arrayContaining(currentSessions.map((session) => session.id)),
    );
    expectNothingSecretLogged();
  });

  it("blocks the download when the passphrase confirmation does not match", async () => {
    seedStoredSessions(currentSessions);
    renderApp();

    const dialog = await openExportDialog();
    await fillExportPassphrase(dialog, PASSPHRASE, WRONG_PASSPHRASE);
    await userEvent.click(within(dialog).getByRole("button", { name: "Download backup" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/do not match/i);
    await settle();
    expect(downloads).toHaveLength(0);
    expect(createdBlobs).toHaveLength(0);
    expectNothingSecretLogged();
  });
});

describe("restoring an encrypted backup", () => {
  it("asks for the passphrase, decrypts, then confirms and replaces both stores", async () => {
    useDesktopInvokeMock({
      [REPLACE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()),
    });
    seedStoredSessions(currentSessions);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const json = backupJson();

    renderApp();
    await uploadBackup(JSON.stringify(await encryptFixture(json)));

    const input = await screen.findByLabelText("Backup passphrase");
    expect(input).toHaveAttribute("type", "password");
    await settle();
    // Nothing is confirmed or replaced before the backup has been decrypted.
    expect(confirm).not.toHaveBeenCalled();
    expect(invocations(REPLACE_COMMAND)).toHaveLength(0);

    await userEvent.type(input, PASSPHRASE);
    await userEvent.click(screen.getByRole("button", { name: "Decrypt backup" }));

    await waitFor(() => expect(restoreConfirmMessages(confirm)).toHaveLength(1));
    expect(restoreConfirmMessages(confirm)[0]).toMatch(/\b2 sessions from this backup\b/);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const calls = invocations(REPLACE_COMMAND);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ sessions: restoredSessions(json) });
    expect(storedSessions()).toEqual(restoredSessions(json));
    expectNothingSecretLogged();
  });

  it("restores a file exported with a passphrase", async () => {
    seedStoredSessions(backupSessions);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const exporting = renderApp();
    const dialog = await openExportDialog();
    await fillExportPassphrase(dialog, PASSPHRASE, PASSPHRASE);
    await userEvent.click(within(dialog).getByRole("button", { name: "Download backup" }));
    const { text } = await downloadedText();
    exporting.unmount();

    seedStoredSessions(currentSessions);
    renderApp();
    await uploadBackup(text);
    await userEvent.type(await screen.findByLabelText("Backup passphrase"), PASSPHRASE);
    await userEvent.click(screen.getByRole("button", { name: "Decrypt backup" }));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(storedSessions()?.map((session) => session.id)).toEqual(
      expect.arrayContaining(backupSessions.map((session) => session.id)),
    );
    expect(storedSessions()).toHaveLength(backupSessions.length);
    expectNothingSecretLogged();
  });

  const failures: Array<[string, () => Promise<Envelope>, string, RegExp]> = [
    ["a wrong passphrase", () => encryptFixture(backupJson()), WRONG_PASSPHRASE, /passphrase/i],
    [
      "tampered ciphertext",
      async () => tamperCiphertext(await encryptFixture(backupJson())),
      PASSPHRASE,
      /passphrase/i,
    ],
    [
      "a decryptable but invalid backup",
      async () => {
        const parsed = JSON.parse(backupJson()) as { sessions: unknown[] };
        return encryptFixture(
          JSON.stringify({
            ...parsed,
            sessions: [
              {
                ...(parsed.sessions[0] as object),
                schemaVersion: SESSION_SCHEMA_VERSION + 1,
              },
              parsed.sessions[1],
            ],
          }),
        );
      },
      PASSPHRASE,
      /./,
    ],
  ];

  it.each(failures)(
    "rejects %s before confirming and leaves both stores unchanged",
    async (_label, makeEnvelope, passphrase, expectedError) => {
      useDesktopInvokeMock({
        [REPLACE_COMMAND]: () => Promise.resolve(emptyCorpusAnalysis()),
      });
      const before = seedStoredSessions(currentSessions);
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

      renderApp();
      await screen.findAllByTitle("Delete saved session");
      await uploadBackup(JSON.stringify(await makeEnvelope()));
      const input = await screen.findByLabelText("Backup passphrase");
      const baseline = alertTexts();
      await userEvent.type(input, passphrase);
      await userEvent.click(screen.getByRole("button", { name: "Decrypt backup" }));

      const added = await findNewAlerts(baseline);
      expect(added.join(" ")).toMatch(expectedError);
      await settle();

      expect(confirm).not.toHaveBeenCalled();
      expect(localStorage.getItem(STORE_KEY)).toBe(before);
      expect(invocations(REPLACE_COMMAND)).toHaveLength(0);
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getAllByTitle("Delete saved session")).toHaveLength(currentSessions.length);
      expectNothingSecretLogged();
    },
  );
});
