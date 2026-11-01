# Live analysis: incremental stream vs batch oracle (vox#38)

While recording, the desktop app analyzes the transcript and pauses incrementally
(`apps/desktop/src-tauri/src/analysis_stream.rs`). The batch analysis
(`speech_pipeline::analyze_speech_session`) is the oracle: after Stop, the stream's finalized report
is compared with the batch report of the same final transcript and pauses, and the result is saved
with the session as `report.liveAnalysis`.

## What is streamed and how exact it is

| Observation family | Incremental | Tolerance | Why |
|---|---|---|---|
| Transcript events: word repetitions, sound repetitions, hyphenated repetitions, prolongations, fillers (kind, span, text, detail, confidence, evidence id, citations) | yes, per final segment | exact | Per-segment detectors; events keep the batch order (start, then segment events before pause blocks, then position) and its duplicate removal |
| Pause blocks (pauses of at least 0.75 s) | yes, per pause | exact | One event per pause |
| Speaking rate (wpm), articulation rate, speaking and pause duration, mean chunk words and duration, event density, fluency percentage | yes, running totals | exact | Totals are folds kept per position in the batch's summation order; a revision rewinds to the fold before the first replaced position |
| Pause statistics: block count, total, mean and longest block, blocks per minute, blocked-time share | yes | exact | Computed from the reported events like the batch |
| Chunk rows (per final segment: events, blocks, fillers, wpm, silent time, confidence) | yes, reading only events and pauses near each chunk | exact | Silent time sums only overlapping pauses in pause order; a non-overlapping pause adds an exact zero in the batch |
| Cited observations and explicit missing channels | yes | exact | Each segment keeps the token observations its events cite |
| Severity, counts per kind, stutters per minute | yes | exact | Derived from the above |
| Acoustic analysis (onsets, spectral prolongations, acoustic blocks, fusion, capture metrics) | **no**, batch after Stop | — | Its thresholds are medians and MADs over the whole analyzed window; an incremental version would be a different model, not a faster one. The live report says `missing:acoustic` until the batch run after Stop, which is the report that is saved |

The comparison is of the serialized reports, value for value. There is no numerical tolerance: any
difference is a `mismatch` listing the differing fields, never absorbed by a tolerance.

## Update semantics

- Each update replaces the segments from one position on and the pauses from one position on (an
  append replaces the empty tail). Only the replaced positions are analyzed again.
- Partial (non-final) segments keep their position (it names the tokens of later segments) but
  contribute nothing, like in the batch; the partial-to-final correction replaces that position.
- Updates are numbered per run. A repeated or older update is ignored (`duplicateUpdates`). A
  missing update, or one that replaces beyond what the stream holds, makes the stream
  `interrupted`: nothing more is applied until a resynchronization from position 0, which the
  client sends on its next update. An interrupted run is `notComparable`, never compared as if
  complete.
- Starting a run replaces the previous one; updates and the finish of another run id are refused,
  so an old run cannot change the active session.
- More than 20,000 segments or 50,000 pauses makes the stream `overloaded`: the update is refused
  and the live report goes stale. The batch analysis takes over the live report, so a degraded
  stream never stands in for a fresh result.
- The client keeps one update in flight and folds later changes into the next one
  (`queue.coalescedChanges`, `queue.maxStalenessMs`). Unchanged input sends nothing; a no-op
  update does no analysis and builds no report.
- Off the desktop the stream is `unavailable` and the batch analysis runs as before.

## Work counters

Deterministic counters (`work`) are separate from wall-clock time (`maxUpdateMs`, `oracleMs`):
segments, tokens and pauses analyzed; positions revisited by revisions; full rebuilds; reports
built with their events and chunks; events read to count chunk events; retained segments, pauses,
events and cited observations. The tests assert that an append-only session analyzes every token
exactly once, revisits nothing, and reads a bounded number of events per chunk (no rescans of
history), and that no-input updates change no counter but `noOpUpdates`.

## Results

Unit and property tests (`cargo test --lib analysis_stream`) compare every intermediate report with
the batch report of exactly that prefix, for 12 generated sessions in 7 chunkings, 10 sessions with
partial-to-final corrections and revisions of the last three segments, shrinking and regrowing
input, the reference cases of `speech_reference` (including invalid timing), duplicate, reordered
and missing updates, overload and run replacement.

Real recordings: the 40 UCLASS release 1 recordings of the ASR challenge set
(`asr-challenge-set.json`) with their native-whisperx large-v3-turbo transcripts (`asr-eval` run,
vox#26/#143) and pauses found from the audio the way the recorder finds them. Segments arrive when
their transcription chunk ends, first partial, then final; pauses when they end. Every update is
compared with the batch report of that input, at three arrival cadences (1, 3 and 8 arrivals per
update).

```sh
VOX_UCLASS_HYPOTHESES=~/.cache/uclass/runs/nwx-turbo-cuda.json VOX_UCLASS_ROOT=~/.cache/uclass \
  cargo test --release --manifest-path apps/desktop/src-tauri/Cargo.toml --lib real_uclass -- --ignored --nocapture
```

All 240 runs match exactly: every intermediate report of every run equals the batch report of that input, and the finalized report equals the batch report of the final observation. Every token was analyzed exactly once. Items are the 30 recordings plus the 10 noise-subset transcripts of the same recordings (pauses from the clean audio). Slowest update is wall-clock time of a release build on the development machine, reported apart from the deterministic counters. "Positions revisited" are the partial-to-final corrections: each segment arrives partial first.

| Transcript source | Items | Audio min | Segments | Pauses | Events | Tokens (analyzed) | Runs matching (3 cadences each) | Slowest update ms |
|---|---|---|---|---|---|---|---|---|
| native-whisperx large-v3-turbo (CUDA) | 40 | 89.7 | 716 | 1297 | 1426 | 7419 (7419) | 120 / 120 | 0.083 |
| whisper.cpp base.en, 8 s chunks | 40 | 89.7 | 877 | 1297 | 1482 | 7937 (7937) | 120 / 120 | 0.068 |

Per recording, native-whisperx transcripts:

| Recording | Audio s | Segments | Pauses | Events | Chunks | Tokens (analyzed) | Updates at cadence 1 / 3 / 8 | Positions revisited | Slowest update ms | Parity, all cadences |
|---|---|---|---|---|---|---|---|---|---|---|
| F_0101_10y4m_1 | 150.1 | 14 | 35 | 38 | 14 | 108 (108) | 63 / 26 / 14 | 14 | 0.037 | match |
| F_0101_13y1m_1 | 127.7 | 15 | 11 | 17 | 15 | 182 (182) | 41 / 16 / 8 | 15 | 0.022 | match |
| M_0028_15y11m_1 | 129.9 | 24 | 44 | 44 | 24 | 217 (217) | 92 / 33 / 15 | 24 | 0.032 | match |
| M_0030_17y9m_1 | 127.8 | 25 | 38 | 38 | 25 | 292 (292) | 88 / 32 / 15 | 25 | 0.034 | match |
| M_0052_16y4m_1 | 120.7 | 24 | 20 | 24 | 24 | 251 (251) | 68 / 26 / 11 | 24 | 0.026 | match |
| M_0061_14y8m_1 | 133.7 | 31 | 46 | 53 | 31 | 126 (126) | 108 / 39 / 17 | 31 | 0.039 | match |
| M_0078_12y4m_1 | 136.5 | 17 | 24 | 27 | 17 | 153 (153) | 58 / 22 / 12 | 17 | 0.026 | match |
| M_0078_14y4m_1 | 136.9 | 8 | 39 | 48 | 8 | 59 (59) | 55 / 21 / 10 | 8 | 0.039 | match |
| M_0078_16y5m_1 | 154.6 | 26 | 1 | 4 | 26 | 231 (231) | 53 / 18 / 8 | 26 | 0.038 | match |
| M_0095_07y7m_1 | 122.3 | 11 | 38 | 41 | 11 | 173 (173) | 60 / 25 / 13 | 11 | 0.034 | match |
| M_0095_08y10m_1 | 131.3 | 33 | 41 | 42 | 33 | 206 (206) | 107 / 38 / 19 | 33 | 0.030 | match |
| M_0098_07y8m_1 | 130.6 | 0 | 47 | 47 | 0 | 0 (0) | 47 / 16 / 6 | 0 | 0.017 | match |
| M_0098_09y8m_1 | 143.4 | 16 | 36 | 37 | 16 | 176 (176) | 68 / 27 / 13 | 16 | 0.024 | match |
| M_0098_10y6m_1 | 121.9 | 18 | 40 | 43 | 18 | 197 (197) | 76 / 29 / 14 | 18 | 0.059 | match |
| M_0100_11y2m_1 | 155.7 | 28 | 36 | 40 | 28 | 170 (170) | 92 / 36 / 15 | 28 | 0.030 | match |
| M_0100_12y3m_1 | 124.0 | 17 | 36 | 38 | 17 | 141 (141) | 70 / 27 / 12 | 17 | 0.041 | match |
| M_0100_13y10m_1 | 133.4 | 22 | 28 | 30 | 22 | 232 (232) | 72 / 28 / 13 | 22 | 0.024 | match |
| M_0104_10y3m_1 | 205.1 | 16 | 81 | 83 | 16 | 197 (197) | 113 / 44 / 25 | 16 | 0.038 | match |
| M_0138_12y2m_1 | 121.9 | 0 | 38 | 38 | 0 | 0 (0) | 38 / 13 / 5 | 0 | 0.016 | match |
| M_0138_13y3m_1 | 132.4 | 24 | 35 | 45 | 24 | 322 (322) | 83 / 31 / 15 | 24 | 0.041 | match |
| M_0210_11y3m_1 | 128.9 | 17 | 42 | 44 | 17 | 127 (127) | 76 / 29 / 14 | 17 | 0.028 | match |
| M_0213_10y10m_1 | 125.7 | 10 | 52 | 57 | 10 | 137 (137) | 72 / 28 / 13 | 10 | 0.038 | match |
| M_0219_11y2m_1 | 164.4 | 15 | 38 | 41 | 15 | 229 (229) | 68 / 26 / 13 | 15 | 0.033 | match |
| M_0234_09y9m_1 | 120.9 | 17 | 41 | 48 | 17 | 198 (198) | 75 / 28 / 14 | 17 | 0.036 | match |
| M_0394_08y10m_1 | 124.3 | 23 | 30 | 32 | 23 | 185 (185) | 76 / 29 / 12 | 23 | 0.037 | match |
| M_0394_09y2m_1 | 121.6 | 16 | 1 | 3 | 16 | 197 (197) | 33 / 12 / 6 | 16 | 0.027 | match |
| M_0394_09y5m_1 | 131.3 | 18 | 0 | 1 | 18 | 189 (189) | 36 / 12 / 6 | 18 | 0.020 | match |
| M_0399_12y4m_1 | 153.3 | 25 | 0 | 8 | 25 | 316 (316) | 50 / 18 / 8 | 25 | 0.028 | match |
| M_0556_07y8m_1 | 122.3 | 11 | 12 | 19 | 11 | 115 (115) | 34 / 15 / 6 | 11 | 0.022 | match |
| M_0556_08y0m_1 | 120.9 | 11 | 40 | 46 | 11 | 139 (139) | 62 / 23 / 12 | 11 | 0.029 | match |
| F_0101_10y4m_1 (noise transcript) | 150.1 | 13 | 35 | 36 | 13 | 115 (115) | 61 / 24 / 12 | 13 | 0.024 | match |
| M_0030_17y9m_1 (noise transcript) | 127.8 | 23 | 38 | 38 | 23 | 289 (289) | 84 / 33 / 15 | 23 | 0.034 | match |
| M_0078_12y4m_1 (noise transcript) | 136.5 | 15 | 24 | 25 | 15 | 146 (146) | 54 / 21 / 10 | 15 | 0.025 | match |
| M_0095_07y7m_1 (noise transcript) | 122.3 | 10 | 38 | 42 | 10 | 175 (175) | 58 / 23 / 11 | 10 | 0.029 | match |
| M_0098_09y8m_1 (noise transcript) | 143.4 | 17 | 36 | 38 | 17 | 179 (179) | 70 / 25 / 12 | 17 | 0.026 | match |
| M_0100_12y3m_1 (noise transcript) | 124.0 | 15 | 36 | 37 | 15 | 138 (138) | 66 / 25 / 13 | 15 | 0.023 | match |
| M_0138_12y2m_1 (noise transcript) | 121.9 | 33 | 38 | 39 | 33 | 188 (188) | 104 / 38 / 18 | 33 | 0.027 | match |
| M_0213_10y10m_1 (noise transcript) | 125.7 | 13 | 52 | 54 | 13 | 420 (420) | 78 / 30 / 15 | 13 | 0.083 | match |
| M_0394_08y10m_1 (noise transcript) | 124.3 | 17 | 30 | 32 | 17 | 180 (180) | 64 / 25 / 11 | 17 | 0.032 | match |
| M_0399_12y4m_1 (noise transcript) | 153.3 | 28 | 0 | 9 | 28 | 324 (324) | 56 / 20 / 8 | 28 | 0.029 | match |
