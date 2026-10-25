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
  id: "session-v",
  startedAt: "2026-05-19T10:00:00.000Z",
  segments: [
    { text: "I I want", startSeconds: 0, endSeconds: 1, confidence: 0.9, isFinal: true },
    { text: "a coffee", startSeconds: 2, endSeconds: 3, confidence: 0.9, isFinal: true },
  ],
  pauses: [],
  report: {
    totalDurationSeconds: 4,
    wordCount: 5,
    stutterCount: 0,
    stuttersPerMinute: 0,
    severity: "none",
    speechStats: {
      speakingDurationSeconds: 2,
      pauseDurationSeconds: 0,
      wordsPerMinute: 75,
      articulationRateWpm: 75,
      meanChunkWords: 2,
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

const stored = () => JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")[0] as SavedSession;

async function openSession(container: HTMLElement) {
  const row = await waitFor(() => {
    const found = container.querySelector<HTMLButtonElement>(".session-row");
    expect(found).not.toBeNull();
    return found!;
  });
  await userEvent.click(row);
}

async function rateBlind(name: string, role: string, segments: RegExp[]) {
  await userEvent.click(screen.getByRole("button", { name: "Start blind review" }));
  await userEvent.click(screen.getByRole("button", { name: "Recording 1" }));
  const workbench = await screen.findByRole("region", { name: "Annotate events" });
  await userEvent.selectOptions(within(workbench).getByLabelText("Annotating as"), role);
  await userEvent.type(within(workbench).getByLabelText("Rater name (optional)"), name);
  for (const segment of segments) {
    await userEvent.click(within(workbench).getByRole("button", { name: segment }));
    await userEvent.click(within(workbench).getByRole("button", { name: "Add event" }));
  }
  await userEvent.click(within(workbench).getByRole("button", { name: "Save as reference" }));
  await screen.findByText("Annotation saved to the session");
  await userEvent.click(screen.getByRole("button", { name: "End blind review" }));
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("two-rater validation (vox#23)", () => {
  it("declares raters first, reports agreement and disagreements, and adjudicates without changing ratings", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([SESSION]));
    const { container } = renderApp();
    await openSession(container);

    const panel = screen.getByRole("region", { name: "Two-rater validation" });
    expect(within(panel).getByText(/No sessions are declared/)).toBeInTheDocument();
    await userEvent.type(within(panel).getByLabelText("Rater 1 name"), "A");
    await userEvent.selectOptions(within(panel).getByLabelText("Rater 2 role"), "researcher");
    await userEvent.type(within(panel).getByLabelText("Rater 2 name"), "B");
    await userEvent.click(within(panel).getByRole("button", { name: "Declare for validation" }));
    await screen.findByText("Validation declaration saved to the session");
    expect(stored().validation?.raters).toEqual([
      { role: "clinician", id: "A" },
      { role: "researcher", id: "B" },
    ]);

    await rateBlind("A", "clinician", [/0\.00s–1\.00s/, /2\.00s–3\.00s/]);
    await rateBlind("B", "researcher", [/0\.00s–1\.00s/]);

    await openSession(container);
    const declared = screen.getByRole("region", { name: "Two-rater validation" });
    expect(within(declared).getAllByText(/reference saved in blind review/)).toHaveLength(2);
    expect(within(declared).getByText(/Event agreement 67% \(2 vs 1 events\)/)).toBeInTheDocument();
    expect(within(declared).getByText("Only rater 1: Block 2.00–3.00 s")).toBeInTheDocument();

    expect(
      within(declared).getByText(/1 spans accepted automatically · 1 referred/),
    ).toBeInTheDocument();

    await userEvent.click(within(declared).getByRole("button", { name: "Adjudicate" }));
    const adjudication = await screen.findByRole("region", { name: "Adjudicate validation" });
    expect(
      within(within(adjudication).getByRole("list", { name: "Accepted automatically" })).getByText(
        "Block 0.00–1.00 s",
      ),
    ).toBeInTheDocument();
    const save = within(adjudication).getByRole("button", { name: "Save adjudication" });
    expect(save).toBeDisabled();
    // A rater cannot adjudicate their own validation.
    await userEvent.type(within(adjudication).getByLabelText("Adjudicator name"), "A");
    expect(within(adjudication).getByText("The adjudicator must be neither rater.")).toBeVisible();
    await userEvent.clear(within(adjudication).getByLabelText("Adjudicator name"));
    await userEvent.type(within(adjudication).getByLabelText("Adjudicator name"), "C");
    await userEvent.type(
      within(adjudication).getByLabelText("Qualification"),
      "SLT, stuttering specialist",
    );
    expect(within(adjudication).getByText("Decide every referred item.")).toBeVisible();
    const item = within(adjudication).getByRole("group", { name: /Item 1: Only rater 1/ });
    expect(within(item).queryByRole("radio", { name: "Rater 2's span" })).toBeNull();
    await userEvent.click(within(item).getByRole("radio", { name: "Adjusted span" }));
    await userEvent.clear(within(item).getByLabelText("Item 1 end"));
    await userEvent.type(within(item).getByLabelText("Item 1 end"), "2.5");
    await userEvent.selectOptions(within(item).getByLabelText("Item 1 certainty"), "possible");
    await userEvent.click(save);
    await screen.findByText("Adjudication saved to the session");

    const { annotations } = stored();
    expect(annotations).toHaveLength(3);
    expect(annotations[0].events).toHaveLength(2);
    expect(annotations[1].events).toHaveLength(1);
    expect(annotations[2]).toMatchObject({
      author: { role: "clinician", id: "C" },
      adjudicates: [annotations[0].id, annotations[1].id],
      adjudication: {
        qualification: "SLT, stuttering specialist",
        decisions: [{ item: "1/-", outcome: "adjusted" }],
      },
      events: [
        { kind: "block", startSeconds: 0, endSeconds: 1, certainty: "certain" },
        { kind: "block", startSeconds: 2, endSeconds: 2.5, certainty: "possible" },
      ],
    });
    expect(
      within(screen.getByRole("region", { name: "Two-rater validation" })).getByText(
        /Adjudicated by C \(Clinician\) \(SLT, stuttering specialist\); it is the session's human reference/,
      ),
    ).toBeInTheDocument();
  });
});
