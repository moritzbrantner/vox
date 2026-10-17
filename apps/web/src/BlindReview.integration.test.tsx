import { migrateSessionRecord } from "@stutter-tracker/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

function session(id: string, text: string, startedAt: string, assisted: boolean): SavedSession {
  const record = migrateSessionRecord({
    id,
    startedAt,
    segments: [{ text, startSeconds: 0, endSeconds: 2, confidence: 0.9, isFinal: true }],
    pauses: [],
    report: {
      totalDurationSeconds: 2,
      wordCount: 3,
      stutterCount: 1,
      stuttersPerMinute: 30,
      severity: "high",
      speechStats: {
        speakingDurationSeconds: 2,
        pauseDurationSeconds: 0,
        wordsPerMinute: 90,
        articulationRateWpm: 90,
        meanChunkWords: 3,
        meanChunkDurationSeconds: 2,
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
          endSeconds: 0.6,
          text: "I I",
          detail: "Model-detected repetition",
          confidence: 0.9,
        },
      ],
      byKind: { wordRepetition: 1 },
    },
  });
  return {
    ...record,
    context: {
      ...record.context,
      condition: assisted
        ? { kind: "assisted", aidId: "delayedAuditoryFeedback", settings: { delayMs: 80 } }
        : { kind: "unassisted" },
    },
  };
}

const SESSIONS = [
  session("s-assisted", "I I want tea", "2026-05-19T10:00:00.000Z", true),
  session("s-plain", "I I want coffee", "2026-05-20T10:00:00.000Z", false),
];
const stored = () => JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedSession[];

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("blind review (vox#23)", () => {
  it("hides analysis, dates and conditions and saves revisions as made without the analysis", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify(SESSIONS));
    const { container } = renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Start blind review" }));

    const blind = screen.getByRole("region", { name: "Blind review" });
    const recordings = within(blind).getAllByRole("button", { name: /^Recording \d$/ });
    expect(recordings).toHaveLength(2);
    await userEvent.click(recordings[0]);
    const workbench = await screen.findByRole("region", { name: "Annotate events" });

    // The Auditory Feedback Lab below is a practice tool with no session data; the review is main.
    const text = blind.closest("main")?.textContent ?? "";
    expect(container.textContent).not.toContain("Model-detected repetition");
    for (const hidden of [
      "Model-detected repetition",
      "Word repetition 1",
      "assisted",
      "Assisted",
      "delayed",
      "2026",
      new Date(SESSIONS[0].startedAt).toLocaleString(),
      new Date(SESSIONS[1].startedAt).toLocaleDateString(),
      "s-assisted",
      "s-plain",
      "30",
    ]) {
      expect(text).not.toContain(hidden);
    }

    await userEvent.click(within(workbench).getByRole("button", { name: /0\.00s–2\.00s/ }));
    await userEvent.selectOptions(within(workbench).getByLabelText("New event kind"), "noSpeech");
    await userEvent.click(within(workbench).getByRole("button", { name: "Add event" }));
    await userEvent.click(within(workbench).getByRole("button", { name: "Save as reference" }));
    await screen.findByText("Annotation saved to the session");

    const annotated = stored().find((candidate) => candidate.annotations.length > 0)!;
    expect(annotated.annotations[0]).toMatchObject({
      basedOnRunId: null,
      status: "accepted",
      events: [{ kind: "noSpeech", startSeconds: 0, endSeconds: 2 }],
    });

    // The saved span label survives a reload (it is not quarantined as unreadable).
    const before = stored();
    cleanup();
    renderApp();
    await waitFor(() => expect(document.querySelectorAll(".session-row")).toHaveLength(2));
    expect(stored()).toEqual(before);
    await userEvent.click(await screen.findByRole("button", { name: "Start blind review" }));
    await userEvent.click(screen.getByRole("button", { name: "End blind review" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Blind review" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Start blind review" })).toBeInTheDocument();
  });

  it("names recordings independently of their order by date", async () => {
    const { blindReferences } = await import("./components/BlindReview");
    const forward = blindReferences(SESSIONS);
    expect(blindReferences([...SESSIONS].reverse())).toEqual(forward);
  });
});
