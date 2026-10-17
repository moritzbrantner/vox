import "fake-indexeddb/auto";
import { createSessionBackup } from "./storage/sessionBackup";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as recorderModule from "./audio/browserRecorder";
import { getSessionAudio, resetSessionAudioConnection } from "./storage/sessionAudio";
import type { SavedSession } from "./types";

const STORE_KEY = "stutter-tracker:sessions";
const TEST_CAPTURE = recorderModule.describeCapture(undefined);

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

const stored = () => JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedSession[];

type Recognition = { onresult: ((event: unknown) => void) | null };

/** Records two seconds of 16 kHz audio with one final transcript segment, then stops. */
async function recordTwoSeconds() {
  let capture: recorderModule.BrowserRecorderOptions | undefined;
  vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
    capture = options;
    return { sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} };
  });
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
  await userEvent.click(screen.getByRole("button", { name: /^record$/i }));
  await waitFor(() => expect(recognitions).toHaveLength(1));
  const samples = new Float32Array(32000);
  for (let index = 0; index < samples.length; index += 1)
    samples[index] = index < 16000 ? 0.5 : 0.1;
  act(() => {
    capture!.onSamples(samples);
    recognitions[0]!.onresult!({
      resultIndex: 0,
      results: [Object.assign([{ transcript: "kept words", confidence: 0.8 }], { isFinal: true })],
    });
  });
  await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
}

class FakeSource {
  static started: Array<{ offset: number; duration?: number; loop: boolean; rate: number }> = [];
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  connect() {}
  disconnect() {}
  start(_when: number, offset: number, duration?: number) {
    FakeSource.started.push({ offset, duration, loop: this.loop, rate: this.playbackRate.value });
  }
  stop() {}
}
class FakeAudioContext {
  destination = {};
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { length, sampleRate, copyToChannel() {} };
  }
  createBufferSource() {
    return new FakeSource();
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetSessionAudioConnection();
  FakeSource.started = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("audio kept for review (vox#23)", () => {
  it("keeps nothing unless the user opts in for the session", async () => {
    renderApp();
    await recordTwoSeconds();
    expect(screen.getByLabelText("Keep audio on this device for review")).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(await getSessionAudio(stored()[0].id)).toBeNull();
    expect(await screen.findByText(/No audio was kept with this session/)).toBeInTheDocument();
  });

  it("keeps the raw capture, reviews spans with loop and speed, and removes it with the session", async () => {
    renderApp();
    await recordTwoSeconds();
    await userEvent.click(screen.getByLabelText("Keep audio on this device for review"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/audio kept on this device for review/);

    const [session] = stored();
    const kept = await getSessionAudio(session.id);
    expect(kept).toMatchObject({ sessionId: session.id, sampleRate: 16000, droppedSeconds: 0 });
    expect(kept!.samples).toHaveLength(32000);
    expect(kept!.samples[0]).toBe(0.5);
    // The session record and its backups do not carry audio.
    expect(JSON.stringify(createSessionBackup(stored(), new Date()))).not.toContain('"samples"');

    const workbench = await screen.findByRole("region", { name: "Annotate events" });
    expect(await within(workbench).findByRole("img", { name: /Waveform/ })).toBeInTheDocument();
    await userEvent.type(within(workbench).getByLabelText("New event start"), "0.5{Enter}");
    await userEvent.type(within(workbench).getByLabelText("New event end"), "1.25{Enter}");
    await userEvent.click(within(workbench).getByRole("button", { name: "Add event" }));
    await userEvent.selectOptions(within(workbench).getByLabelText("Review speed"), "0.5");
    await userEvent.click(within(workbench).getByRole("button", { name: "Play event 1" }));
    expect(FakeSource.started).toEqual([
      { offset: 0.5, duration: undefined, loop: true, rate: 0.5 },
    ]);
    await userEvent.click(within(workbench).getByLabelText("Loop"));
    await userEvent.click(within(workbench).getByRole("button", { name: "Play event 1" }));
    expect(FakeSource.started[1]).toEqual({ offset: 0.5, duration: 0.75, loop: false, rate: 0.5 });

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: /Delete saved session from/ }));
    await waitFor(() => expect(stored()).toEqual([]));
    expect(await getSessionAudio(session.id)).toBeNull();
  });

  it("a restore removes kept audio, since backups contain none", async () => {
    const { unmount } = renderApp();
    await recordTwoSeconds();
    await userEvent.click(screen.getByLabelText("Keep audio on this device for review"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/audio kept on this device for review/);
    const sessions = stored();
    expect(await getSessionAudio(sessions[0].id)).not.toBeNull();
    unmount();
    vi.unstubAllGlobals();
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();
    const input = await screen.findByLabelText<HTMLInputElement>("Choose session backup");
    await waitFor(() => expect(input).not.toBeDisabled());
    const backup = JSON.stringify(createSessionBackup(sessions, new Date()));
    await userEvent.upload(input, new File([backup], "backup.json", { type: "application/json" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(stored().map((session) => session.id)).toEqual([sessions[0].id]);
    expect(await getSessionAudio(sessions[0].id)).toBeNull();
  });
});
