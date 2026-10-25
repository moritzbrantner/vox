import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ANALYSIS_CAPABILITIES,
  type AnalysisOutput,
  type AnalyzeSpeechRequest,
  equivalentOutputs,
  fallbackAnalyze,
  type StutterEvent,
  type StutterKind,
} from "./index";

type NativeEvent = Pick<StutterEvent, "kind" | "startSeconds" | "endSeconds" | "text">;

// Written by the desktop app's `cross_runtime_parity_fixture_matches_native_analysis` test.
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/analysis-parity.json", import.meta.url), "utf8"),
) as {
  capabilities: { desktopNative: unknown };
  cases: Array<{ name: string; request: AnalyzeSpeechRequest; native: NativeEvent[] }>;
};

/** Transcript/pause event kinds of each output; acoustic and fused events need audio. */
const KINDS: Partial<Record<AnalysisOutput, StutterKind>> = {
  wordRepetition: "wordRepetition",
  soundRepetition: "soundRepetition",
  prolongation: "prolongation",
  filler: "filler",
  pauseBlock: "block",
};

// Same tolerance as the desktop reference (apps/desktop/src-tauri/STUTTER_BENCH.md).
const TOLERANCE = 1e-9;

function comparable(events: NativeEvent[], kind: StutterKind) {
  return events
    .filter((event) => event.kind === kind)
    .map(({ kind, startSeconds, endSeconds, text }) => ({ kind, startSeconds, endSeconds, text }));
}

describe("analysis capability matrix", () => {
  test("the native row matches what the desktop analyzer reports", () => {
    expect(ANALYSIS_CAPABILITIES.desktopNative).toEqual(
      fixture.capabilities.desktopNative as never,
    );
  });

  test("the shared fallback identifies itself as reduced, per producer", () => {
    const request = fixture.cases[0].request;
    expect(fallbackAnalyze(request).capabilities).toEqual(ANALYSIS_CAPABILITIES.onDevice);
    expect(fallbackAnalyze(request, "computeServer").capabilities).toEqual(
      ANALYSIS_CAPABILITIES.computeServer,
    );
    for (const producer of ["onDevice", "computeServer"] as const) {
      const capabilities = ANALYSIS_CAPABILITIES[producer];
      expect(capabilities.reduced).toBe(true);
      expect(capabilities.outputs.eventEvidence).toBe("unsupported");
      expect(capabilities.outputs.missingObservations).toBe("unsupported");
    }
    // No analyzer attributes speech to a speaker.
    for (const capabilities of Object.values(ANALYSIS_CAPABILITIES)) {
      expect(capabilities.outputs.speakerAttribution).toBe("unsupported");
    }
  });
});

describe("cross-runtime parity on shared input", () => {
  const native = ANALYSIS_CAPABILITIES.desktopNative;
  const fallback = ANALYSIS_CAPABILITIES.onDevice;
  const equivalent = equivalentOutputs(native, fallback).filter((output) => KINDS[output]);

  test("only outputs both analyzers fully support are compared for equality", () => {
    expect(equivalent).toEqual(["prolongation", "filler", "pauseBlock"]);
  });

  for (const { name, request, native: nativeEvents } of fixture.cases) {
    test(`${name}: equivalent outputs agree`, () => {
      const report = fallbackAnalyze(request);
      for (const output of equivalent) {
        const kind = KINDS[output]!;
        const expected = comparable(nativeEvents, kind);
        const actual = comparable(report.events, kind);
        expect(actual.map((event) => event.text)).toEqual(expected.map((event) => event.text));
        actual.forEach((event, index) => {
          expect(Math.abs(event.startSeconds - expected[index].startSeconds)).toBeLessThan(
            TOLERANCE,
          );
          expect(Math.abs(event.endSeconds - expected[index].endSeconds)).toBeLessThan(TOLERANCE);
        });
      }
    });

    // Reduced and unsupported outputs are evaluated on their own terms, not forced to equal.
    test(`${name}: reduced word repetitions overlap every native one`, () => {
      const report = fallbackAnalyze(request);
      const reduced = comparable(report.events, "wordRepetition");
      for (const event of comparable(nativeEvents, "wordRepetition")) {
        expect(
          reduced.some(
            (candidate) =>
              candidate.startSeconds < event.endSeconds &&
              event.startSeconds < candidate.endSeconds,
          ),
        ).toBe(true);
      }
      expect(comparable(report.events, "soundRepetition")).toEqual([]);
    });
  }
});
