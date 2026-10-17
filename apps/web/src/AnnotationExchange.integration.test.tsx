import "fake-indexeddb/auto";
import { audioFingerprint, migrateSessionRecord } from "@stutter-tracker/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  getSessionAudio,
  putSessionAudio,
  resetSessionAudioConnection,
} from "./storage/sessionAudio";
import type { SavedSession } from "./types";

const STORE_KEY = "stutter-tracker:sessions";

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

const ORIGIN: SavedSession = {
  ...migrateSessionRecord({
    id: "session-x",
    startedAt: "2026-05-19T10:00:00.000Z",
    segments: [
      {
        text: "I I want",
        startSeconds: 0,
        endSeconds: 1,
        confidence: 0.9,
        speakerLabel: "Robin",
        isFinal: true,
      },
    ],
    pauses: [],
    report: {
      totalDurationSeconds: 1,
      wordCount: 3,
      stutterCount: 1,
      stuttersPerMinute: 60,
      severity: "high",
      speechStats: {
        speakingDurationSeconds: 1,
        pauseDurationSeconds: 0,
        wordsPerMinute: 180,
        articulationRateWpm: 180,
        meanChunkWords: 3,
        meanChunkDurationSeconds: 1,
        eventDensityPer100Words: 33,
        fluencyPercentage: 67,
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
      events: [
        {
          kind: "wordRepetition",
          startSeconds: 0,
          endSeconds: 0.4,
          text: "I I",
          detail: "Secret model note",
          confidence: 0.9,
        },
      ],
      byKind: { wordRepetition: 1 },
    },
  }),
  context: { spokenLanguage: "en", task: null, condition: { kind: "assisted", aidId: "daf" } },
};
const SAMPLES = Float32Array.from({ length: 1600 }, (_, index) => Math.sin(index / 10) / 2);

const stored = () => JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedSession[];
let downloads: Blob[] = [];

function freshDevice() {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  resetSessionAudioConnection();
}

async function openSession(container: HTMLElement) {
  const row = await waitFor(() => {
    const found = container.querySelector<HTMLButtonElement>(".session-row");
    expect(found).not.toBeNull();
    return found!;
  });
  await userEvent.click(row);
}

async function downloadFile(includeAudio: boolean) {
  const panel = screen.getByRole("region", { name: "Exchange annotations" });
  const download = within(panel).getByRole("button", { name: /Download annotation file/ });
  expect(download).toBeDisabled();
  await userEvent.click(
    within(panel).getByLabelText("I consent to sharing selected evidence with a clinician"),
  );
  if (includeAudio) {
    await userEvent.click(await within(panel).findByLabelText("Include this session's kept audio"));
    expect(within(panel).getByText(/Audio: 0\.1 s at 16000 Hz/)).toBeInTheDocument();
  }
  await userEvent.click(download);
  const blob = downloads.at(-1)!;
  return new File([await blob.text()], "vox-annotation-exchange.json", {
    type: "application/json",
  });
}

async function importFile(file: File) {
  const panel = screen.getByRole("region", { name: "Exchange annotations" });
  await userEvent.upload(within(panel).getByLabelText("Import annotation file"), file);
}

beforeEach(() => {
  freshDevice();
  downloads = [];
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => (downloads.push(blob), "blob:test"),
      revokeObjectURL: () => {},
    }),
  );
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("annotation exchange (vox#23)", () => {
  it("sends a session with selected audio to a rater and merges the rater's revision back", async () => {
    // Origin device.
    localStorage.setItem(STORE_KEY, JSON.stringify([ORIGIN]));
    await putSessionAudio({
      sessionId: ORIGIN.id,
      sampleRate: 16000,
      samples: SAMPLES,
      startOffsetSeconds: 0,
      discontinuities: [],
      droppedSeconds: 0,
      audioId: audioFingerprint(SAMPLES, 16000),
      keptAt: "2026-05-19T10:05:00.000Z",
    });
    const origin = renderApp();
    await openSession(origin.container);
    const sent = await downloadFile(true);
    const sentText = await sent.text();
    for (const hidden of ["Secret model note", "daf", "assisted", "2026-05-19", "stutterCount"]) {
      expect(sentText).not.toContain(hidden);
    }
    const originStore = localStorage.getItem(STORE_KEY)!;
    origin.unmount();

    // Rater device: no copy of the session yet.
    freshDevice();
    const rater = renderApp();
    await importFile(sent);
    await screen.findByText(
      /Added a review copy with 0 new annotation revisions; its audio is kept/,
    );
    const [copy] = stored();
    expect(copy).toMatchObject({
      id: ORIGIN.id,
      segments: ORIGIN.segments,
      report: { events: [] },
    });
    expect(copy.reviewCopy).toBeDefined();
    expect(Array.from((await getSessionAudio(ORIGIN.id))!.samples)).toEqual(Array.from(SAMPLES));

    await openSession(rater.container);
    const workbench = await screen.findByRole("region", { name: "Annotate events" });
    await userEvent.selectOptions(within(workbench).getByLabelText("Annotating as"), "clinician");
    await userEvent.type(within(workbench).getByLabelText("Rater name (optional)"), "SLT");
    await userEvent.click(within(workbench).getByRole("button", { name: /0\.00s–1\.00s/ }));
    await userEvent.click(within(workbench).getByRole("button", { name: "Add event" }));
    await userEvent.click(within(workbench).getByRole("button", { name: "Save as reference" }));
    await screen.findByText("Annotation saved to the session");
    const reply = await downloadFile(false);
    expect(await reply.text()).not.toContain('"samples"');
    rater.unmount();

    // Back on the origin device.
    freshDevice();
    localStorage.setItem(STORE_KEY, originStore);
    renderApp();
    await importFile(reply);
    await screen.findByText("Imported 1 new annotation revision");
    const [merged] = stored();
    expect(merged.reviewCopy).toBeUndefined();
    expect(merged.report.events).toHaveLength(1);
    expect(merged.annotations).toEqual([
      expect.objectContaining({
        author: { role: "clinician", id: "SLT" },
        basedOnRunId: null,
        status: "accepted",
      }),
    ]);

    await importFile(reply);
    await screen.findByText("Imported 0 new annotation revisions (1 already here)");
    expect(stored()[0].annotations).toHaveLength(1);
  });

  it("rejects a file for a different transcript of the same session and changes nothing", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([ORIGIN]));
    const origin = renderApp();
    await openSession(origin.container);
    const sent = await downloadFile(false);
    origin.unmount();

    const edited = { ...ORIGIN, segments: [{ ...ORIGIN.segments[0], text: "I want" }] };
    freshDevice();
    localStorage.setItem(STORE_KEY, JSON.stringify([edited]));
    const before = localStorage.getItem(STORE_KEY);
    renderApp();
    await importFile(sent);
    await screen.findByText(/Import failed: The file describes a different version/);
    expect(localStorage.getItem(STORE_KEY)).toBe(before);
  });
});
