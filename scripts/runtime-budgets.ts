// Runtime budgets of the speaking workflows on real recordings, desktop and browser (vox#43).
// See docs/benchmarks/runtime-budgets.md for what is measured and how to read it.
//
//   VOX_SILERO_VAD_MODEL=<silero_vad.onnx> ORT_DYLIB_PATH=<libonnxruntime.so (1.24+)> \
//     bun scripts/runtime-budgets.ts --hypotheses ~/.cache/uclass/runs/nwx-turbo-cuda.json \
//       --root ~/.cache/uclass [--limit N] [--only desktop|browser] [--channel chrome] \
//       [--update] [--out report.json]
//
// - Deterministic work counters are compared exactly with docs/benchmarks/runtime-budgets.json
//   and must satisfy the proportional-work rules; a difference or violation exits 1. `--update`
//   rewrites the baseline after an intended change.
// - Wall-clock, CPU and memory are reported against advisory budgets and never fail the run.
// - Transcription is summarized from the asr-eval run that produced the transcripts (its
//   per-recording wall time and the serve child's peak memory); rerun it with
//   `bun run benchmark:asr transcribe ...` to refresh it.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const baselinePath = join(root, "docs/benchmarks/runtime-budgets.json");

type Json = Record<string, unknown>;
const args = new Map<string, string>();
const flags = new Set<string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (["--update"].includes(argument)) flags.add(argument);
  else args.set(argument, process.argv[++index] ?? "");
}
const hypothesesPath = args.get("--hypotheses");
const corpusRoot = args.get("--root");
if (!hypothesesPath || !corpusRoot) {
  console.error("usage: bun scripts/runtime-budgets.ts --hypotheses <asr-eval run> --root <dir>");
  process.exit(2);
}
const limit = Number(args.get("--limit") ?? Infinity);
const only = args.get("--only");
const channel = args.get("--channel") ?? "chrome";
const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root })
  .stdout.toString()
  .trim();
const outPath = resolve(
  args.get("--out") ?? join(root, `.artifacts/runtime-budgets/${revision}.json`),
);

const hypothesesText = readFileSync(hypothesesPath, "utf8");
const hypotheses = JSON.parse(hypothesesText) as {
  engine?: string;
  model?: string;
  chunkSeconds?: number;
  peakRssBytes?: number;
  items: Array<{
    item: string;
    subset?: string;
    audioSeconds?: number;
    wallSeconds?: number;
    segments: Array<{ text: string; startSeconds: number; endSeconds: number }>;
  }>;
};
const items = hypotheses.items.filter((item) => !item.subset?.includes("noise")).slice(0, limit);
const chunkSeconds = hypotheses.chunkSeconds ?? 8;

// --- Desktop --------------------------------------------------------------------------------
function desktop(): Json {
  const manifest = join(root, "apps/desktop/src-tauri/Cargo.toml");
  const build = spawnSync(
    "cargo",
    ["build", "--release", "--manifest-path", manifest, "--bin", "workflow-bench"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (build.status !== 0) throw new Error("workflow-bench did not build");
  const run = spawnSync(
    join(root, "apps/desktop/src-tauri/target/release/workflow-bench"),
    [
      "--hypotheses",
      resolve(hypothesesPath!),
      "--root",
      resolve(corpusRoot!),
      ...(Number.isFinite(limit) ? ["--limit", String(limit)] : []),
    ],
    { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] },
  );
  if (run.status !== 0) throw new Error("workflow-bench failed");
  return JSON.parse(run.stdout.toString()) as Json;
}

// --- Browser --------------------------------------------------------------------------------
async function browser(): Promise<Json> {
  const { chromium } = await import("@playwright/test");
  const port = 1431;
  const server = spawn(
    "bunx",
    ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: join(root, "apps/web"),
      // No compute server: the browser analyzes on the device.
      env: { ...process.env, VITE_STUTTER_SERVER_URL: "" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  try {
    await new Promise<void>((ready, failed) => {
      server.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes(`${port}`)) ready();
      });
      server.on("exit", () => failed(new Error("vite exited")));
    });
    const instance = await chromium.launch({
      ...(channel === "chromium" ? {} : { channel }),
      args: ["--enable-precise-memory-info"],
    });
    try {
      const page = await instance.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const metrics = async () => {
        const { metrics } = (await cdp.send("Performance.getMetrics")) as {
          metrics: Array<{ name: string; value: number }>;
        };
        return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
      };
      const marks: Record<string, Record<string, number>> = {};
      let peakHeap = 0;
      const sampler = setInterval(() => {
        metrics()
          .then((values) => {
            peakHeap = Math.max(peakHeap, values.JSHeapUsedSize ?? 0);
          })
          .catch(() => undefined);
      }, 100);
      await page.exposeFunction("voxBenchMark", async (name: string) => {
        const values = await metrics();
        if (name.endsWith(":start")) peakHeap = values.JSHeapUsedSize ?? 0;
        marks[name] = { ...values, peakHeap: Math.max(peakHeap, values.JSHeapUsedSize ?? 0) };
      });
      await page.route("**/__uclass/*.wav", (route) => {
        const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
        route.fulfill({
          body: readFileSync(join(corpusRoot!, "audio16k", id)),
          contentType: "audio/wav",
        });
      });
      await page.goto(`http://127.0.0.1:${port}/bench/runtime-budgets.html`);
      await page.waitForFunction(() => "voxBench" in window);
      const report = (await page.evaluate(([list, seconds]) => window.voxBench.run(list, seconds), [
        items.map((item) => ({ id: item.item, segments: item.segments })),
        chunkSeconds,
      ] as const)) as Json;
      clearInterval(sampler);
      const phase = (name: string) => {
        const start = marks[`${name}:start`];
        const end = marks[`${name}:end`];
        return {
          wallSeconds: end.Timestamp - start.Timestamp,
          // Main-thread busy time and script time from the browser's own metrics, seconds.
          taskSeconds: end.TaskDuration - start.TaskDuration,
          scriptSeconds: end.ScriptDuration - start.ScriptDuration,
          startHeapBytes: start.JSHeapUsedSize,
          sampledPeakHeapBytes: end.peakHeap,
        };
      };
      report.phases = { record: phase("record"), review: phase("review"), import: phase("import") };
      report.browserVersion = instance.version();
      return report;
    } finally {
      await instance.close();
    }
  } finally {
    server.kill();
  }
}

// --- Transcription (from the asr-eval run) ---------------------------------------------------
function transcription(): Json {
  const timed = items.filter((item) => item.wallSeconds && item.audioSeconds);
  if (!timed.length) return { state: "unknown", reason: "the run has no per-recording times" };
  const factors = timed.map((item) => item.wallSeconds! / item.audioSeconds!);
  const warm = factors.slice(1).sort((a, b) => a - b);
  return {
    engine: hypotheses.engine ?? null,
    model: hypotheses.model ?? null,
    recordings: timed.length,
    audioSeconds: timed.reduce((sum, item) => sum + item.audioSeconds!, 0),
    wallSeconds: timed.reduce((sum, item) => sum + item.wallSeconds!, 0),
    // The serve child loads its model during the first recording.
    coldFirstRecordingRtf: factors[0],
    warmMedianRtf: warm[Math.floor(warm.length / 2)] ?? null,
    warmMaxRtf: warm[warm.length - 1] ?? null,
    peakRssBytes: hypotheses.peakRssBytes ?? null,
  };
}

// --- Counters and checks ---------------------------------------------------------------------
/** The deterministic part of a platform report: everything but timings and phases. */
function counters(report: Json) {
  const recordings = report.recordings as Array<{ id: string; counters: Json }>;
  return {
    recordings: Object.fromEntries(recordings.map((item) => [item.id, item.counters])),
    review: (report.review as Json[])[0],
    import: (report.import as Json[])[0],
  };
}

function differences(path: string, expected: unknown, actual: unknown, out: string[]) {
  if (typeof expected === "object" && expected && typeof actual === "object" && actual) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      differences(`${path}.${key}`, (expected as Json)[key], (actual as Json)[key], out);
    }
  } else if (!Object.is(expected, actual)) {
    out.push(`${path}: baseline ${JSON.stringify(expected)}, now ${JSON.stringify(actual)}`);
  }
}

/** Advisory budgets (PRINCIPLE-015: reported, never blocking). */
const BUDGETS = {
  liveUpdateP95Ms: 16,
  // A quarter of the real time of one 2048-sample recorder chunk at 16 kHz (128 ms).
  vadPushP95Ms: 32,
  stopMsPerRecording: 2_000,
  saveMs: 250,
  reviewOpenMs: 1_000,
  audioOpenP95Ms: 100,
  importMs: 3_000,
  transcriptionWarmRtf: 0.25,
};

const fmt = (value: number | null | undefined, digits = 1) =>
  value == null || Number.isNaN(value) ? "unknown" : value.toFixed(digits);
const mib = (bytes: number | null | undefined) =>
  bytes == null ? "unknown" : (bytes / 1024 / 1024).toFixed(1);
const within = (value: number | null | undefined, budget: number) =>
  value == null ? "unknown" : value <= budget ? "within" : "**over (advisory)**";
const max = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

type Recorded = {
  id: string;
  audioSeconds: number;
  counters: Json & { stream: Json };
  timings: Json & { streamUpdate: Json; vadPush?: Json };
};

function table(platform: string, report: Json) {
  const recordings = report.recordings as Recorded[];
  const phases = report.phases as Record<string, Json>;
  const audio = sum(recordings.map((item) => item.audioSeconds));
  const segments = sum(recordings.map((item) => item.counters.segments as number));
  const stream = (key: string) =>
    sum(recordings.map((item) => item.counters.stream[key] as number));
  const lines: string[] = [];
  lines.push(
    `### ${platform}: ${recordings.length} recordings, ${(audio / 60).toFixed(1)} audio min, ${segments} segments\n`,
  );
  lines.push(
    "| Workflow | Wall s | CPU s | Peak memory MiB (start) | Key latency | Budget (advisory) |",
  );
  lines.push("|---|---|---|---|---|---|");
  const cpu = (phase: Json) => (phase.cpuSeconds ?? phase.taskSeconds) as number | undefined;
  const memory = (phase: Json) =>
    `${mib((phase.peakRssBytes ?? phase.sampledPeakHeapBytes) as number)} (${mib((phase.startRssBytes ?? phase.startHeapBytes) as number)})`;
  const updateP95 = max(recordings.map((item) => item.timings.streamUpdate.p95Ms as number));
  const vadP95 = recordings[0]?.timings.vadPush
    ? max(recordings.map((item) => item.timings.vadPush!.p95Ms as number))
    : null;
  const stops = recordings.map((item) => item.timings.stopMs as number);
  const saves = recordings.map((item) => item.timings.saveMs as number);
  const recordWall = (phases.record.wallSeconds as number | undefined) ?? null;
  lines.push(
    `| record → live feedback → stop → save | ${fmt(recordWall, 2)} | ${fmt(cpu(phases.record), 2)} | ${memory(phases.record)} | live update p95 ${fmt(updateP95, 3)} ms (worst recording); VAD chunk p95 ${fmt(vadP95, 3)} ms; Stop median ${fmt(median(stops), 0)} ms, max ${fmt(max(stops), 0)} ms; Save median ${fmt(median(saves), 1)} ms, max ${fmt(max(saves), 1)} ms | update ≤ ${BUDGETS.liveUpdateP95Ms} ms ${within(updateP95, BUDGETS.liveUpdateP95Ms)}; VAD ≤ ${BUDGETS.vadPushP95Ms} ms ${vadP95 == null ? "n/a" : within(vadP95, BUDGETS.vadPushP95Ms)}; Stop ≤ ${BUDGETS.stopMsPerRecording} ms ${within(max(stops), BUDGETS.stopMsPerRecording)}; Save ≤ ${BUDGETS.saveMs} ms ${within(max(saves), BUDGETS.saveMs)} |`,
  );
  const [, reviewTimings] = report.review as [Json, Json & { audioOpen: Json }];
  lines.push(
    `| review saved sessions | ${fmt(phases.review.wallSeconds as number, 3)} | ${fmt(cpu(phases.review), 2)} | ${memory(phases.review)} | open ${fmt(reviewTimings.appOpenMs as number, 1)} ms; kept audio p95 ${fmt(reviewTimings.audioOpen.p95Ms as number, 1)} ms | open ≤ ${BUDGETS.reviewOpenMs} ms ${within(reviewTimings.appOpenMs as number, BUDGETS.reviewOpenMs)}; audio ≤ ${BUDGETS.audioOpenP95Ms} ms ${within(reviewTimings.audioOpen.p95Ms as number, BUDGETS.audioOpenP95Ms)} |`,
  );
  const [, importTimings] = report.import as [Json, Json];
  const importMs =
    sum(Object.values(importTimings).filter((v) => typeof v === "number") as number[]) -
    ((importTimings.exportMs as number | undefined) ?? 0);
  lines.push(
    `| import a backup | ${fmt(phases.import.wallSeconds as number, 3)} | ${fmt(cpu(phases.import), 2)} | ${memory(phases.import)} | ${Object.entries(
      importTimings,
    )
      .map(([key, value]) => `${key.replace(/Ms$/, "")} ${fmt(value as number, 1)} ms`)
      .join("; ")} | ≤ ${BUDGETS.importMs} ms ${within(importMs, BUDGETS.importMs)} |`,
  );
  lines.push("");
  lines.push("Proportional work (deterministic):\n");
  lines.push("| Counter | Total | Per audio second | Per segment |");
  lines.push("|---|---|---|---|");
  const row = (name: string, total: number) =>
    lines.push(
      `| ${name} | ${total} | ${(total / audio).toFixed(3)} | ${(total / Math.max(1, segments)).toFixed(3)} |`,
    );
  row("changing live updates", stream("updates"));
  row("tokens analyzed", stream("tokensAnalyzed"));
  row("segments analyzed", stream("segmentsAnalyzed"));
  row("segment positions revisited (partial → final)", stream("segmentsRevisited"));
  row("pauses analyzed", stream("pausesAnalyzed"));
  row("full rebuilds", stream("fullRebuilds"));
  row("reports built", stream("reportsBuilt"));
  row("events written into live reports (full snapshots)", stream("reportEvents"));
  row("events read for chunk rows", stream("chunkEventReads"));
  if (recordings[0]?.counters.vadChunks != null) {
    row("VAD chunks", sum(recordings.map((item) => item.counters.vadChunks as number)));
    row(
      "Silero samples (16 kHz, one pass)",
      sum(recordings.map((item) => item.counters.vadSileroSamples as number)),
    );
    row(
      "finite Silero passes on Stop",
      sum(recordings.map((item) => item.counters.vadFiniteRuns as number)),
    );
  }
  row(
    "batch acoustic samples",
    sum(recordings.map((item) => item.counters.acousticSamples as number)),
  );
  const unit = recordings[0]?.counters.savedSessionBytes != null ? "Bytes" : "Chars";
  const unitName = unit === "Bytes" ? "bytes" : "UTF-16 units";
  const written = (key: string) => recordings.map((item) => item.counters[key] as number);
  row(`session values written on Save (${unitName})`, sum(written(`savedSession${unit}`)));
  row(`session id list written on Save (${unitName})`, sum(written(`savedSessionIndex${unit}`)));
  if (recordings[0]?.counters.savedCorpusBytes != null) {
    row("corpus entries written on Save (bytes)", sum(written("savedCorpusBytes")));
  }
  // vox#157: what one Save writes must not grow with the sessions saved before it.
  const perSave = recordings.map(
    (item) =>
      (item.counters[`savedSession${unit}`] as number) +
      ((item.counters.savedCorpusBytes as number | undefined) ?? 0),
  );
  lines.push(
    `\nSession and corpus writes per Save: first ${perSave[0] ?? 0}, last ${perSave.at(-1) ?? 0}, max ${max(perSave)} (${unitName}).`,
  );
  return lines.join("\n");
}

// --- Main ------------------------------------------------------------------------------------
const reports: Record<string, Json> = {};
if (only !== "browser") reports.desktop = desktop();
if (only !== "desktop") reports.browser = await browser();
const asr = transcription();

const measured = Object.fromEntries(
  Object.entries(reports).map(([platform, report]) => [platform, counters(report)]),
);
const inputs = {
  hypotheses: createHash("sha256").update(hypothesesText).digest("hex"),
  recordings: items.map((item) => item.item),
  chunkSeconds,
};
const violations = Object.entries(reports).flatMap(([platform, report]) =>
  (report.violations as string[]).map((violation) => `${platform}: ${violation}`),
);
const drift: string[] = [];
if (flags.has("--update")) {
  const previous = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Json)
    : {};
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ ...previous, schemaVersion: 1, inputs, ...measured }, null, 2)}\n`,
  );
} else if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Json;
  differences("inputs", baseline.inputs, inputs, drift);
  for (const platform of Object.keys(measured)) {
    differences(platform, baseline[platform], measured[platform], drift);
  }
} else {
  drift.push(`no baseline at ${baselinePath}; run with --update`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify({ revision, inputs, transcription: asr, budgets: BUDGETS, ...reports }, null, 2)}\n`,
);

console.log(`## Runtime budgets at ${revision}\n`);
for (const [platform, report] of Object.entries(reports))
  console.log(`${table(platform, report)}\n`);
console.log("### Transcription (asr-eval run of the same recordings)\n");
console.log(
  "| Engine | Model | Recordings | Audio min | Cold first recording RTF | Warm median RTF | Warm max RTF | Peak memory MiB | Budget (advisory) |",
);
console.log("|---|---|---|---|---|---|---|---|---|");
console.log(
  `| ${asr.engine ?? "unknown"} | ${asr.model ?? "unknown"} | ${asr.recordings ?? 0} | ${fmt((asr.audioSeconds as number) / 60)} | ${fmt(asr.coldFirstRecordingRtf as number, 3)} | ${fmt(asr.warmMedianRtf as number, 3)} | ${fmt(asr.warmMaxRtf as number, 3)} | ${mib(asr.peakRssBytes as number)} | warm ≤ ${BUDGETS.transcriptionWarmRtf} ${within(asr.warmMaxRtf as number, BUDGETS.transcriptionWarmRtf)} |\n`,
);
console.log(`report: ${outPath}`);
if (violations.length || drift.length) {
  for (const line of violations) console.error(`proportional-work violation: ${line}`);
  for (const line of drift) console.error(`counter differs from baseline: ${line}`);
  process.exit(1);
}
console.log(
  flags.has("--update") ? `baseline updated: ${baselinePath}` : "counters match the baseline",
);
