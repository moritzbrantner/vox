import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackAnalyze } from "@stutter-tracker/shared";
import { ON_DEVICE_ANALYZER } from "@stutter-tracker/compute-client";
import { App } from "./App";
import * as tauriCore from "@tauri-apps/api/core";
import * as recorderModule from "./audio/browserRecorder";

const TEST_CAPTURE = recorderModule.describeCapture(undefined);

type AnalyzeRun =
  import("@stutter-tracker/compute-client").ComputeClient["analyzeSpeechSessionRun"];
// Lets a test control analyzer responses; null passes through to the real client.
let analysisHook: AnalyzeRun | null = null;
type DeleteSpeaker =
  import("@stutter-tracker/compute-client").ComputeClient["deleteSpeakerProfile"];
let deleteSpeakerHook: DeleteSpeaker | null = null;
type CreateSpeaker =
  import("@stutter-tracker/compute-client").ComputeClient["createSpeakerProfile"];
let createSpeakerHook: CreateSpeaker | null = null;
type ListSpeakers = import("@stutter-tracker/compute-client").ComputeClient["listSpeakerProfiles"];
let listSpeakersHook: ListSpeakers | null = null;
type SaveSpeakers = import("@stutter-tracker/compute-client").ComputeClient["saveSpeakerProfiles"];
let saveSpeakersHook: SaveSpeakers | null = null;
type IdentifySpeaker = import("@stutter-tracker/compute-client").ComputeClient["identifySpeaker"];
let identifySpeakerHook: IdentifySpeaker | null = null;
// Records every call into the audio-analysis WASM capture kernel; a hook replaces the real kernel.
type KernelCall = { samples: ArrayLike<number>; sampleRate: number; channels: unknown };
const captureKernelCalls: KernelCall[] = [];
let captureKernelHook: ((...args: unknown[]) => Promise<unknown>) | null = null;

vi.mock("@stutter-tracker/compute-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stutter-tracker/compute-client")>();
  return {
    ...actual,
    createComputeClient: (...args: Parameters<typeof actual.createComputeClient>) => {
      const client = actual.createComputeClient(...args);
      return {
        ...client,
        get destination() {
          return saveSpeakersHook
            ? {
                kind: "server" as const,
                mode: "localCompanion" as const,
                url: "http://localhost:4321",
                label: "Test companion",
              }
            : client.destination;
        },
        saveSpeakerProfiles: (profiles: Parameters<SaveSpeakers>[0]) =>
          saveSpeakersHook ? saveSpeakersHook(profiles) : client.saveSpeakerProfiles(profiles),
        analyzeSpeechSessionRun: (request: Parameters<AnalyzeRun>[0]) =>
          analysisHook ? analysisHook(request) : client.analyzeSpeechSessionRun(request),
        identifySpeaker: (request: Parameters<IdentifySpeaker>[0]) =>
          identifySpeakerHook ? identifySpeakerHook(request) : client.identifySpeaker(request),
        listSpeakerProfiles: () =>
          listSpeakersHook ? listSpeakersHook() : client.listSpeakerProfiles(),
        createSpeakerProfile: (request: Parameters<CreateSpeaker>[0]) =>
          createSpeakerHook ? createSpeakerHook(request) : client.createSpeakerProfile(request),
        deleteSpeakerProfile: (id: string) =>
          deleteSpeakerHook ? deleteSpeakerHook(id) : client.deleteSpeakerProfile(id),
      };
    },
  };
});

// The browser-local path measures capture quality with the owner's WASM kernel (vox#89); the
// real kernel runs unless a test replaces it.
vi.mock("@moritzbrantner/audio-analysis-core-wasm", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realCaptureMetrics = actual.captureMetrics as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    captureMetrics: (...args: unknown[]) => {
      captureKernelCalls.push({
        samples: args[0] as ArrayLike<number>,
        sampleRate: args[1] as number,
        channels: args[2],
      });
      return captureKernelHook ? captureKernelHook(...args) : realCaptureMetrics(...args);
    },
  };
});

const STORE_KEY = "stutter-tracker:sessions";
const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
const originalMediaDevices = navigator.mediaDevices;
const originalAudioContext = window.AudioContext;
const originalWebkitAudioContext = window.webkitAudioContext;

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

afterEach(async () => {
  // Unmount first and let work the app had in flight settle, so a late checkpoint or session
  // write from this test cannot land in the next test's cleared storage.
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  analysisHook = null;
  deleteSpeakerHook = null;
  createSpeakerHook = null;
  listSpeakersHook = null;
  saveSpeakersHook = null;
  identifySpeakerHook = null;
  captureKernelHook = null;
  captureKernelCalls.length = 0;
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  localStorage.clear();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
  window.AudioContext = originalAudioContext;
  window.webkitAudioContext = originalWebkitAudioContext;
});

describe("App integration", () => {
  it("loads a saved session and deletes it from persistence and the active workspace", async () => {
    const savedSession = {
      id: "session-1",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [
        {
          text: "I I want to start",
          startSeconds: 0,
          endSeconds: 3,
          confidence: 0.91,
          isFinal: true,
        },
      ],
      pauses: [{ startSeconds: 3.2, endSeconds: 4.1, afterText: "start" }],
      report: {
        totalDurationSeconds: 4.1,
        wordCount: 4,
        stutterCount: 2,
        stuttersPerMinute: 29.27,
        severity: "high",
        events: [
          {
            kind: "wordRepetition",
            startSeconds: 0,
            endSeconds: 1.2,
            text: "I I",
            detail: "Repeated word sequence",
            confidence: 0.78,
          },
          {
            kind: "block",
            startSeconds: 3.2,
            endSeconds: 4.1,
            text: "start",
            detail: "0.9s silent pause before speech",
            confidence: 0.62,
            source: "fused",
            acousticEvidence: {
              silenceSeconds: 0.9,
              onsetCount: 1,
            },
          },
        ],
        byKind: { wordRepetition: 1, block: 1 },
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([savedSession]));

    const { container } = renderApp();
    const sessionButton = container.querySelector<HTMLButtonElement>(".session-row");
    expect(sessionButton).not.toBeNull();
    expect(within(sessionButton!).getByText("Analysis origin not recorded")).toBeInTheDocument();

    await userEvent.click(sessionButton!);

    // Workspace transcript, session transcript and the annotation workbench's transcript.
    expect(await screen.findAllByText("I I want to start")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Annotate events" })).toBeInTheDocument();
    // The stored report is shown as saved; it has no chunk breakdown and none is computed.
    expect(await screen.findByText("Repeated word sequence")).toBeInTheDocument();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: /Delete saved session from/ }));

    await waitFor(() => expect(container.querySelector(".session-row")).toBeNull());
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null")).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByText("Repeated word sequence")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Transcript will appear here.")).toBeInTheDocument();
  });

  it("saving an unchanged loaded session makes no copy", async () => {
    const legacy = {
      id: "session-1",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [
        {
          text: "I I want to start",
          startSeconds: 0,
          endSeconds: 3,
          confidence: 0.91,
          isFinal: true,
        },
      ],
      pauses: [],
      report: {
        totalDurationSeconds: 3,
        wordCount: 5,
        stutterCount: 1,
        stuttersPerMinute: 20,
        severity: "high",
        events: [],
        byKind: {},
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([legacy]));
    const { container } = renderApp();

    await userEvent.click(container.querySelector<HTMLButtonElement>(".session-row")!);
    await screen.findAllByText("I I want to start");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // Nothing changed, so nothing is written and no copy is made.
    expect(await screen.findByText("Session is already saved")).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as { id: string }[];
    expect(stored.map((session) => session.id)).toEqual(["session-1"]);
  });

  it("shows a loaded session's stored analysis even when a pending analysis resolves later", async () => {
    const stored = {
      id: "session-stored",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [
        {
          text: "I I want to start",
          startSeconds: 0,
          endSeconds: 3,
          confidence: 0.9,
          isFinal: true,
        },
      ],
      pauses: [],
      report: {
        totalDurationSeconds: 3,
        wordCount: 5,
        stutterCount: 1,
        stuttersPerMinute: 20,
        severity: "high",
        events: [
          {
            kind: "prolongation",
            startSeconds: 0.5,
            endSeconds: 1.5,
            text: "want",
            detail: "Stored marker event",
            confidence: 0.7,
          },
        ],
        byKind: { prolongation: 1 },
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([stored]));
    const requests: Parameters<AnalyzeRun>[0][] = [];
    let resolvePending!: (value: Awaited<ReturnType<AnalyzeRun>>) => void;
    analysisHook = (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    };
    const { container } = renderApp();
    // The initial workspace analysis is in flight when the saved session is loaded.
    await waitFor(() => expect(requests).toHaveLength(1));

    await userEvent.click(container.querySelector<HTMLButtonElement>(".session-row")!);
    expect(await screen.findByText("Stored marker event")).toBeInTheDocument();

    const lateReport = fallbackAnalyze({ segments: [], pauses: [] });
    await act(async () =>
      resolvePending({
        report: {
          ...lateReport,
          events: [
            { ...stored.report.events[0], kind: "prolongation", detail: "Late live result" },
          ],
        },
        analyzer: { producer: "onDevice", algorithm: "test", version: null },
      }),
    );

    expect(screen.getByText("Stored marker event")).toBeInTheDocument();
    expect(screen.queryByText("Late live result")).not.toBeInTheDocument();
    // Loading a saved session runs no analysis of its own.
    expect(requests).toHaveLength(1);
  });

  it("keeps a session when deletion is cancelled or its storage write fails", async () => {
    const stored = {
      id: "session-keep",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [],
      pauses: [],
      report: {
        totalDurationSeconds: 1,
        wordCount: 0,
        stutterCount: 0,
        stuttersPerMinute: 0,
        severity: "none",
        events: [],
        byKind: {},
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([stored]));
    const { container } = renderApp();
    const deleteButton = () => screen.getByRole("button", { name: /Delete saved session from/ });

    vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(deleteButton());
    expect(container.querySelectorAll(".session-row")).toHaveLength(1);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === STORE_KEY) {
        throw new DOMException("full", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    });
    await userEvent.click(deleteButton());

    expect(await screen.findByText(/Delete failed/)).toBeInTheDocument();
    expect(container.querySelectorAll(".session-row")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toHaveLength(1);
  });

  it("leaves unknown-quality sessions out of the corpus event totals and says so", async () => {
    const stored = (id: string, captureQuality?: unknown) => ({
      id,
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [{ text: "I want to start", startSeconds: 0, endSeconds: 3, isFinal: true }],
      pauses: [],
      report: {
        totalDurationSeconds: 60,
        wordCount: 4,
        stutterCount: 9,
        stuttersPerMinute: 9,
        severity: "moderate",
        events: [],
        byKind: {},
        ...(captureQuality ? { captureQuality } : {}),
      },
    });
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        stored("session-clipped", {
          state: "unknown",
          issues: ["clipping"],
          explanation: "Result unknown: the input is clipping (too loud).",
        }),
        stored("session-plain"),
      ]),
    );
    renderApp();

    expect(
      await screen.findByText(
        "1 corpus session has unknown capture quality; its events are left out of the totals.",
      ),
    ).toBeInTheDocument();
  });

  it("reanalyzes a saved session on request and keeps the earlier run", async () => {
    const legacy = {
      id: "session-re",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [
        {
          text: "I I want to start",
          startSeconds: 0,
          endSeconds: 3,
          confidence: 0.9,
          isFinal: true,
        },
      ],
      pauses: [],
      report: {
        totalDurationSeconds: 3,
        wordCount: 5,
        stutterCount: 0,
        stuttersPerMinute: 0,
        severity: "none",
        events: [],
        byKind: {},
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([legacy]));
    renderApp();

    expect(
      await screen.findByText(/1 corpus session has an analysis that is not verified/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Reanalyze saved session from/ }));

    expect(await screen.findByText("Reanalysis added to the session")).toBeInTheDocument();
    const [stored] = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as {
      analysis: { id: string; analyzer: { producer: string } | null };
      priorAnalyses: { id: string }[];
    }[];
    expect(stored.priorAnalyses.map((run) => run.id)).toEqual(["session-re:legacy"]);
    expect(stored.analysis.analyzer?.producer).toBe("onDevice");
    expect(screen.getByText(/2 analysis runs/)).toBeInTheDocument();
    expect(screen.queryByText(/has an analysis that is not verified/)).not.toBeInTheDocument();
  });

  it("does not offer reanalysis for a session with no saved transcript", async () => {
    const acousticOnly = {
      id: "session-acoustic",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [],
      pauses: [],
      report: {
        totalDurationSeconds: 3,
        wordCount: 0,
        stutterCount: 1,
        stuttersPerMinute: 20,
        severity: "high",
        events: [
          {
            kind: "block",
            startSeconds: 1,
            endSeconds: 2,
            text: "",
            detail: "Acoustic block",
            confidence: 0.6,
            source: "acoustic",
          },
        ],
        byKind: { block: 1 },
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([acousticOnly]));
    renderApp();

    expect(
      await screen.findByRole("button", { name: /Reanalyze saved session from/ }),
    ).toBeDisabled();
  });

  it("removes a voiceprint here and on the server, and says when only the local copy went", async () => {
    const speakerProfiles = [
      {
        id: "speaker-a",
        label: "Alex",
        embeddings: [[1, 0]],
        sampleRate: 16_000,
        sampleCount: 16_000,
      },
      {
        id: "speaker-b",
        label: "Blair",
        embeddings: [[0, 1]],
        sampleRate: 16_000,
        sampleCount: 16_000,
      },
    ];
    localStorage.setItem("stutter-tracker:speakers", JSON.stringify(speakerProfiles));
    const deleted: string[] = [];
    deleteSpeakerHook = async (id) => {
      deleted.push(id);
      return "deleted";
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();

    await userEvent.click(await screen.findByRole("button", { name: "Remove speaker Alex" }));
    expect(
      await screen.findByText("Removed Alex here and from the compute server"),
    ).toBeInTheDocument();
    expect(deleted).toEqual(["speaker-a"]);
    expect(
      (
        JSON.parse(localStorage.getItem("stutter-tracker:speakers") ?? "[]") as { id: string }[]
      ).map((profile) => profile.id),
    ).toEqual(["speaker-b"]);

    deleteSpeakerHook = async () => {
      throw new Error("server unreachable");
    };
    await userEvent.click(screen.getByRole("button", { name: "Remove speaker Blair" }));
    expect(
      await screen.findByText(
        /Removed Blair on this device only; deleting it from the compute server failed/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove speaker/ })).not.toBeInTheDocument();
  });

  it("removes a legacy voiceprint for good and keeps a speaker whose local removal failed", async () => {
    localStorage.setItem(
      "stutter-tracker:voiceprint",
      JSON.stringify({ embedding: [1, 0], sampleRate: 16_000, sampleCount: 16_000 }),
    );
    deleteSpeakerHook = async () => "noServer";
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { unmount } = renderApp();

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove speaker Enrolled speaker" }),
    );
    expect(await screen.findByText(/Removed Enrolled speaker/)).toBeInTheDocument();
    expect(localStorage.getItem("stutter-tracker:voiceprint")).toBeNull();
    unmount();

    localStorage.setItem(
      "stutter-tracker:speakers",
      JSON.stringify([
        {
          id: "speaker-a",
          label: "Alex",
          embeddings: [[1, 0]],
          sampleRate: 16_000,
          sampleCount: 16_000,
        },
      ]),
    );
    renderApp();
    const button = await screen.findByRole("button", { name: "Remove speaker Alex" });
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "stutter-tracker:speakers") {
        throw new DOMException("blocked", "SecurityError");
      }
      return setItem.call(this, key, value);
    });
    await userEvent.click(button);

    expect(await screen.findByText(/Could not remove Alex from this browser/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove speaker Alex" })).toBeInTheDocument();
  });

  it("previews and exports only the sessions and content the user chooses", async () => {
    const make = (id: string, startedAt: string, text: string) => ({
      id,
      startedAt,
      segments: [{ text, startSeconds: 0, endSeconds: 2, confidence: 0.9, isFinal: true }],
      pauses: [],
      report: {
        totalDurationSeconds: 60,
        wordCount: 4,
        stutterCount: 1,
        stuttersPerMinute: 1,
        severity: "mild",
        events: [],
        byKind: {},
      },
    });
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        make("chosen", "2026-05-19T10:00:00.000Z", "Shared sentence here"),
        make("other", "2026-05-20T10:00:00.000Z", "Private sentence elsewhere"),
      ]),
    );
    renderApp();

    await userEvent.click(screen.getByRole("button", { name: "Choose sessions" }));
    const panel = screen.getByRole("region", { name: "Export for review" });
    expect(within(panel).getByRole("button", { name: /Download report/ })).toBeDisabled();
    const checkboxes = within(panel).getAllByRole("checkbox");
    await userEvent.click(checkboxes[0]);
    await userEvent.click(within(panel).getByRole("checkbox", { name: "Transcripts" }));

    const preview = within(panel).getByLabelText("Export preview");
    expect(preview).toHaveTextContent("Sessions: 1");
    expect(preview).toHaveTextContent("Shared sentence here");
    expect(preview).not.toHaveTextContent("Private sentence elsewhere");
    expect(preview).toHaveTextContent("Automated estimate (model, not a judgment)");
    await userEvent.click(within(panel).getByRole("checkbox", { name: /I consent to sharing/ }));
    expect(within(panel).getByRole("button", { name: /Download report/ })).toBeEnabled();

    await userEvent.click(within(panel).getByRole("button", { name: "Data (JSON)" }));
    expect(preview).toHaveTextContent('"schema": "vox-evidence-export"');
    expect(preview).not.toHaveTextContent("Private sentence elsewhere");
  });

  it("keeps external-server transcription settings in web mode", async () => {
    localStorage.setItem(
      TRANSCRIPTION_KEY,
      JSON.stringify({ engine: "whisperCpp", model: "small.en" }),
    );

    renderApp();

    const engineSelect = screen.getByLabelText<HTMLSelectElement>("Transcription engine");
    const modelSelect = screen.getByLabelText<HTMLSelectElement>("Transcription model");

    await waitFor(() => expect(engineSelect.value).toBe("whisperCpp"));
    expect(modelSelect.value).toBe("small.en");
    expect(JSON.parse(localStorage.getItem(TRANSCRIPTION_KEY) ?? "{}")).toEqual({
      engine: "whisperCpp",
      model: "small.en",
    });
  });

  it("renders the empty dashboard without microphone permissions", () => {
    renderApp();

    expect(screen.getByRole("button", { name: /record/i })).toBeEnabled();
    expect(screen.getByText("Transcript will appear here.")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Processing status")).getByText("Recording"),
    ).toBeInTheDocument();
  });

  it("shows denied microphone permission and leaves Record enabled", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });
    renderApp();

    const recordButton = screen.getByRole("button", { name: /record/i });
    await userEvent.click(recordButton);

    expect(await screen.findByText("Microphone permission was denied")).toBeInTheDocument();
    expect(recordButton).toBeEnabled();
  });

  it("shows unavailable recording when AudioContext is missing", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    window.AudioContext = undefined as unknown as typeof AudioContext;
    window.webkitAudioContext = undefined;
    renderApp();

    await userEvent.click(screen.getByRole("button", { name: /record/i }));

    expect(
      await screen.findByText("Microphone recording is unavailable in this browser"),
    ).toBeInTheDocument();
  });
});

it("does not restore a removed voiceprint from a pending re-enrollment", async () => {
  const profile = {
    id: "speaker-a",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 16000,
  };
  localStorage.setItem("stutter-tracker:speakers", JSON.stringify([profile]));
  let capture: recorderModule.BrowserRecorderOptions | undefined;
  vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
    capture = options;
    return { sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} };
  });
  let finishEnrollment: ((value: typeof profile) => void) | undefined;
  createSpeakerHook = () =>
    new Promise((resolve) => {
      finishEnrollment = resolve;
    });
  let finishDeletion: (() => void) | undefined;
  deleteSpeakerHook = () =>
    new Promise((resolve) => {
      finishDeletion = () => resolve("deleted");
    });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const user = userEvent.setup();
  renderApp();
  await screen.findByRole("button", { name: "Remove speaker Alex" });
  await user.click(screen.getByRole("button", { name: /record/i }));
  act(() => {
    capture!.onSamples(new Float32Array(16000));
    capture!.onLevel(0.1);
  });
  await user.type(screen.getByRole("textbox", { name: "Speaker label" }), "Alex");
  await user.click(screen.getAllByRole("button", { name: "Enroll" }).at(-1)!);
  await waitFor(() => expect(finishEnrollment).toBeDefined());
  await user.click(screen.getByRole("button", { name: "Remove speaker Alex" }));
  await waitFor(() => expect(finishDeletion).toBeDefined());
  await act(async () => {
    finishEnrollment!(profile);
  });
  expect(screen.queryByRole("button", { name: "Remove speaker Alex" })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem("stutter-tracker:speakers") ?? "[]")).toEqual([]);
  await act(async () => {
    finishDeletion!();
  });
});

it.each(["malformed", "absent"])(
  "removes server-only profiles with %s local data",
  async (kind) => {
    if (kind === "malformed") {
      localStorage.setItem("stutter-tracker:speakers", "{broken");
    }
    listSpeakersHook = async () => [
      {
        id: "server-speaker",
        label: "Server Alex",
        embeddings: [[1, 0]],
        sampleRate: 16000,
        sampleCount: 16000,
      },
    ];
    const deleted: string[] = [];
    deleteSpeakerHook = async (id) => {
      deleted.push(id);
      return "deleted";
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();
    const remove = await screen.findByRole("button", { name: "Remove speaker Server Alex" });
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "stutter-tracker:speakers") {
        throw new DOMException("blocked", "SecurityError");
      }
      return originalSetItem.call(this, key, value);
    });
    await userEvent.click(remove);
    expect(
      await screen.findByText("Removed Server Alex here and from the compute server"),
    ).toBeInTheDocument();
    expect(deleted).toEqual(["server-speaker"]);
    expect(
      screen.queryByRole("button", { name: "Remove speaker Server Alex" }),
    ).not.toBeInTheDocument();
  },
);

it("clears a match accepted immediately before queued profile removal", async () => {
  localStorage.setItem(
    "stutter-tracker:speakers",
    JSON.stringify([
      {
        id: "speaker-a",
        label: "Alex",
        embeddings: [[1, 0]],
        sampleRate: 16000,
        sampleCount: 16000,
      },
      {
        id: "speaker-b",
        label: "Blair",
        embeddings: [[0, 1]],
        sampleRate: 16000,
        sampleCount: 16000,
      },
    ]),
  );
  let capture: recorderModule.BrowserRecorderOptions | undefined;
  vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
    capture = options;
    return { sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} };
  });
  let finishMatch: ((value: Awaited<ReturnType<IdentifySpeaker>>) => void) | undefined;
  identifySpeakerHook = () =>
    new Promise((resolve) => {
      finishMatch = resolve;
    });
  deleteSpeakerHook = async () => "deleted";
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  const remove = await screen.findByRole("button", { name: "Remove speaker Alex" });
  await userEvent.click(screen.getByRole("button", { name: /record/i }));
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
  act(() => {
    capture!.onSamples(new Float32Array(32000).fill(0.1));
    capture!.onLevel(0.1);
  });
  now.mockRestore();
  await waitFor(() => expect(finishMatch).toBeDefined());
  await act(async () => {
    const match = { speakerId: "speaker-a", label: "Alex", score: 1 };
    finishMatch!({ bestMatch: match, matches: [match], isMatch: true });
    // Accept the asynchronous match within the same React batch as the removal gesture.
    for (let microtask = 0; microtask < 5; microtask++) {
      await Promise.resolve();
    }
    fireEvent.click(remove);
  });
  expect(
    await screen.findByText("Removed Alex here and from the compute server"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Alex 100%/)).not.toBeInTheDocument();
});

it("finishes startup migration before deleting its voiceprint", async () => {
  const profile = {
    id: "migration-alex",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 1,
    updatedAt: "2026-10-01T00:00:00Z",
  };
  localStorage.setItem("stutter-tracker:speakers", JSON.stringify([profile]));
  let finishMigration: (() => void) | undefined;
  const serverIds = new Set<string>();
  listSpeakersHook = async () => [];
  saveSpeakersHook = (profiles) =>
    new Promise((resolve) => {
      finishMigration = () => {
        for (const saved of profiles) serverIds.add(saved.id);
        resolve(profiles);
      };
    });
  const deleted = vi.fn(async (id: string) => {
    serverIds.delete(id);
    return "deleted" as const;
  });
  deleteSpeakerHook = deleted;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  await waitFor(() => expect(finishMigration).toBeDefined());
  const remove = await screen.findByRole(
    "button",
    { name: "Remove speaker Alex" },
    { timeout: 6500 },
  );
  fireEvent.click(remove);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(deleted).not.toHaveBeenCalled();
  await act(async () => finishMigration?.());
  await waitFor(() => expect(deleted).toHaveBeenCalledWith(profile.id));
  expect(serverIds.has(profile.id)).toBe(false);
}, 15000);

it("removes canonical server IDs from whitespace-padded persisted profiles", async () => {
  const profile = {
    id: "alex",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 1,
  };
  localStorage.setItem("stutter-tracker:speakers", JSON.stringify([{ ...profile, id: " alex " }]));
  listSpeakersHook = async () => [profile];
  const deleted = vi.fn(async () => "deleted" as const);
  deleteSpeakerHook = deleted;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Remove speaker Alex" }));
  await waitFor(() => expect(deleted).toHaveBeenCalledWith("alex"));
  expect(JSON.parse(localStorage.getItem("stutter-tracker:speakers")!)).toEqual([]);
});

it("reloads server-only profiles after a failed local removal during hydration", async () => {
  const alex = {
    id: "alex",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 1,
  };
  const blair = { ...alex, id: "blair", label: "Blair" };
  localStorage.setItem("stutter-tracker:speakers", JSON.stringify([alex]));
  let finishLoad: ((profiles: (typeof alex)[]) => void) | undefined;
  let requests = 0;
  listSpeakersHook = () =>
    ++requests === 1
      ? new Promise((resolve) => {
          finishLoad = resolve;
        })
      : Promise.resolve([alex, blair]);
  const deleted = vi.fn(async () => "deleted" as const);
  deleteSpeakerHook = deleted;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  const remove = await screen.findByRole(
    "button",
    { name: "Remove speaker Alex" },
    { timeout: 6500 },
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota full");
  });
  fireEvent.click(remove);
  await act(async () => {
    await Promise.resolve();
    finishLoad?.([alex, blair]);
  });
  expect(await screen.findByRole("button", { name: "Remove speaker Blair" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove speaker Alex" })).toBeInTheDocument();
  expect(deleted).not.toHaveBeenCalled();
}, 15000);

it.each([" alex ", `alex${"x".repeat(126)}`])(
  "uses a canonical ID when removing before startup hydration finishes: %s",
  async (storedId) => {
    localStorage.setItem(
      "stutter-tracker:speakers",
      JSON.stringify([
        { id: storedId, label: "Alex", embeddings: [[1, 0]], sampleRate: 16000, sampleCount: 1 },
      ]),
    );
    listSpeakersHook = () => new Promise(() => undefined);
    const deleted = vi.fn(async () => "deleted" as const);
    deleteSpeakerHook = deleted;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove speaker Alex" }, { timeout: 6500 }),
    );
    await waitFor(() => expect(deleted).toHaveBeenCalledWith(storedId.trim().slice(0, 120)));
    expect(JSON.parse(localStorage.getItem("stutter-tracker:speakers")!)).toEqual([]);
  },
  15000,
);

it("removes canonical server IDs from overlong persisted profiles", async () => {
  const profile = {
    id: "a".repeat(120),
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 1,
  };
  localStorage.setItem(
    "stutter-tracker:speakers",
    JSON.stringify([{ ...profile, id: "a".repeat(130) }]),
  );
  listSpeakersHook = async () => [profile];
  const deleted = vi.fn(async () => "deleted" as const);
  deleteSpeakerHook = deleted;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Remove speaker Alex" }));
  await waitFor(() => expect(deleted).toHaveBeenCalledWith(profile.id));
  expect(JSON.parse(localStorage.getItem("stutter-tracker:speakers")!)).toEqual([]);
});

it("reuses the data preview across parent recording renders", async () => {
  const { EvidenceExportPanel } = await import("./components/EvidenceExportPanel");
  const { createSessionRecord } = await import("@stutter-tracker/shared");
  const segments = Array.from({ length: 1000 }, (_, index) => ({
    text: `Transcript ${index} ${"words ".repeat(100)}`,
    startSeconds: index,
    endSeconds: index + 1,
    isFinal: true,
  }));
  const sessions = [
    createSessionRecord({
      id: "preview-test",
      startedAt: "2026-10-01T09:00:00.000Z",
      segments,
      pauses: [],
      report: fallbackAnalyze({ segments, pauses: [] }),
      run: { id: "run", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    }),
  ];
  const user = userEvent.setup();
  const view = render(<EvidenceExportPanel sessions={sessions} />);
  await user.click(screen.getByRole("button", { name: "Choose sessions" }));
  await user.click(screen.getAllByRole("checkbox")[0]!);
  await user.click(screen.getByRole("checkbox", { name: "Transcripts" }));
  await user.click(screen.getByRole("button", { name: "Data (JSON)" }));
  const previewText = screen.getByLabelText("Export preview").textContent;
  expect(previewText).toContain("Transcript 999");
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    for (let frame = 0; frame < 10; frame++) {
      view.rerender(<EvidenceExportPanel sessions={sessions} />);
    }
    const exports = stringify.mock.calls.filter(
      ([value]) =>
        typeof value === "object" &&
        value !== null &&
        "schema" in value &&
        value.schema === "vox-evidence-export",
    );
    expect(exports).toHaveLength(0);
    expect(screen.getByLabelText("Export preview").textContent).toBe(previewText);
  } finally {
    stringify.mockRestore();
  }
});

it("requires saved clinician-sharing consent and rechecks withdrawal before download", async () => {
  const { EvidenceExportPanel } = await import("./components/EvidenceExportPanel");
  const { CONSENT_LEDGER_KEY, recordConsentDecision } = await import("./storage/localStorage");
  const { createSessionRecord } = await import("@stutter-tracker/shared");
  localStorage.removeItem(CONSENT_LEDGER_KEY);
  const segments = [{ text: "evidence", startSeconds: 0, endSeconds: 1, isFinal: true }];
  const saved = createSessionRecord({
    id: "consent-test",
    startedAt: "2026-10-01T09:00:00Z",
    segments,
    pauses: [],
    report: fallbackAnalyze({ segments, pauses: [] }),
    run: { id: "run", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
  });
  const view = render(
    <EvidenceExportPanel sessions={[saved, { ...saved, id: "same-time-session" }]} />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Choose sessions" }));
  await user.click(screen.getAllByRole("checkbox")[0]!);
  expect(screen.getByRole("checkbox", { name: /Session 1/ })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Session 2/ })).toBeInTheDocument();
  const button = screen.getByRole("button", { name: "Download report" });
  expect(button).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I consent to sharing/ }));
  expect(JSON.parse(localStorage.getItem(CONSENT_LEDGER_KEY)!)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ purpose: "clinicianSharing", granted: true }),
    ]),
  );
  expect(button).toBeEnabled();
  recordConsentDecision({ purpose: "clinicianSharing", granted: false });
  await user.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
  expect(button).toBeDisabled();
  const consent = screen.getByRole("checkbox", { name: /I consent to sharing/ });
  await user.click(consent);
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota full");
  });
  await user.click(consent);
  expect(localStorage.getItem(CONSENT_LEDGER_KEY)).toBeNull();
  write.mockRestore();
  view.unmount();
  render(<EvidenceExportPanel sessions={[saved]} />);
  await user.click(screen.getByRole("button", { name: "Choose sessions" }));
  await user.click(screen.getByRole("checkbox", { name: /Session 1/ }));
  expect(screen.getByRole("button", { name: "Download report" })).toBeDisabled();
});

it("hydrates server-only profiles after a successful removal during startup", async () => {
  const alex = {
    id: "alex",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 1,
  };
  const blair = { ...alex, id: "blair", label: "Blair" };
  localStorage.setItem("stutter-tracker:speakers", JSON.stringify([alex]));
  let finishStartup: ((profiles: (typeof alex)[]) => void) | undefined;
  let requests = 0;
  listSpeakersHook = () =>
    ++requests === 1
      ? new Promise((resolve) => {
          finishStartup = resolve;
        })
      : Promise.resolve([alex, blair]);
  deleteSpeakerHook = async () => "deleted";
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove speaker Alex" }, { timeout: 6500 }),
  );
  await act(async () => {
    finishStartup?.([alex, blair]);
  });
  expect(await screen.findByRole("button", { name: "Remove speaker Blair" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove speaker Alex" })).not.toBeInTheDocument();
}, 15000);

it.each(["deleted", "notFound"] as const)(
  "reveals local profiles after the final server deletion is confirmed: %s",
  async (result) => {
    const alex = {
      id: "alex",
      label: "Server Alex",
      embeddings: [[1, 0]],
      sampleRate: 16000,
      sampleCount: 1,
    };
    const blair = { ...alex, id: "blair", label: "Local Blair" };
    localStorage.setItem("stutter-tracker:speakers", JSON.stringify([blair]));
    let server = [alex];
    let requests = 0;
    let finishDeletion: (() => void) | undefined;
    listSpeakersHook = async () => {
      requests += 1;
      return server;
    };
    deleteSpeakerHook = () =>
      new Promise((resolve) => {
        finishDeletion = () => {
          server = [];
          resolve(result);
        };
      });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Remove speaker Server Alex" }));
    await waitFor(() => expect(requests).toBe(2));
    expect(
      screen.queryByRole("button", { name: "Remove speaker Local Blair" }),
    ).not.toBeInTheDocument();
    await act(async () => finishDeletion?.());
    expect(
      await screen.findByRole("button", { name: "Remove speaker Local Blair" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove speaker Server Alex" }),
    ).not.toBeInTheDocument();
  },
);

it("preserves distinct native profile IDs with the same long prefix", async () => {
  const prefix = "a".repeat(130);
  const alex = {
    id: prefix + "alex",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 1,
  };
  const blair = { ...alex, id: prefix + "blair", label: "Blair" };
  let native = [alex, blair];
  const invoke = vi.spyOn(tauriCore, "invoke").mockImplementation(async (command) => {
    if (command === "load_speaker_profiles") return native;
    if (command === "save_speaker_profiles") {
      native = [blair];
      return native;
    }
    throw new Error("Native command unavailable in this profile fixture");
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  const remove = await screen.findByRole("button", { name: "Remove speaker Alex" });
  expect(screen.getByRole("button", { name: "Remove speaker Blair" })).toBeInTheDocument();
  fireEvent.click(remove);
  await waitFor(() => expect(native.map((profile) => profile.id)).toEqual([blair.id]));
  expect(invoke).toHaveBeenCalledWith("save_speaker_profiles", { speakers: [blair] });
  expect(screen.getByRole("button", { name: "Remove speaker Blair" })).toBeInTheDocument();
});

it("offers a retry after local deletion succeeds but server deletion fails", async () => {
  const alex = {
    id: "alex",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 1,
  };
  listSpeakersHook = async () => [alex];
  deleteSpeakerHook = async () => {
    throw new Error("Temporary network failure");
  };
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Remove speaker Alex" }));
  const retry = await screen.findByRole("button", {
    name: "Retry deleting speaker Alex from compute server",
  });
  deleteSpeakerHook = async () => "deleted";
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry deleting speaker Alex from compute server" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByRole("button", { name: "Remove speaker Alex" })).not.toBeInTheDocument();
});

it("keeps unrelated server profiles when post-removal refresh fails", async () => {
  const alex = {
    id: "alex",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 1,
  };
  const blair = { ...alex, id: "blair", label: "Blair" };
  let requests = 0;
  listSpeakersHook = async () => {
    if (++requests === 1) return [alex, blair];
    throw new Error("Temporary fetch failure");
  };
  deleteSpeakerHook = async () => "deleted";
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Remove speaker Alex" }));
  await waitFor(() => expect(requests).toBe(3));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: "Remove speaker Blair" })).toBeInTheDocument();
});

it("keeps a re-enrolled native ID visible after another removal refresh", async () => {
  const alex = {
    id: "alex",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 16000,
  };
  const blair = { ...alex, id: "blair", label: "Blair" };
  let native = [alex, blair];
  let saves = 0;
  let loads = 0;
  let finishRefresh: ((profiles: typeof native) => void) | undefined;
  const invoke = vi.spyOn(tauriCore, "invoke").mockImplementation(async (command) => {
    if (command === "load_speaker_profiles") {
      if (++loads === 2)
        return new Promise((resolve) => {
          finishRefresh = resolve;
        });
      return native;
    }
    if (command === "create_speaker_profile") return alex;
    if (command === "save_speaker_profiles") {
      native = ++saves === 1 ? [blair] : saves === 2 ? [blair, alex] : [alex];
      return native;
    }
    throw new Error("Native command unavailable in this profile fixture");
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
  let capture: recorderModule.BrowserRecorderOptions | undefined;
  vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
    capture = options;
    return { sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} };
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Remove speaker Alex" }));
  await waitFor(() => expect(saves).toBe(1));
  await waitFor(() => expect(finishRefresh).toBeDefined());
  await userEvent.click(screen.getByRole("button", { name: /record/i }));
  act(() => {
    capture!.onSamples(new Float32Array(16000));
  });
  await userEvent.type(screen.getByRole("textbox", { name: "Speaker label" }), "Alex");
  await userEvent.click(screen.getAllByRole("button", { name: "Enroll" }).at(-1)!);
  expect(await screen.findByText("Alex enrolled")).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("save_speaker_profiles", { speakers: [blair, alex] });
  await act(async () => {
    finishRefresh?.([blair]);
  });
  expect(screen.getByRole("button", { name: "Remove speaker Alex" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove speaker Blair" }));
  await waitFor(() => expect(saves).toBe(3));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: "Remove speaker Alex" })).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("save_speaker_profiles", { speakers: [alex] });
});

describe("capture-quality gate", () => {
  const measured = (overrides: Record<string, number> = {}) => ({
    sampleRate: 16000,
    channels: 1,
    samplesPerChannel: 96000,
    durationSeconds: 6,
    clippedSampleCount: 0,
    clippedSampleRatio: 0,
    frameSamples: 320,
    frameCount: 300,
    noInputSeconds: 0.5,
    longestNoInputSeconds: 0.3,
    activitySeconds: 4.5,
    config: { frameSeconds: 0.02, clipLevel: 0.999, noInputRms: 1e-4, activityRms: 0.01 },
    ...overrides,
  });

  async function recordWithNativeMetrics(metrics: ReturnType<typeof measured> | undefined) {
    const analyzed: unknown[] = [];
    const invoke = vi.spyOn(tauriCore, "invoke").mockImplementation(async (command, args) => {
      if (command === "analyze_speech_session") {
        const request = (args as { request: Parameters<typeof fallbackAnalyze>[0] }).request;
        analyzed.push(request);
        return { ...fallbackAnalyze(request), captureMetrics: metrics, analyzerVersion: "1" };
      }
      throw new Error(`Native command ${command} unavailable in this fixture`);
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
    let capture: recorderModule.BrowserRecorderOptions | undefined;
    vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
      capture = options;
      return { sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} };
    });
    return {
      analyzed,
      record: async (seconds = 6) => {
        await userEvent.click(screen.getByRole("button", { name: /^record$/i }));
        act(() => {
          capture!.onSamples(new Float32Array(16000 * seconds).fill(0.2));
        });
        await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));
      },
    };
  }

  it("withholds the score until the user declares they speak alone", async () => {
    const { analyzed, record } = await recordWithNativeMetrics(measured());
    renderApp();
    await record();

    const status = await screen.findByRole("status", { name: "Capture quality" });
    expect(status).toHaveTextContent("it is not confirmed that only you are speaking");
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(4);
    // The descriptor, with its device details, never travels with the analysis request.
    expect(analyzed.at(-1)).not.toHaveProperty("descriptor");
    expect(JSON.stringify(analyzed.at(-1))).not.toContain("preprocessing");

    // Every score on the dashboard is withheld, not only the header.
    expect(
      screen.getByText("Events are not shown because the capture quality is unknown."),
    ).toBeInTheDocument();
    const sidebar = screen.getByRole("complementary");
    expect(within(sidebar).getAllByText("Unknown").length).toBeGreaterThanOrEqual(7);

    await userEvent.click(screen.getByRole("checkbox", { name: "Only I speak" }));
    expect(localStorage.getItem("stutter-tracker:solo-speaker")).toBe("true");
    await record();
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Capture quality" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();

    // The saved session keeps how it was recorded.
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toHaveLength(1),
    );
    const [saved] = JSON.parse(localStorage.getItem(STORE_KEY)!);
    expect(saved.recordings).toEqual([
      expect.objectContaining({
        sessionId: saved.id,
        origin: "desktop",
        role: "appInput",
        sampleRate: 16000,
        speakerAssessment: "singleSpeakerDeclared",
      }),
    ]);
    expect(saved.report.captureQuality).toEqual({
      state: "usable",
      issues: [],
      coverage: { measuredSeconds: 6, captureSeconds: 6 },
    });
  });

  it("starts a session with other people only after this session's confirmation", async () => {
    const { record } = await recordWithNativeMetrics(measured());
    renderApp();
    const recordButton = () => screen.getByRole("button", { name: /^record$/i });
    const agreement = "Everyone else in this recording has agreed to be recorded.";

    await userEvent.click(screen.getByRole("checkbox", { name: "Recording other people" }));
    expect(recordButton()).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: agreement }));
    expect(recordButton()).toBeEnabled();
    await record();

    // The confirmation covered that session only; the next one needs it again.
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: agreement })).not.toBeChecked(),
    );
    expect(recordButton()).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toHaveLength(1),
    );
    const [saved] = JSON.parse(localStorage.getItem(STORE_KEY)!);
    expect(saved.recordings).toEqual([
      expect.objectContaining({
        speakerAssessment: "unknown",
        otherParticipants: {
          confirmedAt: expect.any(String),
          statement: agreement,
        },
      }),
    ]);
    expect(
      await screen.findByText(/Other people recorded; their agreement confirmed/),
    ).toBeInTheDocument();
  });

  it("says which part of a long capture the quality check covered", async () => {
    localStorage.setItem("stutter-tracker:solo-speaker", "true");
    const { analyzed, record } = await recordWithNativeMetrics(
      measured({ durationSeconds: 90, samplesPerChannel: 1_440_000, activitySeconds: 80 }),
    );
    renderApp();
    await record(120);
    // Analysis is sent the last 90 s; the verdict says so instead of passing for the whole capture.
    expect((analyzed.at(-1) as { samples?: number[] } | undefined)?.samples).toHaveLength(
      16000 * 90,
    );
    expect(await screen.findByRole("status", { name: "Capture quality" })).toHaveTextContent(
      "checked for the last 1 min 30 s of 2 min of recorded audio",
    );
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  it("explains silent captures and marks unmeasured paths", async () => {
    localStorage.setItem("stutter-tracker:solo-speaker", "true");
    const { record } = await recordWithNativeMetrics(
      measured({ noInputSeconds: 6, activitySeconds: 0, longestNoInputSeconds: 6 }),
    );
    renderApp();
    expect(screen.getByRole("checkbox", { name: "Only I speak" })).toBeChecked();
    await record();
    expect(await screen.findByRole("status", { name: "Capture quality" })).toHaveTextContent(
      "the microphone delivered no input",
    );
  });

  it("withholds the score of an undeclared speaker even when nothing was measured", async () => {
    const { record } = await recordWithNativeMetrics(undefined);
    renderApp();
    await record();
    expect(await screen.findByRole("status", { name: "Capture quality" })).toHaveTextContent(
      "it is not confirmed that only you are speaking",
    );
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(4);
  });

  it("says when the processing path did not measure the capture", async () => {
    localStorage.setItem("stutter-tracker:solo-speaker", "true");
    const { record } = await recordWithNativeMetrics(undefined);
    renderApp();
    await record();
    expect(await screen.findByRole("status", { name: "Capture quality" })).toHaveTextContent(
      "not checked",
    );
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });
});

describe("browser-local capture measurement", () => {
  // No desktop app and no compute server: the web app analyzes on this device (vox#89).
  async function recordInBrowser(
    samplesFor: (seconds: number) => Float32Array,
    analyzeOnServer?: AnalyzeRun,
  ) {
    analysisHook =
      analyzeOnServer ??
      (async () => {
        throw new Error("compute server unavailable in this fixture");
      });
    let capture: recorderModule.BrowserRecorderOptions | undefined;
    vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
      capture = options;
      return { sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} };
    });
    return async (seconds = 6) => {
      await userEvent.click(screen.getByRole("button", { name: /^record$/i }));
      act(() => {
        capture!.onSamples(samplesFor(seconds));
      });
      await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    };
  }

  const speech = (seconds: number) =>
    Float32Array.from(
      { length: 16000 * seconds },
      (_, index) => 0.2 * Math.sin((2 * Math.PI * 220 * index) / 16000),
    );
  const silence = (seconds: number) => new Float32Array(16000 * seconds);
  const clipping = (seconds: number) => new Float32Array(16000 * seconds).fill(1);

  async function savedCaptureQuality() {
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toHaveLength(1),
    );
    return JSON.parse(localStorage.getItem(STORE_KEY)!)[0].report.captureQuality;
  }

  it("measures the analyzed audio with the audio-analysis WASM kernel", async () => {
    localStorage.setItem("stutter-tracker:solo-speaker", "true");
    const record = await recordInBrowser(speech);
    renderApp();
    await record();

    await waitFor(() => expect(captureKernelCalls.length).toBeGreaterThan(0));
    const call = captureKernelCalls.at(-1)!;
    // The kernel sees exactly the mono audio window that was analyzed.
    expect(call.sampleRate).toBe(16000);
    expect(call.samples).toHaveLength(16000 * 6);
    expect(call.channels === undefined || call.channels === 1).toBe(true);

    expect(await savedCaptureQuality()).toEqual({
      state: "usable",
      issues: [],
      coverage: { measuredSeconds: 6, captureSeconds: 6 },
    });
    expect(screen.queryByText(/not checked/)).not.toBeInTheDocument();
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  it("withholds the score of a silent browser capture", async () => {
    localStorage.setItem("stutter-tracker:solo-speaker", "true");
    const record = await recordInBrowser(silence);
    renderApp();
    await record();
    expect(await screen.findByRole("status", { name: "Capture quality" })).toHaveTextContent(
      "the microphone delivered no input",
    );
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(4);
    // The verdict comes from the kernel measuring the analyzed window. A silent capture has no
    // segments, pauses or events, so the existing save gate ("Nothing to save") keeps it unsaved.
    expect(captureKernelCalls.length).toBeGreaterThan(0);
    const call = captureKernelCalls.at(-1)!;
    expect(call.sampleRate).toBe(16000);
    expect(call.samples).toHaveLength(16000 * 6);
    expect(screen.queryByText(/not checked/)).not.toBeInTheDocument();
  });

  it("withholds the score of a clipping browser capture", async () => {
    localStorage.setItem("stutter-tracker:solo-speaker", "true");
    const record = await recordInBrowser(clipping);
    renderApp();
    await record();
    expect(await screen.findByRole("status", { name: "Capture quality" })).toHaveTextContent(
      "the input is clipping (too loud)",
    );
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(4);
  });

  it("stays unmeasured, without failing the analysis, when the kernel cannot run", async () => {
    localStorage.setItem("stutter-tracker:solo-speaker", "true");
    captureKernelHook = async () => {
      throw new Error("WebAssembly unavailable in this fixture");
    };
    const record = await recordInBrowser(speech);
    renderApp();
    await record();
    expect(await screen.findByRole("status", { name: "Capture quality" })).toHaveTextContent(
      "not checked",
    );
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
    expect(await savedCaptureQuality()).toEqual({ state: "unmeasured", issues: [] });
  });

  it("keeps the compute server's measurement when the server analyzed the audio", async () => {
    localStorage.setItem("stutter-tracker:solo-speaker", "true");
    const serverSilence = {
      sampleRate: 16000,
      channels: 1,
      samplesPerChannel: 96000,
      durationSeconds: 6,
      clippedSampleCount: 0,
      clippedSampleRatio: 0,
      frameSamples: 320,
      frameCount: 300,
      noInputSeconds: 6,
      longestNoInputSeconds: 6,
      activitySeconds: 0,
      config: { frameSeconds: 0.02, clipLevel: 0.999, noInputRms: 1e-4, activityRms: 0.01 },
    };
    const record = await recordInBrowser(speech, async (request) => ({
      report: { ...fallbackAnalyze(request), captureMetrics: serverSilence },
      analyzer: { producer: "computeServer", algorithm: "test", version: "1" },
    }));
    renderApp();
    await record();
    // The audio itself is speech; only the server's own measurement can say "no input".
    expect(await screen.findByRole("status", { name: "Capture quality" })).toHaveTextContent(
      "the microphone delivered no input",
    );
  });

  describe("when the compute client resolves its own on-device fallback", () => {
    // The normal browser path: with no server configured, or after a failed server request, the
    // compute client does not throw; it resolves the shared fallback as the on-device analyzer.
    const resolveOnDevice: AnalyzeRun = async (request) => ({
      report: fallbackAnalyze(request),
      analyzer: ON_DEVICE_ANALYZER,
    });

    it("measures speech with the WASM kernel", async () => {
      localStorage.setItem("stutter-tracker:solo-speaker", "true");
      const record = await recordInBrowser(speech, resolveOnDevice);
      renderApp();
      await record();

      await waitFor(() => expect(captureKernelCalls.length).toBeGreaterThan(0));
      const call = captureKernelCalls.at(-1)!;
      expect(call.sampleRate).toBe(16000);
      expect(call.samples).toHaveLength(16000 * 6);
      expect(call.channels === undefined || call.channels === 1).toBe(true);

      expect(await savedCaptureQuality()).toEqual({
        state: "usable",
        issues: [],
        coverage: { measuredSeconds: 6, captureSeconds: 6 },
      });
      expect(screen.queryByText(/not checked/)).not.toBeInTheDocument();
      expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
    });

    it("withholds the score of a silent capture", async () => {
      localStorage.setItem("stutter-tracker:solo-speaker", "true");
      const record = await recordInBrowser(silence, resolveOnDevice);
      renderApp();
      await record();
      expect(await screen.findByRole("status", { name: "Capture quality" })).toHaveTextContent(
        "the microphone delivered no input",
      );
      expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(4);
      expect(captureKernelCalls.length).toBeGreaterThan(0);
      expect(captureKernelCalls.at(-1)!.samples).toHaveLength(16000 * 6);
      expect(screen.queryByText(/not checked/)).not.toBeInTheDocument();
    });
  });
});

describe("interrupted capture recovery", () => {
  const CHECKPOINT_PREFIX = "stutter-tracker:capture-checkpoint:";
  const CHECKPOINT_KEY = `${CHECKPOINT_PREFIX}capture-interrupted`;
  const storedCheckpointKeys = () =>
    Object.keys(localStorage).filter((key) => key.startsWith(CHECKPOINT_PREFIX));
  const checkpoint = {
    version: 1,
    id: "capture-interrupted",
    startedAt: "2026-10-09T10:00:00.000Z",
    updatedAt: "2026-10-09T10:02:00.000Z",
    language: "en-US",
    segments: [
      {
        text: "Recovered words",
        startSeconds: 0,
        endSeconds: 2,
        confidence: 0.9,
        isFinal: true,
      },
    ],
    pauses: [{ startSeconds: 2, endSeconds: 3, afterText: "words" }],
    analysis: null,
  };

  it("recovers an interrupted capture once and saves it under its checkpoint id", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    const { container, unmount } = renderApp();

    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    expect(within(notice).getByText(/1 transcript segment,/)).toBeInTheDocument();
    // Nothing is recovered or dropped before the user chooses.
    expect(screen.getByText("Transcript will appear here.")).toBeInTheDocument();
    expect(localStorage.getItem(CHECKPOINT_KEY)).not.toBeNull();

    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    expect(screen.queryByRole("region", { name: "Interrupted recording" })).not.toBeInTheDocument();
    expect((await screen.findAllByText("Recovered words")).length).toBeGreaterThan(0);
    expect(screen.getByText(/its audio was not kept/)).toBeInTheDocument();
    // Still unsaved, so it stays checkpointed until saved.
    expect(JSON.parse(localStorage.getItem(CHECKPOINT_KEY) ?? "null")).toMatchObject({
      id: checkpoint.id,
    });

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(container.querySelectorAll(".session-row")).toHaveLength(1));
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(checkpoint.id);
    expect(stored[0].startedAt).toBe(checkpoint.startedAt);
    expect(localStorage.getItem(CHECKPOINT_KEY)).toBeNull();

    // A restart after the save offers nothing again.
    unmount();
    renderApp();
    expect(screen.queryByRole("region", { name: "Interrupted recording" })).not.toBeInTheDocument();
  });

  it("checkpoints a live capture so a crash mid-recording can recover its transcript", async () => {
    vi.spyOn(recorderModule, "createBrowserRecorder").mockResolvedValue({
      sampleRate: 16000,
      capture: TEST_CAPTURE,
      stop: async () => {},
    });
    const recognitions: Array<{ onresult: ((event: unknown) => void) | null }> = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror = null;
      onend = null;
      constructor() {
        recognitions.push(this);
      }
      start() {}
      stop() {}
      abort() {}
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    const user = userEvent.setup();
    const { unmount } = renderApp();
    await user.click(screen.getByRole("button", { name: /^record$/i }));
    await waitFor(() => expect(recognitions).toHaveLength(1));
    expect(storedCheckpointKeys()).toEqual([]);

    act(() => {
      recognitions[0]!.onresult!({
        resultIndex: 0,
        results: [
          Object.assign([{ transcript: "spoken before the crash", confidence: 0.8 }], {
            isFinal: true,
          }),
        ],
      });
    });

    await waitFor(() => expect(storedCheckpointKeys()).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem(storedCheckpointKeys()[0]!)!)).toMatchObject({
      segments: [expect.objectContaining({ text: "spoken before the crash" })],
    });
    // The app stops without saving; the next start offers the capture.
    unmount();
    vi.unstubAllGlobals();
    renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    expect((await screen.findAllByText("spoken before the crash")).length).toBeGreaterThan(0);
  });

  it("drops a checkpoint whose capture was already saved before the app stopped", async () => {
    const { createSessionRecord } = await import("@stutter-tracker/shared");
    const saved = createSessionRecord({
      id: checkpoint.id,
      startedAt: checkpoint.startedAt,
      segments: checkpoint.segments,
      pauses: checkpoint.pauses,
      report: fallbackAnalyze({ segments: checkpoint.segments, pauses: checkpoint.pauses }),
      run: { id: "run", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    });
    localStorage.setItem(STORE_KEY, JSON.stringify([saved]));
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));

    const { container } = renderApp();

    await waitFor(() => expect(localStorage.getItem(CHECKPOINT_KEY)).toBeNull());
    expect(container.querySelectorAll(".session-row")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Interrupted recording" })).not.toBeInTheDocument();
  });

  it("discards an interrupted capture only after confirmation", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });

    vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(within(notice).getByRole("button", { name: "Discard recording" }));
    expect(screen.getByRole("region", { name: "Interrupted recording" })).toBeInTheDocument();
    expect(localStorage.getItem(CHECKPOINT_KEY)).not.toBeNull();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(within(notice).getByRole("button", { name: "Discard recording" }));
    expect(screen.queryByRole("region", { name: "Interrupted recording" })).not.toBeInTheDocument();
    expect(localStorage.getItem(CHECKPOINT_KEY)).toBeNull();
    expect(screen.getByText("Interrupted recording discarded")).toBeInTheDocument();
  });

  it("keeps the interrupted capture offered when storage refuses the discard", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    await user.click(within(notice).getByRole("button", { name: "Discard recording" }));

    expect(
      await screen.findByText(/Could not discard the interrupted recording/),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Interrupted recording" })).toBeInTheDocument();
  });

  it("offers an unreadable checkpoint for discard without recovering or deleting it", async () => {
    localStorage.setItem(`${CHECKPOINT_PREFIX}from-a-newer-version`, "{truncated");
    renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    expect(within(notice).getByText(/format this version cannot read/)).toBeInTheDocument();
    expect(
      within(notice).queryByRole("button", { name: "Recover recording" }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(`${CHECKPOINT_PREFIX}from-a-newer-version`)).toBe("{truncated");
  });

  it("starts a new capture without touching an interrupted one", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const createRecorder = vi
      .spyOn(recorderModule, "createBrowserRecorder")
      .mockResolvedValue({ sampleRate: 16000, capture: TEST_CAPTURE, stop: async () => {} });
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("region", { name: "Interrupted recording" });

    await user.click(screen.getByRole("button", { name: /^record$/i }));

    await waitFor(() => expect(createRecorder).toHaveBeenCalled());
    expect(screen.getByRole("region", { name: "Interrupted recording" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(CHECKPOINT_KEY) ?? "null")).toEqual(checkpoint);
  });

  it("does not offer a capture that another open window owns", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) =>
          callback(null),
        query: async () => ({ held: [{ name: "stutter-tracker:capture:capture-interrupted" }] }),
      },
    });
    renderApp();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole("region", { name: "Interrupted recording" })).not.toBeInTheDocument();
    expect(localStorage.getItem(CHECKPOINT_KEY)).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("saves a recovered capture with the audio analysis it had", async () => {
    const report = {
      totalDurationSeconds: 3,
      wordCount: 0,
      stutterCount: 1,
      stuttersPerMinute: 20,
      severity: "mild",
      events: [
        {
          kind: "block",
          startSeconds: 0.5,
          endSeconds: 1.4,
          text: "",
          detail: "Acoustic-only block",
          confidence: 0.7,
        },
      ],
      byKind: { block: 1 },
    };
    const run = {
      id: "run-audio",
      createdAt: "2026-10-09T10:01:00.000Z",
      analyzer: null,
      usedAudio: true,
      audioId: "audio-gone",
      inputId: "input",
    };
    localStorage.setItem(
      CHECKPOINT_KEY,
      JSON.stringify({ ...checkpoint, segments: [], pauses: [], analysis: { report, run } }),
    );
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    expect(within(notice).getByText(/saves it with the analysis it had/)).toBeInTheDocument();

    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));

    await waitFor(() => expect(container.querySelectorAll(".session-row")).toHaveLength(1));
    const [stored] = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    expect(stored.id).toBe(checkpoint.id);
    expect(stored.report.events).toEqual(report.events);
    expect(stored.analysis).toMatchObject({ id: "run-audio", audioId: "audio-gone" });
    expect(localStorage.getItem(CHECKPOINT_KEY)).toBeNull();
    expect(await screen.findByText("Acoustic-only block")).toBeInTheDocument();
  });

  it("refuses to replace an unsaved capture whose checkpoint failed", async () => {
    const { createSessionRecord } = await import("@stutter-tracker/shared");
    const other = createSessionRecord({
      id: "session-other",
      startedAt: "2026-10-08T10:00:00.000Z",
      segments: [
        { text: "Other session", startSeconds: 0, endSeconds: 1, confidence: 0.9, isFinal: true },
      ],
      pauses: [],
      report: fallbackAnalyze({ segments: [], pauses: [] }),
      run: { id: "run", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    });
    localStorage.setItem(STORE_KEY, JSON.stringify([other]));
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith(CHECKPOINT_PREFIX)) {
        throw new DOMException("full", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    });
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    // The recovered transcript is in the workspace, but its latest state could not be stored.
    await screen.findByRole("alert");
    // Make the workspace differ from the stored checkpoint.
    localStorage.removeItem(CHECKPOINT_KEY);

    await user.click(container.querySelector<HTMLButtonElement>(".session-row")!);

    expect(await screen.findByText(/Save the current recording first/)).toBeInTheDocument();
    expect(screen.getAllByText("Recovered words").length).toBeGreaterThan(0);
    expect(screen.queryByText("Other session", { selector: "p, span" })).toBeNull();
  });

  it("recovers the checkpoint as stored now, not as first offered", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    // Another window recovered it, added to it and closed again.
    localStorage.setItem(
      CHECKPOINT_KEY,
      JSON.stringify({
        ...checkpoint,
        segments: [{ ...checkpoint.segments[0], text: "Newer words from another window" }],
      }),
    );

    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));

    expect((await screen.findAllByText("Newer words from another window")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("Recovered words")).not.toBeInTheDocument();
  });

  it("does not recover a checkpoint another window already removed", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    localStorage.removeItem(CHECKPOINT_KEY);

    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));

    expect(await screen.findByText(/changed in another window/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Interrupted recording" })).not.toBeInTheDocument();
    expect(screen.queryByText("Recovered words")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".session-row")).toHaveLength(0);
  });

  it("offers a capture left by a window that closed after this one started", async () => {
    renderApp();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("region", { name: "Interrupted recording" })).not.toBeInTheDocument();

    // Another window checkpointed a recording, then closed without saving it.
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: CHECKPOINT_KEY,
          newValue: JSON.stringify(checkpoint),
        }),
      );
    });

    expect(
      await screen.findByRole("region", { name: "Interrupted recording" }),
    ).toBeInTheDocument();
  });

  it("warns when this window cannot reserve its recording", async () => {
    vi.spyOn(recorderModule, "createBrowserRecorder").mockResolvedValue({
      sampleRate: 16000,
      capture: TEST_CAPTURE,
      stop: async () => {},
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: async () => {
          throw new DOMException("inactive", "InvalidStateError");
        },
        query: async () => ({ held: [] }),
      },
    });
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /^record$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be reserved/);
    vi.unstubAllGlobals();
  });

  it("saves a recovered capture that holds only pauses", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ ...checkpoint, segments: [] }));
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(container.querySelectorAll(".session-row")).toHaveLength(1));
    const [stored] = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    expect(stored.pauses).toEqual(checkpoint.pauses);
  });

  it("does not recover into the workspace while a recording is starting", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    vi.spyOn(recorderModule, "createBrowserRecorder").mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(screen.getByRole("button", { name: /^record$/i }));

    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));

    expect(screen.getByRole("region", { name: "Interrupted recording" })).toBeInTheDocument();
    expect(screen.queryByText("Recovered words")).not.toBeInTheDocument();
  });

  it("checks the saved sessions again before recovering", async () => {
    const { createSessionRecord } = await import("@stutter-tracker/shared");
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    // Another window saved this capture (and another session) but crashed before clearing it.
    const sessions = [checkpoint.id, "session-from-other-window"].map((id) =>
      createSessionRecord({
        id,
        startedAt: checkpoint.startedAt,
        segments: checkpoint.segments,
        pauses: checkpoint.pauses,
        report: fallbackAnalyze({ segments: checkpoint.segments, pauses: checkpoint.pauses }),
        run: { id: `run-${id}`, createdAt: null, analyzer: null, usedAudio: null, audioId: null },
      }),
    );
    localStorage.setItem(STORE_KEY, JSON.stringify(sessions));

    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));

    expect(await screen.findByText("This recording was already saved")).toBeInTheDocument();
    expect(container.querySelectorAll(".session-row")).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toHaveLength(2);
    expect(localStorage.getItem(CHECKPOINT_KEY)).toBeNull();
  });

  it("keeps sessions another window saved while a recovered capture waits", async () => {
    const { createSessionRecord } = await import("@stutter-tracker/shared");
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    const other = createSessionRecord({
      id: "session-from-other-window",
      startedAt: "2026-10-09T11:00:00.000Z",
      segments: checkpoint.segments,
      pauses: [],
      report: fallbackAnalyze({ segments: checkpoint.segments, pauses: [] }),
      run: { id: "run-other", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    });
    const value = JSON.stringify([other]);
    localStorage.setItem(STORE_KEY, value);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORE_KEY, newValue: value }));
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(container.querySelectorAll(".session-row")).toHaveLength(2));
    const ids = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]").map(
      (session: { id: string }) => session.id,
    );
    expect(ids).toEqual([checkpoint.id, "session-from-other-window"]);
  });

  it("drops the notice when another window saved the capture without clearing it", async () => {
    const { createSessionRecord } = await import("@stutter-tracker/shared");
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    renderApp();
    await screen.findByRole("region", { name: "Interrupted recording" });
    const saved = createSessionRecord({
      id: checkpoint.id,
      startedAt: checkpoint.startedAt,
      segments: checkpoint.segments,
      pauses: checkpoint.pauses,
      report: fallbackAnalyze({ segments: checkpoint.segments, pauses: checkpoint.pauses }),
      run: { id: "run-saved", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    });
    const value = JSON.stringify([saved]);
    localStorage.setItem(STORE_KEY, value);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORE_KEY, newValue: value }));
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Interrupted recording" }),
      ).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem(CHECKPOINT_KEY)).toBeNull();
  });

  it("keeps the workspace capture while its analysis is still running", async () => {
    const { createSessionRecord } = await import("@stutter-tracker/shared");
    const other = createSessionRecord({
      id: "session-other",
      startedAt: "2026-10-08T10:00:00.000Z",
      segments: [
        { text: "Other session", startSeconds: 0, endSeconds: 1, confidence: 0.9, isFinal: true },
      ],
      pauses: [],
      report: fallbackAnalyze({ segments: [], pauses: [] }),
      run: { id: "run", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    });
    localStorage.setItem(STORE_KEY, JSON.stringify([other]));
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    let analysisStarted = false;
    analysisHook = () => {
      analysisStarted = true;
      return new Promise(() => {});
    };
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    await waitFor(() => expect(analysisStarted).toBe(true));

    await user.click(container.querySelector<HTMLButtonElement>(".session-row")!);

    expect(
      await screen.findByText("Wait for the analysis of the current recording to finish first"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Recovered words").length).toBeGreaterThan(0);
  });

  it("stops deleting a session while its leftover checkpoint cannot be removed", async () => {
    const { createSessionRecord } = await import("@stutter-tracker/shared");
    const saved = createSessionRecord({
      id: checkpoint.id,
      startedAt: checkpoint.startedAt,
      segments: checkpoint.segments,
      pauses: checkpoint.pauses,
      report: fallbackAnalyze({ segments: checkpoint.segments, pauses: checkpoint.pauses }),
      run: { id: "run", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    });
    localStorage.setItem(STORE_KEY, JSON.stringify([saved]));
    const user = userEvent.setup();
    const { container } = renderApp();
    await act(async () => {
      await Promise.resolve();
    });
    // A leftover appears after startup (written by a window that crashed after saving).
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await user.click(screen.getByRole("button", { name: /Delete saved session from/ }));

    expect(await screen.findByText(/Delete failed/)).toBeInTheDocument();
    expect(container.querySelectorAll(".session-row")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toHaveLength(1);
  });

  it("keeps a full-storage checkpoint failure visible until the capture is saved", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    const setItem = Storage.prototype.setItem;
    const checkpointWrites = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === CHECKPOINT_KEY) {
        throw new DOMException("full", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    });

    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not being kept safe/);
    expect(checkpointWrites).toHaveBeenCalledWith(CHECKPOINT_KEY, expect.any(String));
    // The earlier checkpoint is untouched, so an interruption now still recovers it.
    expect(JSON.parse(localStorage.getItem(CHECKPOINT_KEY) ?? "null")).toEqual(checkpoint);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(container.querySelectorAll(".session-row")).toHaveLength(1));
    expect(screen.queryByText(/not being kept safe/)).not.toBeInTheDocument();
    expect(localStorage.getItem(CHECKPOINT_KEY)).toBeNull();
  });

  it("keeps the capture checkpointed when saving it fails", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === STORE_KEY) {
        throw new DOMException("full", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Could not save the session/)).toBeInTheDocument();
    expect(container.querySelectorAll(".session-row")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(CHECKPOINT_KEY) ?? "null")).toMatchObject({
      id: checkpoint.id,
    });
  });

  it("sets an unsaved capture aside when a saved session is opened", async () => {
    const { createSessionRecord } = await import("@stutter-tracker/shared");
    const other = createSessionRecord({
      id: "session-other",
      startedAt: "2026-10-08T10:00:00.000Z",
      segments: [
        { text: "Other session", startSeconds: 0, endSeconds: 1, confidence: 0.9, isFinal: true },
      ],
      pauses: [],
      report: fallbackAnalyze({ segments: [], pauses: [] }),
      run: { id: "run", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    });
    localStorage.setItem(STORE_KEY, JSON.stringify([other]));
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));

    await user.click(container.querySelector<HTMLButtonElement>(".session-row")!);

    expect(
      await screen.findByRole("region", { name: "Interrupted recording" }),
    ).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(CHECKPOINT_KEY) ?? "null")).toMatchObject({
      id: checkpoint.id,
    });
  });

  it("does not bring back a deleted session from a checkpoint left behind", async () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    const user = userEvent.setup();
    const { container } = renderApp();
    const notice = await screen.findByRole("region", { name: "Interrupted recording" });
    await user.click(within(notice).getByRole("button", { name: "Recover recording" }));
    // The save succeeds but the checkpoint removal does not (the app "crashes" in between).
    vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(container.querySelectorAll(".session-row")).toHaveLength(1));
    expect(localStorage.getItem(CHECKPOINT_KEY)).not.toBeNull();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /Delete saved session from/ }));
    await waitFor(() => expect(container.querySelectorAll(".session-row")).toHaveLength(0));

    expect(localStorage.getItem(CHECKPOINT_KEY)).toBeNull();
    expect(screen.queryByRole("region", { name: "Interrupted recording" })).not.toBeInTheDocument();
  });
});
