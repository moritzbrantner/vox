// vox#26: partial-to-final identity of the live transcript, unaligned spans shown without timing,
// transcript provenance, and the user-started post-session reference transcript.
import "fake-indexeddb/auto";
import { fallbackAnalyze } from "@stutter-tracker/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as tauriCore from "@tauri-apps/api/core";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as recorderModule from "./audio/browserRecorder";
import { resetSessionAudioConnection } from "./storage/sessionAudio";
import type { SavedSession } from "./types";

const STORE_KEY = "stutter-tracker:sessions";
const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
const TEST_CAPTURE = recorderModule.describeCapture(undefined);

const stored = () => JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedSession[];

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

const result = (transcript: string, isFinal: boolean) =>
  Object.assign([{ transcript, confidence: 0.8 }], { isFinal });

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetSessionAudioConnection();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser speech partial-to-final identity (vox#26)", () => {
  it("ignores repeated finals and late partials and marks the untimed transcript", async () => {
    vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async () => {
      return { sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} };
    });
    type Recognition = { onresult: ((event: unknown) => void) | null };
    const recognitions: Recognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror = null;
      onend: (() => void) | null = null;
      constructor() {
        recognitions.push(this);
      }
      start() {}
      stop() {
        setTimeout(() => this.onend?.(), 0);
      }
      abort() {}
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: /^record$/i }));
    await waitFor(() => expect(recognitions).toHaveLength(1));
    const recognition = recognitions[0]!;
    const transcript = () => screen.getByLabelText("Verbatim transcript");

    act(() => recognition.onresult!({ resultIndex: 0, results: [result("I I", false)] }));
    expect(transcript()).toHaveTextContent("I I");
    act(() => recognition.onresult!({ resultIndex: 0, results: [result("I I want", true)] }));
    // The same final delivered again, then a late partial of the finalized result.
    act(() => recognition.onresult!({ resultIndex: 0, results: [result("I I want", true)] }));
    act(() => recognition.onresult!({ resultIndex: 0, results: [result("I I wa", false)] }));
    expect(transcript().textContent).toBe("I I want (timing not aligned)");

    await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stored()).toHaveLength(1));
    const [saved] = stored();
    expect(saved.segments).toHaveLength(1);
    expect(saved.segments[0]).toMatchObject({ text: "I I want", alignment: "unaligned" });
    expect(saved.report.events.filter((event) => event.kind === "wordRepetition")).toHaveLength(1);
    expect(saved.transcript).toMatchObject({
      kind: "provisional",
      supersedes: null,
      provenance: {
        engine: "browser",
        language: "en-US",
        preprocessing: { captureSampleRate: null, modelSampleRate: null, chunkSeconds: null },
        limitations: ["noTiming", "recognizerAudioUnknown"],
      },
    });
  });
});

describe("post-session reference transcript (vox#26)", () => {
  it("re-transcribes kept audio with a larger model as a new revision, on request only", async () => {
    localStorage.setItem(
      TRANSCRIPTION_KEY,
      JSON.stringify({ engine: "whisperCpp", model: "base.en" }),
    );
    const requests: Array<{ command: string; request: Record<string, unknown> }> = [];
    let referenceCached = false;
    const invoke = vi.spyOn(tauriCore, "invoke").mockImplementation(async (command, args) => {
      const request = (args as { request: Record<string, unknown> } | undefined)?.request ?? {};
      requests.push({ command, request });
      if (command === "transcription_models") {
        return {
          models: [
            { id: "base.en", label: "base.en", cached: true, downloadable: true },
            {
              id: "large-v3-turbo",
              label: "large-v3-turbo",
              cached: referenceCached,
              downloadable: true,
            },
          ],
        };
      }
      if (command === "download_transcription_model") {
        referenceCached = true;
        return { id: request.model, label: request.model, cached: true, downloadable: true };
      }
      if (command === "transcribe_audio") {
        const text = request.model === "base.en" ? "I want water" : "I I w-want wa- water";
        return {
          segments: [{ text, startSeconds: 0.2, endSeconds: 1.8, confidence: 0.9, isFinal: true }],
          provider: "whisperCpp",
          model: request.model,
          language: "en",
        };
      }
      if (command === "analyze_speech_session") {
        return { ...fallbackAnalyze(request as never), analyzerVersion: "1" };
      }
      throw new Error(`Native command ${command} unavailable in this fixture`);
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
    let capture: recorderModule.BrowserRecorderOptions | undefined;
    vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
      capture = options;
      return { sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} };
    });

    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: /^record$/i }));
    await waitFor(() => expect(capture).toBeDefined());
    act(() => capture!.onSamples(new Float32Array(32000).fill(0.2)));
    await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await userEvent.click(screen.getByLabelText("Keep audio on this device for review"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/audio kept on this device for review/);
    const [provisional] = stored();
    expect(provisional.transcript?.provenance).toMatchObject({
      engine: "whisperCpp",
      model: "base.en",
      language: "en-US",
      detectedLanguage: "en",
      preprocessing: { captureSampleRate: 16000, modelSampleRate: 16000, chunkSeconds: 8 },
      limitations: [],
    });
    // Nothing ran on its own.
    expect(requests.filter((call) => call.request.model === "large-v3-turbo")).toEqual([]);

    const panel = await screen.findByRole("region", { name: "Transcript revisions" });
    const model = await within(panel).findByLabelText("Reference model");
    await waitFor(() =>
      expect(
        within(panel).getByRole("option", { name: "large-v3-turbo (download)" }),
      ).toBeVisible(),
    );
    expect(model).toHaveValue("large-v3-turbo");
    await userEvent.click(within(panel).getByRole("button", { name: "Make reference transcript" }));
    await waitFor(() => expect(stored()[0].transcript?.kind).toBe("reference"));
    await waitFor(() => expect(stored()[0].priorAnalyses).toHaveLength(1));

    const [revised] = stored();
    expect(requests.map((call) => call.command)).toContain("download_transcription_model");
    const reference = requests.filter(
      (call) => call.command === "transcribe_audio" && call.request.model === "large-v3-turbo",
    );
    expect(reference).toHaveLength(1);
    expect(reference[0].request.language).toBe("en-US");
    expect(revised.segments.map((segment) => segment.text)).toEqual(["I I w-want wa- water"]);
    expect(revised.priorTranscripts).toEqual([
      { ...provisional.transcript, segments: provisional.segments },
    ]);
    expect(revised.transcript).toMatchObject({
      supersedes: provisional.transcript!.id,
      provenance: { model: "large-v3-turbo", preprocessing: { chunkSeconds: 30 } },
      reconciliation: { unchangedWords: 2, insertedWords: 2, substitutedWords: 1, deletedWords: 0 },
    });
    // The session is reanalyzed from the reference; the provisional run stays in its history.
    expect(revised.analysis.transcription).toEqual({
      engine: "whisperCpp",
      model: "large-v3-turbo",
    });
    expect(revised.priorAnalyses[0].id).toBe(provisional.analysis.id);
    expect(
      revised.report.events.filter((event) => event.kind === "wordRepetition"),
    ).not.toHaveLength(0);
    // The recording selection is untouched by the reference model download.
    expect(JSON.parse(localStorage.getItem(TRANSCRIPTION_KEY)!)).toEqual({
      engine: "whisperCpp",
      model: "base.en",
    });
    // Both revisions stay readable.
    expect(
      within(panel).getByRole("listitem", { name: "Provisional transcript" }),
    ).toHaveTextContent("I want water");
    expect(screen.getByLabelText("Verbatim transcript")).toHaveTextContent("I I w-want wa- water");
  });
});
