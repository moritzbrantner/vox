// Acceptance tests for vox#84: explicit offline model preparation status, no hidden remote
// fallback, and model identity on saved analysis runs.
//
// A consented remote compute server is configured for the whole file, so any fallback from a
// local model problem to that server would show up as a request to it. The network is offline:
// every request fails as a browser fetch does without a connection.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackAnalyze } from "@stutter-tracker/shared";
import * as tauriCore from "@tauri-apps/api/core";
import * as recorderModule from "./audio/browserRecorder";
import { storedSessions } from "./test/storedSessions";

const { REMOTE_SERVER_URL, fetchCalls } = vi.hoisted(() => {
  const url = "https://speech.example.com";
  // Read once when the app module loads: the remote server, with remote-analysis consent.
  vi.stubEnv("VITE_STUTTER_SERVER_URL", url);
  localStorage.setItem("stutter-tracker:remote-analysis-consent", url);
  // The compute client keeps the fetch it sees at creation, so the offline network is installed
  // first. Every request is recorded and fails as a browser fetch does without a connection.
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input instanceof Request ? input.url : String(input));
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  return { REMOTE_SERVER_URL: url, fetchCalls: calls };
});

// Imported after the hoisted setup so the app's compute client sees the remote destination.
const { App } = await import("./App");

const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
const TEST_CAPTURE = recorderModule.describeCapture(undefined);
// Endpoints that carry speech content or prepare models on a server.
const SPEECH_PATHS = [
  "/analysis",
  "/transcriptions",
  "/transcriptions/file",
  "/transcriptions/models/download",
];

type NativeHandler = (args: Record<string, unknown> | undefined) => unknown;
type NativeCall = { command: string; args: Record<string, unknown> | undefined };

let speechRecognitionStarts = 0;
const originalSpeechRecognition = (window as { SpeechRecognition?: unknown }).SpeechRecognition;

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

/** Requests that went to the remote server with speech content or model preparation. */
function remoteSpeechRequests() {
  return fetchCalls.filter((url) => {
    const parsed = new URL(url, "http://jsdom.invalid");
    return parsed.origin === REMOTE_SERVER_URL && SPEECH_PATHS.includes(parsed.pathname);
  });
}

/** Runs the app as the desktop shell, with native commands answered by `handlers`. */
function desktop(handlers: Record<string, NativeHandler>) {
  const calls: NativeCall[] = [];
  const invoke = vi.spyOn(tauriCore, "invoke").mockImplementation(async (command, args) => {
    calls.push({ command, args: args as Record<string, unknown> | undefined });
    const handler = handlers[command];
    if (!handler) {
      throw new Error(`Native command ${command} unavailable in this fixture`);
    }
    return handler(args as Record<string, unknown> | undefined);
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
  return {
    calls,
    called: (command: string) => calls.filter((call) => call.command === command),
  };
}

function mockRecorder() {
  let capture: recorderModule.BrowserRecorderOptions | undefined;
  vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
    capture = options;
    return { sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} };
  });
  return {
    get started() {
      return capture !== undefined;
    },
    feed(seconds: number) {
      act(() => {
        capture!.onSamples(new Float32Array(16000 * seconds).fill(0.2));
      });
    },
  };
}

function whisperModels(cached: boolean) {
  return {
    models: [
      { id: "tiny.en", label: "tiny.en", cached: false, downloadable: true },
      { id: "base.en", label: "base.en", cached, downloadable: true },
    ],
  };
}

/**
 * The Models panel entry of one model: its label followed by its preparation status. The fixture's
 * model ids are not prefixes of each other.
 */
async function modelEntry(model: string) {
  const entries = await screen.findAllByRole("button", {
    name: new RegExp(`^${model.replace(".", "\\.")}`),
  });
  expect(entries).toHaveLength(1);
  return entries[0];
}

beforeEach(() => {
  localStorage.setItem(
    TRANSCRIPTION_KEY,
    JSON.stringify({ engine: "whisperCpp", model: "base.en" }),
  );
  fetchCalls.length = 0;
  speechRecognitionStarts = 0;
  // The browser's recognizer may run in a vendor cloud; it must never stand in for a local model.
  class TrackingSpeechRecognition {
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: unknown = null;
    onerror: unknown = null;
    onend: unknown = null;
    start() {
      speechRecognitionStarts += 1;
    }
    stop() {}
    abort() {}
  }
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    writable: true,
    value: TrackingSpeechRecognition,
  });
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    writable: true,
    value: originalSpeechRecognition,
  });
  localStorage.clear();
  vi.restoreAllMocks();
});

it("runs against a consented remote server, so a hidden fallback would be observable", () => {
  // The web shell shows the compute client's destination; the desktop shell uses the same client.
  renderApp();
  expect(screen.getByLabelText("Processing destination")).toHaveTextContent(
    `Remote server at ${REMOTE_SERVER_URL}`,
  );
});

describe("model preparation faults on the desktop", () => {
  it("shows a canceled download as canceled and never routes to the remote server", async () => {
    const native = desktop({
      transcription_models: () => whisperModels(false),
      download_transcription_model: () => {
        throw "download canceled";
      },
    });
    const recorder = mockRecorder();
    renderApp();

    await waitFor(() => expect(native.called("download_transcription_model").length).toBe(1));
    // The model's own status says what happened; a generic message elsewhere is not enough.
    await waitFor(async () => expect(await modelEntry("base.en")).toHaveTextContent(/cancel/i));
    expect(await modelEntry("base.en")).not.toHaveTextContent(/ready/i);

    await userEvent.click(screen.getByRole("button", { name: /^record$/i }));
    if (recorder.started) {
      recorder.feed(6);
      await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    }

    expect(native.called("transcribe_audio")).toHaveLength(0);
    expect(remoteSpeechRequests()).toEqual([]);
    expect(speechRecognitionStarts).toBe(0);
    expect(await modelEntry("base.en")).toHaveTextContent(/cancel/i);
  });

  it("shows an interrupted download as interrupted, not ready, and never routes remotely", async () => {
    let checks = 0;
    const native = desktop({
      transcription_models: () => {
        checks += 1;
        return whisperModels(false);
      },
      download_transcription_model: () => {
        // The connection drops part-way; a partial file is not a prepared model.
        throw "network error: connection reset by peer";
      },
    });
    const recorder = mockRecorder();
    renderApp();

    await waitFor(() => expect(native.called("download_transcription_model").length).toBe(1));
    await waitFor(async () =>
      expect(await modelEntry("base.en")).toHaveTextContent(/interrupt|incomplete|failed/i),
    );
    expect(await modelEntry("base.en")).not.toHaveTextContent(/ready/i);
    expect(checks).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: /^record$/i }));
    if (recorder.started) {
      recorder.feed(6);
      await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    }

    expect(native.called("transcribe_audio")).toHaveLength(0);
    expect(remoteSpeechRequests()).toEqual([]);
    expect(speechRecognitionStarts).toBe(0);
    expect(await modelEntry("base.en")).toHaveTextContent(/interrupt|incomplete|failed/i);
  });

  it("reports a model that went missing after it was ready and keeps everything local", async () => {
    let cached = true;
    const native = desktop({
      transcription_models: () => whisperModels(cached),
      transcribe_audio: () => {
        // The cached file was removed after the status check; offline it cannot be fetched again.
        cached = false;
        throw "whisper.cpp model `base.en` is not available on this device";
      },
      download_transcription_model: () => {
        throw "network error: offline";
      },
      analyze_speech_session: (args) => ({
        ...fallbackAnalyze((args as { request: Parameters<typeof fallbackAnalyze>[0] }).request),
        analyzerVersion: "1",
      }),
    });
    const recorder = mockRecorder();
    renderApp();

    await waitFor(async () => expect(await modelEntry("base.en")).toHaveTextContent(/ready/i));
    await userEvent.click(screen.getByRole("button", { name: /^record$/i }));
    await waitFor(() => expect(recorder.started).toBe(true));
    recorder.feed(6);
    await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));

    await waitFor(() => expect(native.called("transcribe_audio").length).toBeGreaterThan(0));
    await waitFor(async () =>
      expect(await modelEntry("base.en")).toHaveTextContent(
        /missing|not downloaded|not available/i,
      ),
    );
    expect(await modelEntry("base.en")).not.toHaveTextContent(/ready/i);
    expect(remoteSpeechRequests()).toEqual([]);
    expect(speechRecognitionStarts).toBe(0);
  });
});

describe("offline capability limits", () => {
  it("shows unknown model availability instead of guessing it when the server is unreachable", async () => {
    // Web shell: native engines need the configured server, which cannot be reached offline.
    renderApp();

    await waitFor(() =>
      expect(fetchCalls.some((url) => url.startsWith(REMOTE_SERVER_URL))).toBe(true),
    );
    const entry = await modelEntry("base.en");
    // Not checked is not the same as "needs an external CLI" or "ready".
    await waitFor(() =>
      expect(entry).toHaveTextContent(
        /unknown|not checked|could not be checked|unavailable|offline/i,
      ),
    );
    expect(entry).not.toHaveTextContent(/external cli/i);
    expect(entry).not.toHaveTextContent(/ready/i);
    expect(screen.getByLabelText("Transcription model")).toBeInTheDocument();
    expect(speechRecognitionStarts).toBe(0);
  });
});

describe("model identity on saved analysis runs", () => {
  it("records the transcription engine and model with the saved run", async () => {
    const native = desktop({
      transcription_models: () => whisperModels(true),
      transcribe_audio: () => ({
        segments: [
          { text: "hello there", startSeconds: 0, endSeconds: 2, confidence: 0.9, isFinal: true },
        ],
        provider: "whisperCpp",
        model: "base.en",
      }),
      analyze_speech_session: (args) => ({
        ...fallbackAnalyze((args as { request: Parameters<typeof fallbackAnalyze>[0] }).request),
        analyzerVersion: "1",
      }),
    });
    const recorder = mockRecorder();
    const { container } = renderApp();

    await waitFor(async () => expect(await modelEntry("base.en")).toHaveTextContent(/ready/i));
    await userEvent.click(screen.getByRole("button", { name: /^record$/i }));
    await waitFor(() => expect(recorder.started).toBe(true));
    recorder.feed(6);
    await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));

    await waitFor(() =>
      expect(
        native
          .called("analyze_speech_session")
          .some(
            (call) =>
              ((call.args?.request as { segments?: unknown[] } | undefined)?.segments?.length ??
                0) > 0,
          ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(within(container).getAllByText(/hello there/).length).toBeGreaterThan(0),
    );
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(storedSessions() ?? []).toHaveLength(1));
    const [saved] = storedSessions() ?? [];
    expect(saved.analysis.analyzer).toMatchObject({ producer: "desktopNative" });
    // The run names the model that produced its transcript, not a repository revision.
    const run = JSON.stringify(saved.analysis);
    expect(run).toContain("whisperCpp");
    expect(run).toContain("base.en");
    expect(remoteSpeechRequests()).toEqual([]);
  });
});
