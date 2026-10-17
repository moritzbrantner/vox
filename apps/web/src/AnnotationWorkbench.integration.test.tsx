import { migrateSessionRecord } from "@stutter-tracker/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
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

const SESSION: SavedSession = migrateSessionRecord({
  id: "session-a",
  startedAt: "2026-05-19T10:00:00.000Z",
  segments: [
    { text: "I I want", startSeconds: 0.25, endSeconds: 1.5, confidence: 0.9, isFinal: true },
    { text: "a coffee", startSeconds: 2, endSeconds: 3, confidence: 0.9, isFinal: true },
  ],
  pauses: [],
  report: {
    totalDurationSeconds: 3,
    wordCount: 5,
    stutterCount: 0,
    stuttersPerMinute: 0,
    severity: "none",
    speechStats: {
      speakingDurationSeconds: 3,
      pauseDurationSeconds: 0,
      wordsPerMinute: 100,
      articulationRateWpm: 100,
      meanChunkWords: 5,
      meanChunkDurationSeconds: 3,
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

function stored(): SavedSession[] {
  return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedSession[];
}

async function openSession(container: HTMLElement) {
  const row = await waitFor(() => {
    const found = container.querySelector<HTMLButtonElement>(".session-row");
    expect(found).not.toBeNull();
    return found!;
  });
  await userEvent.click(row);
  return screen.findByRole("region", { name: "Annotate events" });
}

async function addEventFromSegment(workbench: HTMLElement, segment: RegExp) {
  await userEvent.click(within(workbench).getByRole("button", { name: segment }));
  await userEvent.click(within(workbench).getByRole("button", { name: "Add event" }));
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("annotation workbench (vox#23)", () => {
  it("creates, nudges, undoes and saves exact spans, and reloads them after a restart", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([SESSION]));
    const { container, unmount } = renderApp();
    const workbench = await openSession(container);

    await addEventFromSegment(workbench, /0\.25s–1\.50s/);
    const end = within(workbench).getByLabelText("Event 1 end");
    expect(end).toHaveValue("1.5");
    await userEvent.click(end);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{Shift>}{ArrowUp}{/Shift}");
    expect(end).toHaveValue("1.62");
    await userEvent.click(within(workbench).getByRole("button", { name: "Undo" }));
    expect(within(workbench).getByLabelText("Event 1 end")).toHaveValue("1.52");
    await userEvent.click(within(workbench).getByRole("button", { name: "Redo" }));

    const start = within(workbench).getByLabelText("Event 1 start");
    await userEvent.clear(start);
    await userEvent.type(start, "0.3{Enter}");
    await userEvent.selectOptions(
      within(workbench).getByLabelText("Event 1 kind"),
      "wordRepetition",
    );
    // An overlapping second span is allowed.
    await addEventFromSegment(workbench, /0\.25s–1\.50s/);
    await userEvent.selectOptions(
      within(workbench).getByLabelText("Event 1 certainty"),
      "possible",
    );

    await userEvent.click(within(workbench).getByRole("button", { name: "Save draft" }));
    await screen.findByText("Annotation saved to the session");

    const [saved] = stored();
    expect(saved.segments).toEqual(SESSION.segments);
    expect(saved.annotations).toHaveLength(1);
    expect(saved.annotations[0]).toMatchObject({
      author: { role: "self" },
      status: "draft",
      supersedes: null,
      basedOnRunId: SESSION.analysis.id,
      events: [
        { kind: "block", startSeconds: 0.25, endSeconds: 1.5, certainty: "possible" },
        { kind: "wordRepetition", startSeconds: 0.3, endSeconds: 1.62, certainty: "certain" },
      ],
    });

    unmount();
    const again = renderApp();
    const reopened = await openSession(again.container);
    expect(within(reopened).getByLabelText("Event 2 end")).toHaveValue("1.62");
    expect(within(reopened).getByText(/Your current revision: draft\./)).toBeInTheDocument();
  });

  it("rejects an end before the start without changing the span", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([SESSION]));
    const { container } = renderApp();
    const workbench = await openSession(container);
    await addEventFromSegment(workbench, /2\.00s–3\.00s/);

    const end = within(workbench).getByLabelText("Event 1 end");
    await userEvent.clear(end);
    await userEvent.type(end, "1{Enter}");
    expect(within(workbench).getByRole("alert")).toHaveTextContent("End must not be before start.");
    expect(within(workbench).getByLabelText("Event 1 end")).toHaveValue("3");
  });

  it("keeps another rater's draft when a second rater saves and supersedes only their own", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([SESSION]));
    const { container } = renderApp();
    const workbench = await openSession(container);
    await addEventFromSegment(workbench, /0\.25s–1\.50s/);
    await userEvent.click(within(workbench).getByRole("button", { name: "Save draft" }));
    await screen.findByText("Annotation saved to the session");

    await userEvent.selectOptions(within(workbench).getByLabelText("Annotating as"), "clinician");
    await userEvent.type(within(workbench).getByLabelText("Rater name (optional)"), "SLT 1");
    expect(within(workbench).getByText("No events annotated.")).toBeInTheDocument();
    await addEventFromSegment(workbench, /2\.00s–3\.00s/);
    await userEvent.click(within(workbench).getByRole("button", { name: "Save as reference" }));
    await waitFor(() => expect(stored()[0].annotations).toHaveLength(2));

    await userEvent.click(within(workbench).getByRole("button", { name: "Delete event 1" }));
    await userEvent.click(within(workbench).getByRole("button", { name: "Save as reference" }));
    await waitFor(() => expect(stored()[0].annotations).toHaveLength(3));

    const [self, clinician, replacement] = stored()[0].annotations;
    expect(self.author).toEqual({ role: "self" });
    expect(self.events).toHaveLength(1);
    expect(clinician).toMatchObject({
      author: { role: "clinician", id: "SLT 1" },
      status: "accepted",
    });
    expect(replacement).toMatchObject({ supersedes: clinician.id, events: [] });
  });

  it("keeps the unsaved spans on screen and the stored session unchanged when the save fails", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([SESSION]));
    const { container } = renderApp();
    const workbench = await openSession(container);
    await addEventFromSegment(workbench, /0\.25s–1\.50s/);

    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === STORE_KEY) throw new DOMException("full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    await userEvent.click(within(workbench).getByRole("button", { name: "Save draft" }));
    await screen.findByText(
      "Could not save the annotation: browser storage is full or unavailable",
    );
    vi.mocked(Storage.prototype.setItem).mockRestore();

    expect(stored()[0].annotations).toEqual([]);
    expect(within(workbench).getByLabelText("Event 1 end")).toHaveValue("1.5");
    expect(within(workbench).getByText("Unsaved changes.")).toBeInTheDocument();
  });
});
