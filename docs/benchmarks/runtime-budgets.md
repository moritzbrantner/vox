# Runtime budgets of the speaking workflows (vox#43)

What the product costs on real recordings, per workflow, on the desktop and in the browser. Two
kinds of evidence are kept apart:

- **Deterministic work counters**: how much analysis, storage and copying a workflow does for its
  input. These are correctness: work must stay proportional to the input. They are compared exactly
  with the committed baseline [`runtime-budgets.json`](runtime-budgets.json), and a difference or a
  proportional-work violation fails the run.
- **Wall-clock, CPU and memory**: reported against advisory budgets. They never fail a run
  (PRINCIPLE-015: a feature is never blocked by speed alone). A budget that is over gets an
  optimization issue.

## Workflows

| Workflow | Desktop (`workflow_bench.rs`) | Browser (`apps/web/src/bench/runtimeBudgets.ts`) |
|---|---|---|
| **record → live feedback → stop → save** | Recorder chunks (2048 samples) through live Silero speech detection; transcript segments (each partial first, then final, when their 8 s transcription chunk ends) and recorder pauses (when they end) through the incremental analysis stream. Stop: live detection finished (its spans are the evidence; Silero runs over the whole capture again only when the live run was interrupted or failed), the stream's finish with its batch oracle, the batch analysis with the last 90 s of audio. Save: the session's own value and the session id list sealed into protected storage, the kept audio sealed, the session's speech corpus entry sealed. The corpus analysis the app then asks for runs off the Save path (`corpusAnalysisMs`). | Same arrivals through the on-device stream (`AnalysisStream` from `packages/shared`). Stop: the stream's finish, then `analyzeWithFallback` with the last 90 s (the on-device batch, no compute server). Save: `createSessionRecord`, the session's value and the id list into `localStorage`, the kept audio into IndexedDB, the local corpus analysis. Speech detection is unavailable off the desktop. |
| **review a saved session** | Opening the app: every web-storage entry unsealed, every corpus entry unsealed and the corpus analyzed; then each session's kept audio unsealed. | `loadSessionsFromStorage` (parse and validate every session), the corpus analysis, then each session's kept audio from IndexedDB. |
| **import a backup** | The Rust side of a restore: the session list replaced, the corpus replaced and analyzed, kept audio retained to the restored ids. | An encrypted backup of every session (PBKDF2 600,000 iterations, AES-GCM) decrypted, validated (`parseSessionBackup`) and restored, kept audio retained. |
| **transcription** | Summarized from the `asr-eval` run that produced the transcripts: native-whisperx `serve` child (vox#147), one model load per run. | Not measured: browser recognition is the browser's own engine. |

Recordings are processed one after another into one store, the way a user builds a history, so
review and the corpus analysis include the sessions saved before. What one Save writes does not:
the session's value and corpus entry are that session's own, and only the id list grows, by one id
per session (vox#157).

Inputs: the 30 UCLASS release 1 recordings of the ASR challenge set
([`asr-challenge-set.json`](asr-challenge-set.json), the noise subset excluded) with their
native-whisperx large-v3-turbo transcripts (vox#26/#143), 67.6 audio minutes, 532 segments. The
same inputs as the live-analysis parity harness ([`live-analysis-parity.md`](live-analysis-parity.md)).

## Running it

```sh
bash scripts/source-deps activate
bun install --linker hoisted
VOX_SILERO_VAD_MODEL=<silero_vad.onnx> ORT_DYLIB_PATH=<libonnxruntime.so, 1.24 or later> \
  bun run benchmark:runtime-budgets --hypotheses ~/.cache/uclass/runs/nwx-turbo-cuda.json \
    --root ~/.cache/uclass
```

It builds and runs `workflow-bench` (desktop, release), starts the web dev server and drives
`apps/web/bench/runtime-budgets.html` in Chrome (`--channel chromium` for Playwright's own build),
prints the tables below and writes the full report to `.artifacts/runtime-budgets/<revision>.json`.
`--only desktop|browser` runs one side, `--limit N` the first N recordings, `--update` rewrites the
counter baseline after an intended change (review its diff like code).

Without a loadable ONNX Runtime the desktop run cannot detect speech; with a missing or too old one
it currently hangs (vox#159), so set `ORT_DYLIB_PATH` to ONNX Runtime 1.24 or later.

Fast checks on every change, without the corpus: `cargo test --lib workflow_bench` and
`apps/web/src/bench/runtimeBudgets.test.ts` (in `test:unit`) run each workflow on synthetic
recordings of 84 s and 168 s and require twice the input to cost exactly twice the analysis, the
acoustic batch to stop at its 90 s window, each stored value to be read once on review, a Save to
write the same session and corpus bytes after two earlier sessions as after none, and the
violation rules below to catch injected disproportionate work.

## Proportional-work rules (blocking)

For every recording, on both platforms (`record_violations` / `recordViolations`):

- every token, final segment and pause analyzed exactly once;
- segment positions revisited only by each segment's own partial-to-final correction (one per
  segment), pause positions never;
- at most one full rebuild: the first segment's correction before any pause arrived replaces from
  position 0, anything more rebuilds history;
- chunk rows read only the events that can reach them: fewer than 12 plus twice the event density
  per chunk row (a rescan of history grows with every retained event);
- one report per changing update plus the finalized one; unchanged input sends nothing;
- live analysis parity with the batch oracle is `match`;
- the batch acoustic analysis gets at most 90 s of audio;
- the saved session list holds at most 50 sessions;
- review opens each kept capture once; import restores every session.

Plus: every counter equals the baseline exactly.

## Results

Development machine: AMD Ryzen 7 5700X (8 cores), RTX 3060 Ti, Linux 7.0, release build; Chrome
156.0.8078.73. Shared with other builds, so timings carry that noise; counters do not.

CPU is process user+system time of every thread on the desktop; in the browser it is the main
thread's busy time (`TaskDuration`), which excludes Web Crypto and IndexedDB work done off the main
thread. Memory is the process's peak resident set on the desktop (reset at each workflow's start;
the start value is what earlier workflows left resident) and the sampled peak JS heap in the
browser (`JSHeapUsedSize` every 100 ms, not the renderer's resident memory).

### desktop: 30 recordings, 67.6 audio min, 532 segments

| Workflow | Wall s | CPU s | Peak memory MiB (start) | Key latency | Budget (advisory) |
|---|---|---|---|---|---|
| record → live feedback → stop → save | 45.28 | 44.98 | 105.6 (4.0) | live update p95 0.027 ms (worst recording); VAD chunk p95 0.982 ms; Stop median 782 ms, max 979 ms; Save median 36.6 ms, max 58.8 ms | update ≤ 16 ms within; VAD ≤ 32 ms within; Stop ≤ 2000 ms within; Save ≤ 250 ms within |
| review saved sessions | 0.351 | 0.31 | 95.3 (88.7) | open 53.8 ms; kept audio p95 19.5 ms | open ≤ 1000 ms within; audio ≤ 100 ms within |
| import a backup | 0.082 | 0.05 | 87.3 (87.3) | sessionList 21.2 ms; corpus 59.8 ms; retain 0.2 ms | ≤ 3000 ms within |

Before vox#158 the record workflow took 75 s for 67.6 audio minutes, with Stop at 44.3 s (Silero
over the whole capture again: mean 666 ms; the batch acoustic analysis: mean 808 ms). Stop now
reuses the live run's spans: no finite Silero pass, and Stop is the batch acoustic analysis.

The tables are the run after vox#157 (Save writes one session). Of its timing changes against the
previous run (#162), only Save and its corpus part come from that change: the corpus write on Save
went from 2.8 ms for the first session and 50 to 250 ms by the 30th to 0.6 ms median (max 3.5 ms)
at every history length, and Save to 36.6 ms median, which is now the sealed kept-audio write. The
record wall time (40.8 s → 45.3 s), Stop (730 → 782 ms median), VAD chunk p95 (0.75 → 0.98 ms),
review and import times are machine noise: those code paths did not change, and every counter
outside storage is identical to the previous baseline. The corpus analysis the app asks for after
Save (off its path) grows with the corpus: 1.7 ms after the first session, 47 ms after the 30th.

Proportional work (deterministic):

| Counter | Total | Per audio second | Per segment |
|---|---|---|---|
| changing live updates | 2034 | 0.502 | 3.823 |
| tokens analyzed | 5265 | 1.299 | 9.897 |
| segments analyzed | 532 | 0.131 | 1.000 |
| segment positions revisited (partial → final) | 532 | 0.131 | 1.000 |
| pauses analyzed | 970 | 0.239 | 1.823 |
| full rebuilds | 4 | 0.001 | 0.008 |
| reports built | 2064 | 0.509 | 3.880 |
| events written into live reports (full snapshots) | 45721 | 11.280 | 85.942 |
| events read for chunk rows | 68646 | 16.936 | 129.034 |
| VAD chunks | 31683 | 7.816 | 59.555 |
| Silero samples (16 kHz, one pass) | 64853629 | 16000.000 | 121905.318 |
| finite Silero passes on Stop | 0 | 0.000 | 0.000 |
| batch acoustic samples | 43200000 | 10657.846 | 81203.008 |
| session values written on Save (bytes) | 1650280 | 407.140 | 3102.030 |
| session id list written on Save (bytes) | 13127 | 3.239 | 24.675 |
| corpus entries written on Save (bytes) | 119972 | 29.598 | 225.511 |

Session and corpus writes per Save: first 45010, last 63006, max 100522 bytes: each session's own
size. Before vox#157, 30 saves wrote 26.5 MB of session list (42 KB for the first, 1.65 MB by the
30th) and 2.9 MB of corpus document.

### browser: 30 recordings, 67.6 audio min, 532 segments

| Workflow | Wall s | CPU s | Peak memory MiB (start) | Key latency | Budget (advisory) |
|---|---|---|---|---|---|
| record → live feedback → stop → save | 10.69 | 7.56 | 206.6 (3.7) | live update p95 0.100 ms (worst recording); VAD unavailable off the desktop; Stop median 192 ms, max 284 ms; Save median 53.8 ms, max 77.1 ms | update ≤ 16 ms within; Stop ≤ 2000 ms within; Save ≤ 250 ms within |
| review saved sessions | 1.000 | 0.57 | 61.4 (61.4) | open 5.9 ms; kept audio p95 41.6 ms | open ≤ 1000 ms within; audio ≤ 100 ms within |
| import a backup | 0.090 | 0.02 | 11.3 (8.0) | export 120.6 ms; decrypt 83.2 ms; validate 2.5 ms; restore 2.2 ms | ≤ 3000 ms within |

Browser Save is the IndexedDB audio write (51 ms median); the session writes take 0.3 ms at every
history length. The other timing changes against the previous run are machine noise: those code
paths did not change.

Proportional work (deterministic):

| Counter | Total | Per audio second | Per segment |
|---|---|---|---|
| changing live updates | 2034 | 0.502 | 3.823 |
| tokens analyzed | 5265 | 1.299 | 9.897 |
| segments analyzed | 532 | 0.131 | 1.000 |
| segment positions revisited (partial → final) | 532 | 0.131 | 1.000 |
| pauses analyzed | 970 | 0.239 | 1.823 |
| full rebuilds | 4 | 0.001 | 0.008 |
| reports built | 2064 | 0.509 | 3.880 |
| events written into live reports (full snapshots) | 45270 | 11.169 | 85.094 |
| events read for chunk rows | 67940 | 16.761 | 127.707 |
| batch acoustic samples | 43200000 | 10657.846 | 81203.008 |
| session values written on Save (UTF-16 units) | 957872 | 236.316 | 1800.511 |
| session id list written on Save (UTF-16 units) | 13127 | 3.239 | 24.675 |

Session writes per Save: first 24821, last 37311, max 52436 UTF-16 units (15.4 M for 30 saves
before vox#157).

### Transcription (asr-eval run of the same recordings)

| Engine | Model | Recordings | Audio min | Cold first recording RTF | Warm median RTF | Warm max RTF | Peak memory MiB | Budget (advisory) |
|---|---|---|---|---|---|---|---|---|
| nativeWhisperx (cuda, pyannote VAD) | large-v3-turbo | 30 | 67.6 | 0.061 | 0.067 | 0.082 | 1947.7 | warm ≤ 0.25 within |

The cold first recording includes the serve child's model load; that it is not slower than the warm
ones means the load is small next to a two-minute recording on this GPU.

## Findings

- **Live analysis is proportional on both platforms.** Every token is analyzed once, every segment
  revisited only by its partial-to-final correction, and the slowest live update is under 0.1 ms.
  Four recordings start with a segment before any pause and show the one allowed full rebuild.
  Each live report is a full snapshot, so the events written per update grow with the events so far
  (85 per segment over these sessions); at under 0.1 ms per update that is not worth changing now.
- **Save was history-proportional** (vox#157, fixed). The whole session list was rewritten on every
  save (26.5 MB for 30 saves), and the desktop rewrote and re-analyzed the whole speech corpus.
  Now each session is its own stored value next to a list of ids, the corpus keeps one entry per
  session, and a save writes the saved session, its corpus entry and the id list (about 28 bytes
  more per session saved before). The desktop reads and parses the corpus once per app run and keeps it in
  step with each change; the analysis is computed when the app asks for it after Save, off its
  path. The browser reuses each session parsed from an unchanged stored value instead of parsing
  the whole list again on every mutation.
- **Stop analyzed the audio with Silero twice** on the desktop (vox#158, fixed): a clean live run
  (detected, every chunk analyzed, the whole capture received) is now the saved evidence, and the
  finite pass runs only for interrupted, failed or incomplete live runs. The bench checks that
  Silero sees each capture's samples exactly once.
- **A missing or too old ONNX Runtime hangs speech detection** instead of reporting it unavailable
  (vox#159). Found because the first desktop run never finished.
- The browser's Stop is faster than the desktop's because it has no speech detection and its
  on-device batch is the reduced `fallbackAnalyze`; the two are different analyses, not a speed
  comparison of one.

## Not measured (unknown)

- Physical mobile devices, thermal and battery behavior, and mobile foreground/background
  workflows: no physical device run exists. CI and this desktop machine are not mobile evidence.
- The desktop web view (WebKitGTK): the review and import work done in the web view (parsing and
  validating sessions, decrypting a backup) is measured in Chrome only; on the desktop it runs the
  same code in WebKitGTK, whose cost is unknown.
- UI responsiveness (input latency, rendering) and microphone-to-ear latency (vox#30).
- Speaker attribution and cold/warm whisper.cpp startup: not part of these workflows' default path.
- Energy use.
