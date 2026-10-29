# SEP-28k: audio prolongations as sustained sounds

Second #27 slice, after [sound repetitions](sep28k-sound-repetition.md). Machine-readable aggregates are in [`sep28k-prolongation.json`](sep28k-prolongation.json). No audio, clip ids or clip-level outputs are committed.

**Result:** the earlier audio prolongation rule flagged any speech-activity interval of at least 0.45 s that had at most one onset or a steady pitch. On podcast speech that matches most of the clip. The new rule looks for a *sustained sound*: at least 0.45 s in which the short-time spectrum barely changes. On the held-out speakers it doubles prolongation precision (0.162 → 0.313) and raises F1 from 0.261 to 0.364. It also halves the fluent false-positive rate, from 0.534 to 0.277. Macro F1 rises by +0.021 (95% interval +0.006 to +0.027). Under criteria 2–4 of STUTTER_BENCH.md the candidate is **promoted**, and the product now uses it (`ProlongationRule::SpectralStationarity`, analyzer version 3). The rule costs some recall: 0.664 → 0.433.

## Inputs

These are the same inputs as the sound-repetition run, with identical hashes:

| | |
| --- | --- |
| Labels | `labels-with-speaker.csv`, SHA-256 `a9eb53e2…0e81be`: the 28,017 SEP-28k rows that SEP-28k-E assigns a speaker |
| Speakers | `speakers.csv`, SHA-256 `ccae0b79…f30b34`: 497 clustered speakers. They come from clustering and were not manually verified |
| Audio | `~/.cache/sep28k`, 258 of 385 episodes, for personal non-commercial evaluation. Scored-audio SHA-256 `9f5ea5d1…fbdb44` |
| Detector | Commit `f2b2a86` (clean), source mode with audio-analysis `1733abb`, moenarch-foundation `9a162df`, nlp-stack `7da2af6` |
| Configuration | Clip audio only, no transcript; 2-of-3 vote threshold; partition seed `sep28k-partition-v1`. Training partition: 9,462 clips, 224 speakers. Held-out partition: 8,930 clips, 57 speakers |

Reproduce:

```bash
bun run benchmark:stutter:corpus --labels ~/.cache/sep28k/labels-with-speaker.csv \
  --clips ~/.cache/sep28k/clips --speakers ~/.cache/sep28k/speakers.csv \
  --candidate spectral-stationarity-prolongations --compare-on held-out --out report.json
```

Both sides are the product detector, so both withhold audio-only sound repetitions. The baseline uses `ProlongationRule::SpeechInterval` and the candidate uses `ProlongationRule::SpectralStationarity`. Abstentions the two sides share cost no coverage, so the macro-F1 rule applies.

## The rule

The audio is split into 10 ms frames. For each frame the rule takes the log10 power in 16 log-spaced bands from 100 Hz to 8 kHz, keeping 60 dB below the strongest band. A frame is *stationary* when two things hold:

- its band vector differs from the previous frame's by less than 2.0, measured as Euclidean distance in log10 units;
- its energy is above half the speech-activity threshold.

A run of stationary frames lasting at least 0.45 s is one prolongation, and the event spans that run. Ordinary speech changes sound every 0.1–0.3 s, so long runs are rare in fluent clips.

The rule was chosen on the training partition only. A coarse grid looked at:

- maximum change: 0.5–2.5;
- energy fraction: 0.5 or 1;
- whether a pitch was required;
- median smoothing and gap tolerance.

Only the minimum duration was swept finely. The simplest variant was best: no smoothing, no gaps, no pitch requirement. Training-partition F1 plateaus over a maximum change of 1.8–2.2 and a minimum duration of 0.42–0.46 s, and the chosen values sit in the middle of both plateaus. The longest-stationary-run score separates prolongation clips from other clips with a training AUC of 0.73.

## Development (training partition, 9,462 clips)

| | Speech interval (baseline) | Spectral stationarity |
| --- | --- | --- |
| Prolongation precision | 0.119 | 0.276 |
| Prolongation recall | 0.626 | 0.424 |
| Prolongation F1 | 0.200 | 0.335 |
| Fluent false-positive rate (any kind) | 0.572 | 0.330 |

The paired differences were:

- macro F1: +0.027 [+0.019, +0.032];
- fluent false-positive rate: −0.242 [−0.319, −0.159];
- prolongation F1: +0.135 [+0.096, +0.160].

The development run used the committed detector code before the test-only edits and the version bump. The held-out comparison was then run once at `f2b2a86`.

## Held-out comparison (8,930 clips, 57 speakers)

Paired speaker bootstrap: 1,000 shared resamples, seed `sep28k-paired-bootstrap-v1`. Prolongation prevalence is 0.119.

| | Speech interval (baseline) | Spectral stationarity |
| --- | --- | --- |
| Prolongation precision | 0.162 | 0.313 |
| Prolongation recall | 0.664 | 0.433 |
| Prolongation F1 | 0.261 | 0.364 |
| Macro F1 | 0.086 | 0.107 |
| Micro F1 | 0.150 | 0.144 |
| Fluent false-positive rate | 0.534 | 0.277 |

| Criterion | Result | Met |
| --- | --- | --- |
| 2. Macro F1 higher, interval excludes zero | +0.0206 [+0.0058, +0.0271] | yes |
| 3. Fluent false-positive rate does not regress | −0.2566 [−0.2702, −0.1092] | yes |
| 3. No kind's F1 or precision regresses | prolongation F1 +0.103 [+0.029, +0.136], precision +0.151 [+0.073, +0.165]; block exactly 0; word/sound repetition and filler are never predicted by either side | yes |
| 4. Comparable inputs | identical label, mapping and audio hashes, vote threshold | yes |

**Promoted.** Micro F1 changes by −0.006 [−0.025, +0.007], which is within its uncertainty; the lower prolongation recall offsets the higher precision there. The intervals resample speakers, so they include speaker-to-speaker variation. Speakers are not reported individually.

**Robustness challenge set** (1,030 clips flagged for poor audio, hard-to-understand speech or music; reported only, not used for the decision):

- fluent false-positive rate: 0.468 → 0.217;
- prolongation F1: 0.201 → 0.325.

## What changed in the product

- **Audio prolongations.** Prolongations found in the audio are now sustained-sound stretches, and the event covers only the stretch, not the whole speech-activity interval. Each event cites the speech-activity intervals and onsets it overlaps. Its explanation states the measured spectral change and says that audio alone cannot tell a prolonged sound from a sung or deliberately held one.
- **Transcript prolongations.** Prolongations from the transcript (stretched letters) are unchanged and still fuse with an overlapping acoustic candidate.
- **Shared fallback.** The browser and compute-server fallback keeps its own reduced acoustic heuristics.

## Limitations

- **Labels.** SEP-28k labels are clip-level votes by three non-clinician annotators, not a clinical reference. Event timing is not evaluated.
- **Sustained sounds that are not prolongations.** Singing, sustained vowels, emphasis and steady background tones also produce stationary stretches. Audio alone cannot separate them from prolongations, and the rule makes no exception for them. Music clips are excluded from the main set and appear only in the challenge set.
- **Calibration.** Confidence values (0.60, plus 0.15 at 0.7 s or longer, plus 0.10 with transcript support) are not calibrated probabilities.
- **Coverage.** 127 of 385 episodes were unavailable, and SEP-28k-E speakers come from clustering.
- **Still open in #27:** blocks (audio-only block precision is about equal to prevalence), word repetitions (which need transcripts, #26), and calibration.
