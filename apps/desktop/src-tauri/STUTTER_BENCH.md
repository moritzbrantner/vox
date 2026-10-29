# Stuttering benchmark boundary

The stuttering benchmark is product evaluation code and therefore lives at the desktop Rust product boundary next to the detector it evaluates. `speech_analysis::StutterKind` is the canonical event taxonomy; the benchmark must reuse it rather than maintain a second TypeScript copy.

## Initial corpus contract

SEP-28k is the primary baseline. Its clip-level majority-vote labels map to the existing product event kinds:

- `WordRep` → `WordRepetition`
- `SoundRep` → `SoundRepetition`
- `Prolongation` → `Prolongation`
- `Block` → `Block`
- `Interjection` → `Filler`

The default normalizer requires a 2-of-3 vote. Uncertain, poor-quality, difficult-to-understand, music, and no-speech clips are excluded from evaluation. The real `NoStutteredWords` field is retained for auditing rather than silently discarded.

SEP-28k is clip-level multi-label data, so this slice evaluates clip classification. It does not invent event timestamps. Timestamp/onset error belongs to a corpus or curated fixture that actually provides temporal labels.

Speaker-safe evaluation fails closed. The original SEP-28k table is not treated as a trustworthy speaker-identity source; an explicit verified speaker mapping such as SEP-28k-E is required before train/evaluation partitioning can be called speaker-exclusive.

## Metrics

The harness reports per-kind precision/recall/F1, micro precision/recall/F1, macro F1, and false-positive rate on fluent clips. The fluent false-positive denominator is the number of fluent reference clips, not the total corpus size.

Calibration uses Brier score only when a predictor supplies a complete probability vector for every evaluated clip and every canonical event kind. Partial vectors are rejected so candidates cannot obtain incomparable calibration scores by omitting difficult classes.

The existing deterministic detector is the first baseline adapter. Substantially smarter classifiers should be compared against that baseline only after this benchmark contract and the runtime-evidence slice are integrated.

## Execution boundary

Normal installs and hosted CI do not download corpus audio. Run the semantic harness in the verified source-development workspace:

```bash
bash scripts/source-deps activate
bun run benchmark:stutter
```

The hosted `Stutter benchmark contract` only checks formatting, ownership, and the benchmark entry point because the Rust application intentionally depends on the local-only capability graph. `coding-tooling pr integrate 3` remains the authoritative source-aware merge gate.

## Corpus evaluation

`bun run benchmark:stutter` runs the fast contract tests, including a synthetic end-to-end corpus fixture. Real evaluation is a separate command that reads corpus files you already have locally:

```bash
bash scripts/source-deps activate
bun run benchmark:stutter:corpus \
  --labels /path/to/SEP-28k_labels.csv \
  --clips /path/to/clips \
  [--speakers /path/to/verified-speakers.csv] \
  [--vote-threshold 2] [--limit N] \
  [--candidate withhold-audio-only-sound-repetitions [--compare-on train|held-out]] \
  [--out report.json]
```

`scripts/sep28k-download.py` downloads the audio and cuts the clips into a directory outside the repository (the dataset's own scripts no longer run on current numpy); with `--speakers` it turns SEP-28k-E's clip table into `speakers.csv` and `labels-with-speaker.csv`. The first real run is in [`docs/benchmarks/sep28k-sound-repetition.md`](../../../docs/benchmarks/sep28k-sound-repetition.md).

- `--clips` uses the layout written by the dataset's download script: `<clips>/<Show>/<EpId>/<Show>_<EpId>_<ClipId>.wav`.
- `--speakers` is a verified mapping with the columns `clipId,speakerId`, where clip ids are `Show:EpId:ClipId` (for example from SEP-28k-E). The held-out metrics are speaker-exclusive only when every scored clip has a verified speaker; otherwise the report says why they are not.
- Every required SEP-28k column must be present and every vote cell must be an integer 0–3; otherwise the run fails rather than reading damaged labels as negatives. A clip counts as fluent only with an affirmative `NoStutteredWords` vote; clips with neither a stuttering kind nor that vote are excluded as `noAffirmativeLabel`. Exclusions are counted per flag (a clip can have several) and as rows. Empty `Show`/`EpId`/`ClipId` values and a missing clips directory fail the run. Clips whose decoded duration differs from the labelled `Start`–`Stop` interval by more than 5% (truncated extractions), or that the detector rejects as input (shorter than 250 ms, non-finite samples), count as unreadable.
- Every row, including excluded rows and rows whose audio is missing, needs numeric `Start`/`Stop` offsets with `Stop > Start`; repeated header names fail the run. With fewer than two verified speakers there is no held-out set; otherwise the lowest-ranked `ceil(20%)` of speakers by a seeded hash are held out (at least one, never all).
- The report records the detector revision (repository commit, whether there were uncommitted or untracked (not ignored) files other than the source-mode `Cargo.lock`, and the SHA-256 of the source pins and of the effective `Cargo.lock`, and the HEAD and local-change state of each sibling checkout compiled in source mode), the label-file, mapping and scored-audio SHA-256 (over each scored clip's id and WAV file hash), the detector configuration, row, processed-row and exclusion counts, missing and unreadable clips, per-kind prevalence, metrics over all scored clips and the held-out partition, and its limitations. Duplicate clip ids or mapping entries fail the run.
- The detector receives clip audio only. SEP-28k has no transcripts, so transcript-based detections cannot fire in this configuration; a transcript-assisted configuration is a separate experiment.
- Nothing is downloaded. Corpus audio and reports derived from it are never committed.

### Uncertainty, error review and robustness

- `allScoredIntervals` and `heldOutIntervals` are 95% percentile bootstrap intervals (1000 resamples, fixed seed `sep28k-bootstrap-v1`) for micro F1, macro F1, the fluent false-positive rate and per-kind F1. Speakers are resampled with replacement when every clip has a verified speaker (`resamplingUnit: "speaker"`), otherwise clips (`"clip"`). Draws in which a rate is undefined (no fluent clip, or no reference positive for a kind) are skipped for that metric, which is null if no draw defined it. With fewer than two resampling units (e.g. a held-out set of one speaker) no interval is reported. The cost grows with resamples × scored clips, which is acceptable for this explicit benchmark tier.
- `errorReview` lists up to 10 false-positive and 10 false-negative clip ids per kind, chosen by a seeded hash. With a held-out partition it samples training clips only (`errorReviewScope: "train"`), so held-out errors are never reviewed during development. It holds ids only, never media, for manual listening against your own local copy.
- `challenge` (audio hashed separately in `challengeAudioSha256`) scores the robustness challenge set: clips excluded only for `poorAudioQuality`, `difficultToUnderstand` or `music`. It is reported apart from the main results and never used to choose between candidates.

### Candidate promotion criteria

Fixed before any candidate is compared with the existing detector:

1. **Protected held-out set.** Promotion decisions use only the speaker-exclusive held-out partition (seed `sep28k-partition-v1`, 20% of verified speakers). Candidates are developed and tuned on the training partition only; the held-out results of a candidate version are looked at once, recorded with its `detectorRevision`, and not used to tune that version further.
2. **Improvement must exceed uncertainty.** A candidate replaces the baseline only if its held-out macro F1 is higher and the paired bootstrap 95% interval of the difference (same resamples for both detectors) excludes zero.
3. **No hidden regressions.** No per-kind F1 and no fluent false-positive rate may get worse by more than the paired interval allows, and the challenge-set results are reported next to the main ones.
4. **Comparable inputs.** Both runs use identical label, mapping and scored-audio hashes and the same vote threshold.
5. **Calibration and abstention.** For candidates that output probabilities, the Brier rule above applies. For candidates that can abstain, coverage is reported, and abstained clips count as misses when comparing F1.
6. **Abstaining candidates** (owner decision for #27, 2026-10-25). A candidate that abstains instead of detecting is promoted when its held-out fluent false-positive rate drops and the paired 95% interval of that difference excludes zero, and no other kind's precision or F1 regresses beyond its paired interval. The recall it gives up on the abstained kind is accepted and reported as a coverage cost. Criterion 2 does not apply to it.

### Paired comparison and abstention

`--candidate` scores a candidate next to the existing detector on the same clips. `--compare-on train` (default) compares them on the training partition while the candidate is developed; `--compare-on held-out` is run once per candidate version (criterion 1). Both need a speaker-exclusive partition. The report's `candidate.paired` holds both detectors' metrics, the candidate − baseline differences of macro and micro F1, the fluent false-positive rate and per-kind F1 and precision with paired percentile bootstrap 95% intervals (1000 shared resamples of speakers, seed `sep28k-paired-bootstrap-v1`; precision only over draws where both detectors predict the kind), the coverage cost of each abstained kind, and `promotion`: the applicable rule (`abstention` or `macroF1`), each criterion with whether it is met, and the decision. A comparison of runs whose label, mapping or scored-audio hashes, vote threshold or scored clip set differ is refused.

An abstention ("insufficient evidence") is neither a detection nor a negative: on a reference positive it is a false negative, on a reference negative it is neither a true negative nor a false positive, and it never flags a fluent clip. Each kind reports `abstained` and `coverage` (share of clips with a decision).

An abstention is a coverage cost only when the candidate abstains on a kind more often than the baseline; abstentions both detectors share (the product withholds audio-only sound repetitions in both) leave the candidate under the macro-F1 rule.

Candidates (both promoted; reports in `docs/benchmarks/`):

- `withhold-audio-only-sound-repetitions` is the product's `EvidencePolicy::WithholdAudioOnlySoundRepetitions`. Withholding only partitions the fused events, so one analysis gives both detectors: the detector before withholding (`ReportAll`) predicts every reported or withheld kind, the candidate predicts the reported kinds and abstains on the withheld ones.
- `spectral-stationarity-prolongations` compares the product detector with `ProlongationRule::SpectralStationarity` against the same detector with the earlier `ProlongationRule::SpeechInterval`. Each clip is analyzed twice; each side predicts its reported kinds and abstains on its withheld ones.

## Dataset card: SEP-28k

| Field | Value |
| --- | --- |
| Source | [apple/ml-stuttering-events-dataset](https://github.com/apple/ml-stuttering-events-dataset) ([paper](https://arxiv.org/abs/2102.12394)) |
| Annotation license | CC BY-NC 4.0 (per the dataset owner) |
| Audio rights | Podcast audio copyright stays with its owners; access to clips is not a licence for redistribution, commercial use or every training use |
| Permitted use here | Personal, non-commercial research evaluation of this project's detector. Any commercial, redistribution or training use needs its own rights review first |
| Labels | Clip-level (3 s) votes by three trained non-clinician annotators; a research annotation, not a clinician-adjudicated reference |
| Language and context | English podcast speech |
| Speaker identity | Not reliable in the original table; use a verified mapping such as SEP-28k-E for speaker-exclusive results ([speaker partitioning study](https://arxiv.org/abs/2206.03400)) |
| Limitations | No event timing; noisy and ambiguous clips are excluded by flag and counted in the report |

Runtime profiling is separate. `runtime-profiler` owns process/runtime evidence; this benchmark owns correctness semantics.

## Evidence contract and cross-runtime capabilities

Vox analyzes a session in one of three places. They do not produce the same outputs, and a report says which one produced it.

| Producer | Where it runs | Algorithm |
| --- | --- | --- |
| `desktopNative` | Tauri desktop app | `speech_pipeline::analyze_speech_session`: typed observations and evidence-carrying events |
| `computeServer` | `apps/server` | shared `fallbackAnalyze` (TypeScript); capture metrics from the native worker |
| `onDevice` | browser or mobile without a server | shared `fallbackAnalyze`; capture metrics from the audio-analysis WASM kernel when it loads |

Every report from these producers carries `capabilities`. Reports saved before it existed have none; their capabilities are unknown, not full.

### Capability matrix

`supported`: produced by the full method. `reduced`: produced by a simpler method, not comparable with a supported output. `unsupported`: never produced; its absence says nothing about the speech.

| Output | desktopNative | computeServer / onDevice |
| --- | --- | --- |
| `wordRepetition` | supported (a run of 2+ words is one event) | reduced (adjacent pairs; a run of three is two overlapping events) |
| `soundRepetition` (fragment + word, hyphenated sounds) | supported | unsupported |
| `prolongation` (stretched letters) | supported | supported |
| `filler` | supported | supported |
| `pauseBlock` (captured pause ≥ 0.75 s) | supported | supported |
| `acousticEvents` (blocks, prolongations, repeated bursts from audio) | supported (audio-analysis VAD, onsets, pitch, spectrum) | reduced (own energy VAD and onset heuristics) |
| `fusion` (transcript + acoustic candidates) | supported | reduced |
| `eventEvidence` (event ids, cited observations, explanation) | supported | unsupported |
| `missingObservations` | supported | unsupported |
| `captureMetrics` | supported | supported |
| `speakerAttribution` | unsupported | unsupported |

The rows live in `packages/shared/src/analysisCapabilities.ts` (`ANALYSIS_CAPABILITIES`) and, for the native analyzer, in `speech_pipeline::native_capabilities`; both are checked against `packages/shared/fixtures/analysis-parity.json`.

Confidences are calibrated per analyzer (a word repetition is 0.86 natively, 0.78 in the fallback) and are never compared across producers. Known input differences: the fallback rejects audio shorter than 250 ms, where native analysis analyzes the transcript and reports the acoustic channel as `audioTooShortForAnalysis`; native normalization keeps inner and trailing hyphens of a token (`b-`), the fallback strips them.

### Cross-runtime parity

Only outputs both producers fully support are expected to agree on the same input: currently `prolongation`, `filler` and `pauseBlock` (`equivalentOutputs`). On every case of `analysis-parity.json`, the shared fallback must reproduce the native events' kind, text, start and end. The native test `cross_runtime_parity_fixture_matches_native_analysis` writes and checks the expected events; `packages/shared/src/analysisCapabilities.test.ts` compares the fallback with them.

Reduced and unsupported outputs are evaluated on their own terms instead: every native word repetition must overlap a fallback word repetition, and the fallback never reports a sound repetition. Acoustic outputs differ by method and are not compared across runtimes.

**Numerical tolerance.** Comparisons accept an absolute or relative difference of `1e-9` (`speech_reference::ABSOLUTE_TOLERANCE` / `RELATIVE_TOLERANCE`, `TOLERANCE` in the shared test). Transcript and pause times are plain IEEE-754 double arithmetic in both languages and agree well inside it. Audio-derived numbers go through resampling, FFT and autocorrelation in the audio-analysis crates, so another platform, compiler or SIMD path may round them differently; if that exceeds the tolerance, record the platform and the difference rather than widening the tolerance silently.

### Native evidence

Each native event carries `evidence`:

- `id`: `<kind>:<first observation id>`, e.g. `wordRepetition:transcript:1:0`, `block:pause:2`, `prolongation:acoustic:speech:0`, `hyphenatedSoundRepetition:transcript:0:0`. A second acoustic prolongation in the same speech-activity interval gets a `:1`, `:2`… suffix; one outside every interval cites `audio:0`. Stable for the same input.
- Acoustic prolongations are spectrally stationary stretches: at least 0.45 s in which the 16-band log spectrum (100 Hz–8 kHz, 60 dB range) changes by less than 2.0 log10 units per 10 ms frame and the energy stays above half the speech-activity threshold. The event spans the stretch, not the whole speech-activity interval. Audio alone cannot tell a prolonged sound from a sung, sustained or emphasised one, and the explanation says so. The shared fallback keeps its own reduced speech-interval heuristic (`acousticEvents` is `reduced` there).
- `supporting`: the observations the decision rests on. A fused event lists its transcript observations, then those of the acoustic candidate it was fused with.
- `conflicting` (when present): observations that speak against the event without overturning it. Currently: speech activity of at least 0.1 s inside a reported block.
- `explanation`: the decision in words.

`AnalysisReport.observations` lists every cited observation and one explicit observation for each missing channel or uncovered range:

| Observation id | Meaning |
| --- | --- |
| `transcript:<segment>:<token>` | final transcript token; times interpolated within the segment (`interpolatedWithinSegment`) until alignment exists |
| `pause:<i>` | captured pause |
| `audio:0` | the supplied audio |
| `acoustic:speech:<i>` | speech-activity interval in the analyzed window, always `attribution: unattributed`: someone spoke, not who |
| `acoustic:onset:<i>` | acoustic onset |
| `missing:acoustic` | `noAudio`, or `audioTooShortForAnalysis` (under 250 ms) |
| `missing:acoustic:afterWindow` | `beyondAnalyzedAudioWindow`: the recording continues after the first 90 s that acoustic analysis reads |
| `missing:transcript` | `noFinalTranscript` |
| `missing:speaker` | `noSpeakerAttribution`: who spoke, and whether voices overlapped, is unknown |

`AnalysisReport.insufficientEvidence` lists detections withheld for insufficient evidence (`reason: "audioOnly"`): sound repetitions that rest on repeated acoustic onset bursts alone. On SEP-28k such bursts fire on fluent speech about as often as on sound repetitions, so they are not events: counts, rates, severity, chunks and trends leave them out. Each keeps its candidate with the evidence it cites, and the analysis details show it as "possible sound repetition – not enough evidence (audio only)". A sound repetition with transcript support (hyphenated sounds, fragment + word, or fused with an acoustic candidate) is still an event. The shared fallback withholds its audio-only sound repetitions the same way (without `evidence`; the candidate keeps its `acousticEvidence`).

A missing observation is never a negative: no acoustic event without analyzed audio does not mean fluent speech, and no conflict without audio is not a confirmation. Speaker identity is not inferred from voice activity or from a session-wide "only I speak" declaration.

### Semantic regression check

`fixtures/speech/legacy-reference.json` holds the reports of the batch detector before its stages moved onto the evidence path, for silence, repetitions, overlapping channels, incomplete input, partial and final transcripts, and invalid numeric or timing data. `speech_reference::evidence_path_reproduces_the_legacy_reference` requires the current analysis to reproduce them within the tolerance, ignoring only what the evidence path adds (`observations`, `capabilities`, event `evidence`). Regenerate it with `VOX_UPDATE_SPEECH_REFERENCE=1 cargo test speech_reference` only for an intentional change, together with corpus results and a `SPEECH_ANALYSIS_VERSION` bump.
