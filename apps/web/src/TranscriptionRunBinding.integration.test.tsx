// vox#26: a recording's transcription is bound to the settings selected when it started, and the
// verbatim transcript (repetitions, fragments, fillers) is what analysis and saving receive.
import { fallbackAnalyze } from "@stutter-tracker/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as tauriCore from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as recorderModule from "./audio/browserRecorder";
import type { SavedSession } from "./types";

const STORE_KEY = "stutter-tracker:sessions";
const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
const TEST_CAPTURE = recorderModule.describeCapture(undefined);
const VERBATIM = "I I I w-want um wa- water";

type Call = { command: string; args: Record<string, unknown> | undefined };

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem(
    TRANSCRIPTION_KEY,
    JSON.stringify({ engine: "whisperCpp", model: "base.en" }),
  );
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("transcription run binding and verbatim evidence (vox#26)", () => {
  it("keeps the start language for queued chunks and saves exactly what was recognized", async () => {
    const calls: Call[] = [];
    const pending: Array<(value: unknown) => void> = [];
    const invoke = vi.spyOn(tauriCore, "invoke").mockImplementation(async (command, args) => {
      calls.push({ command, args: args as Record<string, unknown> | undefined });
      if (command === "transcription_models") {
        return { models: [{ id: "base.en", label: "base.en", cached: true, downloadable: true }] };
      }
      if (command === "transcribe_audio") {
        return new Promise((resolve) => pending.push(resolve));
      }
      if (command === "analyze_speech_session") {
        const request = (args as { request: Parameters<typeof fallbackAnalyze>[0] }).request;
        return { ...fallbackAnalyze(request), analyzerVersion: "1" };
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
    const language = screen.getByLabelText("Recognition language");
    expect(language).toHaveValue("en-US");
    await userEvent.click(await screen.findByRole("button", { name: /^record$/i }));
    await waitFor(() => expect(capture).toBeDefined());
    act(() => capture!.onSamples(new Float32Array(16000 * 10).fill(0.2)));
    await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));

    // Changing the selection while the run's chunks are still being transcribed.
    await waitFor(() => expect(language).toBeEnabled());
    await userEvent.selectOptions(language, "de-DE");
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const resolveAll = async () => {
      while (pending.length) {
        const resolve = pending.shift()!;
        await act(async () =>
          resolve({
            segments: [
              { text: VERBATIM, startSeconds: 0, endSeconds: 2, confidence: 0.9, isFinal: true },
            ],
            provider: "whisperCpp",
            model: "base.en",
          }),
        );
      }
    };
    await resolveAll();
    await waitFor(async () => {
      await resolveAll();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    const languages = calls
      .filter((call) => call.command === "transcribe_audio")
      .map((call) => (call.args!.request as { language: string }).language);
    expect(languages.length).toBeGreaterThan(1);
    expect(new Set(languages)).toEqual(new Set(["en-US"]));

    const analyzed = calls
      .filter((call) => call.command === "analyze_speech_session")
      .map((call) => (call.args!.request as { segments: Array<{ text: string }> }).segments)
      .at(-1)!;
    expect(analyzed.map((segment) => segment.text)).toEqual(languages.map(() => VERBATIM));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toHaveLength(1),
    );
    const [saved] = JSON.parse(localStorage.getItem(STORE_KEY)!) as SavedSession[];
    expect(saved.context.spokenLanguage).toBe("en");
    expect(saved.segments.map((segment) => segment.text)).toEqual(languages.map(() => VERBATIM));

    // The readable view is display only.
    expect(screen.getByLabelText("Verbatim transcript")).toHaveTextContent(VERBATIM);
    await userEvent.click(screen.getByLabelText(/Readable view/));
    expect(screen.getByLabelText("Readable transcript")).toHaveTextContent(/^I want water/);
    expect(
      (JSON.parse(localStorage.getItem(STORE_KEY)!) as SavedSession[])[0].segments[0].text,
    ).toBe(VERBATIM);
  });

  it("sends the device preference and records the backend and device that ran (vox#139)", async () => {
    const devices: unknown[] = [];
    const compute = { backend: "nativeWhisperx", device: "cuda" } as const;
    const invoke = vi.spyOn(tauriCore, "invoke").mockImplementation(async (command, args) => {
      if (command === "transcription_models") {
        return { models: [{ id: "base.en", label: "base.en", cached: true, downloadable: true }] };
      }
      if (command === "transcribe_audio") {
        devices.push((args as { request: { device: unknown } }).request.device);
        return {
          segments: [{ text: "hello", startSeconds: 0, endSeconds: 1, isFinal: true }],
          provider: "whisperCpp",
          model: "base.en",
          compute,
        };
      }
      if (command === "analyze_speech_session") {
        const request = (args as { request: Parameters<typeof fallbackAnalyze>[0] }).request;
        return { ...fallbackAnalyze(request), analyzerVersion: "1" };
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
    const cpuOnly = screen.getByLabelText("CPU only");
    expect(cpuOnly).not.toBeChecked();
    await userEvent.click(cpuOnly);
    expect(JSON.parse(localStorage.getItem(TRANSCRIPTION_KEY)!).device).toBe("cpu");
    await userEvent.click(cpuOnly);
    await userEvent.click(await screen.findByRole("button", { name: /^record$/i }));
    await waitFor(() => expect(capture).toBeDefined());
    act(() => capture!.onSamples(new Float32Array(16000 * 10).fill(0.2)));
    await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());

    expect(devices.length).toBeGreaterThan(0);
    expect(new Set(devices)).toEqual(new Set(["auto"]));
    expect(screen.getByLabelText("Transcription device")).toHaveTextContent(
      "native-whisperx on CUDA",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toHaveLength(1),
    );
    const [saved] = JSON.parse(localStorage.getItem(STORE_KEY)!) as SavedSession[];
    expect(saved.transcript?.provenance?.compute).toEqual(compute);
  });
});
