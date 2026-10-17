import { annotateSession, fallbackAnalyze, migrateSessionRecord } from "@stutter-tracker/shared";
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

function session(id: string, startedAt: string, language: string, blocks: number): SavedSession {
  const segments = [
    { text: "word ".repeat(30).trim(), startSeconds: 0, endSeconds: 60, isFinal: true },
  ];
  const record = migrateSessionRecord({
    id,
    startedAt,
    segments,
    pauses: [],
    report: fallbackAnalyze({ segments, pauses: [] }),
  });
  return annotateSession(
    { ...record, context: { ...record.context, spokenLanguage: language } },
    {
      id: `${id}-ref`,
      createdAt: startedAt,
      author: { role: "clinician", id: "SLT" },
      basedOnRunId: null,
      events: Array.from({ length: blocks }, (_, index) => ({
        kind: "block" as const,
        startSeconds: index * 5,
        endSeconds: index * 5 + 1,
        certainty: "certain" as const,
      })),
      status: "accepted",
      supersedes: null,
    },
  );
}

const EARLIER = session("s-1", "2026-05-19T10:00:00.000Z", "en", 6);
const LATER = session("s-2", "2026-05-20T10:00:00.000Z", "en", 2);
const LEGACY = session("s-3", "2026-05-21T10:00:00.000Z", "unknown", 1);
const stored = () => JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as SavedSession[];

async function tagRow(container: HTMLElement, index: number, task: string) {
  const rows = await waitFor(() => {
    const found = container.querySelectorAll<HTMLButtonElement>(".session-row");
    expect(found.length).toBeGreaterThan(index);
    return found;
  });
  await userEvent.click(rows[index]);
  const panel = screen.getByRole("region", { name: "Compare two sessions" });
  await userEvent.selectOptions(within(panel).getByLabelText("Speaking task"), task);
  await userEvent.selectOptions(within(panel).getByLabelText("Assistance"), "unassisted");
  return panel;
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("matched session comparison (vox#28)", () => {
  it("tags context, refuses an unmatched pair and compares a matched one on reviewed labels", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([LATER, EARLIER, LEGACY]));
    const { container } = renderApp();

    let panel = await tagRow(container, 0, "reading");
    await userEvent.click(within(panel).getByRole("button", { name: "Save context" }));
    await screen.findByText("Session context saved to the session");
    panel = await tagRow(container, 1, "reading");
    await userEvent.click(within(panel).getByRole("button", { name: "Save context" }));
    await waitFor(() => expect(stored().filter((item) => item.context.task)).toHaveLength(2));
    expect(stored().find((item) => item.id === "s-1")!.context).toEqual({
      spokenLanguage: "en",
      task: { kind: "reading", trained: false },
      condition: { kind: "unassisted" },
    });
    // Tagging does not touch the observation, analysis or labels.
    expect(stored().find((item) => item.id === "s-1")!.annotations).toEqual(EARLIER.annotations);

    // A legacy session's unknown language can be declared once; a recorded one is not offered.
    panel = await tagRow(container, 2, "conversation");
    await userEvent.selectOptions(
      within(panel).getByLabelText("Spoken language (not recorded)"),
      "en",
    );
    await userEvent.click(within(panel).getByRole("button", { name: "Save context" }));
    await waitFor(() =>
      expect(stored().find((item) => item.id === "s-3")!.context.spokenLanguage).toBe("en"),
    );
    expect(
      within(panel).queryByLabelText("Spoken language (not recorded)"),
    ).not.toBeInTheDocument();

    const [first, second] = within(panel).getAllByRole("combobox").slice(-2);
    const pick = (select: HTMLElement, id: string) => {
      const label = new Date(stored().find((item) => item.id === id)!.startedAt).toLocaleString();
      const option = within(select)
        .getAllByRole<HTMLOptionElement>("option")
        .find((candidate) => candidate.textContent!.startsWith(label))!;
      return userEvent.selectOptions(select, option);
    };
    await pick(first, "s-1");
    await pick(second, "s-3");
    expect(within(panel).getByText(/they are different speaking tasks/)).toBeInTheDocument();

    await pick(second, "s-2");
    const result = within(panel).getByRole("group", { name: "Comparison result" });
    expect(
      within(result).getByText("Fewer reviewed events per speaking minute in session 2."),
    ).toBeInTheDocument();
    expect(
      within(result).getByText(/Language en · task reading \(not practised\)/),
    ).toBeInTheDocument();
    expect(within(result).getByText(/not evidence of treatment effect/)).toBeInTheDocument();
  });

  it("filters progress to one language, task and condition and keeps the language breakdown otherwise", async () => {
    const reading = { kind: "reading" as const, trained: false };
    const tag = (item: SavedSession, spokenLanguage: string): SavedSession => ({
      ...item,
      context: { spokenLanguage, task: reading, condition: { kind: "unassisted" } },
    });
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([tag(EARLIER, "en"), tag(LATER, "en"), tag({ ...LEGACY, id: "s-de" }, "de")]),
    );
    renderApp();
    const group = await screen.findByLabelText("Sessions");
    expect(screen.getByText(/Languages: en 2, de 1\./)).toBeInTheDocument();
    expect(screen.getByText(/they span 2 different languages/)).toBeInTheDocument();

    await userEvent.selectOptions(group, "en|reading:untrained|unassisted");
    expect(screen.queryByText(/Languages: en 2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/different languages/)).not.toBeInTheDocument();
    expect(
      within(group).getByRole("option", { name: "en · reading · unassisted (2)" }),
    ).toBeInTheDocument();
  });
});
