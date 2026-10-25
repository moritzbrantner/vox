# SEP-28k: first baseline and audio-only sound repetitions

First real run of the corpus benchmark (#68) and the first candidate comparison (#27, sound repetition; #76 paired comparison). Machine-readable aggregates: [`sep28k-sound-repetition.json`](sep28k-sound-repetition.json). No audio, clip ids or clip-level outputs are committed.

**Result:** the existing detector's audio-only sound repetitions are at chance level (held-out precision 0.092 against a prevalence of 0.098). Withholding them as "insufficient evidence" lowers the held-out fluent false-positive rate from 0.911 to 0.534 (paired difference −0.377, 95% interval −0.438 to −0.316) without changing any other kind. Under the owner's rule for abstaining candidates (STUTTER_BENCH.md, criterion 6) it is **promoted**; the product now withholds them (`EvidencePolicy::WithholdAudioOnlySoundRepetitions`, analyzer version 2). Coverage cost: sound-repetition recall 0.545 → 0, with a decision on 41.9% of held-out clips.

## Inputs

| | |
| --- | --- |
| Labels | SEP-28k `SEP-28k_labels.csv` (28,177 rows), restricted to the 28,017 rows SEP-28k-E assigns a speaker (`labels-with-speaker.csv`, SHA-256 `a9eb53e2…0e81be`). The 160 dropped rows are 4 StutteringIsCool episodes without a speaker cluster |
| Speakers | SEP-28k-E `SEP-28k-Extended_clips.csv` → `speakers.csv` (SHA-256 `ccae0b79…f30b34`), 497 speakers. They come from clustering, not manual verification, so "speaker-exclusive" is only as good as that clustering |
| Audio | Downloaded 2026-10-25 with `scripts/sep28k-download.py` into `~/.cache/sep28k` for personal, non-commercial evaluation. 258 of 385 episodes are available; 127 URLs are dead. Scored-audio SHA-256 `9f5ea5d1…fbdb44` |
| Detector | Commit `12cfa1d` (clean), source mode with audio-analysis `1733abb`, moenarch-foundation `9a162df`, nlp-stack `7da2af6` (full revision record in the JSON) |
| Configuration | Clip audio only, no transcript; 2-of-3 vote threshold; partition seed `sep28k-partition-v1` (20% of speakers held out) |

Reproduce:

```bash
python3 -I scripts/sep28k-download.py --dir ~/.cache/sep28k            # plus the CSVs, see the script
python3 -I scripts/sep28k-download.py --dir ~/.cache/sep28k --speakers
bash scripts/source-deps activate
bun run benchmark:stutter:corpus --labels ~/.cache/sep28k/labels-with-speaker.csv \
  --clips ~/.cache/sep28k/clips --speakers ~/.cache/sep28k/speakers.csv \
  --candidate withhold-audio-only-sound-repetitions --compare-on held-out --out report.json
```

## Counts

| | Rows |
| --- | --- |
| Label rows | 28,017 |
| Excluded (any flag) | 3,468: no affirmative label 1,731, difficult to understand 1,035, poor audio 580, no speech 306, music 294, unsure 23 (a row can have several) |
| Missing audio (dead episodes) | 6,155 |
| Unreadable (truncated) | 2 |
| **Scored** | **18,392** (7,981 fluent), 281 speakers |
| Training partition | 9,462 clips, 224 speakers |
| Held-out partition | 8,930 clips, 57 speakers (hosts are frequent speakers, so 20% of speakers hold 49% of clips) |
| Robustness challenge set | 1,030 scored of 1,448 (418 without audio) |

## Existing detector (#68 baseline), held-out

Speaker bootstrap 95% intervals in brackets. Prevalence is reference positives / scored clips.

| Kind | Prevalence | Precision | Recall | F1 |
| --- | --- | --- | --- | --- |
| Word repetition | 0.129 | – (never predicted) | 0 | 0 |
| Sound repetition | 0.098 | 0.092 | 0.545 | 0.158 [0.095, 0.165] |
| Prolongation | 0.119 | 0.162 | 0.664 | 0.261 [0.197, 0.281] |
| Block | 0.134 | 0.139 | 0.217 | 0.170 [0.113, 0.175] |
| Filler | 0.271 | – (never predicted) | 0 | 0 |

Macro F1 0.118 [0.089, 0.120], micro F1 0.160 [0.120, 0.163], fluent false-positive rate 0.911 [0.868, 0.916]. Over all scored clips the picture is the same (macro F1 0.111, fluent false-positive rate 0.910). Word repetitions and fillers need a transcript and cannot fire on audio alone. Every audio-only kind has precision close to its prevalence: the acoustic rules flag most clips, fluent or not.

## Candidate: withhold audio-only sound repetitions

Development (training partition, 9,462 clips): fluent false-positive rate 0.908 → 0.572, paired difference −0.336 [−0.439, −0.234]; no other kind changed; recall cost 0.537 → 0, coverage 0.467. The candidate has no tunable parameter, so the training run only confirmed it met the rule; the held-out comparison was then run once.

Held-out, paired (1000 shared speaker resamples, seed `sep28k-paired-bootstrap-v1`):

| Criterion (abstention rule) | Result | Met |
| --- | --- | --- |
| Fluent false-positive rate drops, interval excludes zero | 0.911 → 0.534, −0.377 [−0.438, −0.316] | yes |
| No other kind's F1 or precision regresses | block, prolongation: difference exactly 0 [0, 0]; word repetition, filler: never predicted by either | yes |
| Coverage cost reported | sound repetition recall 0.545 → 0; 5,188 clips abstained, coverage 0.419 | reported |
| Comparable inputs | identical label, mapping and audio hashes, vote threshold | yes |

**Promoted.** For information: macro F1 falls from 0.118 to 0.086 (−0.032 [−0.033, −0.020]) because abstentions count as misses; micro F1 −0.010 [−0.020, +0.010]. On the challenge set (reported only, not used for the decision) the fluent false-positive rate falls from 0.924 to 0.468 and sound-repetition recall from 0.564 to 0.

## What changed in the product

Audio-only sound repetitions are no longer events. They appear in the analysis details as "possible sound repetition – not enough evidence (audio only)", linked to the onset observations they rest on, and are left out of event counts, rates, severity and trends. Sound repetitions with transcript evidence are unchanged. The shared fallback (browser, compute server) withholds its audio-only sound repetitions the same way.

## Limitations

- SEP-28k labels are clip-level votes by three non-clinician annotators, not a clinical reference. No event timing is evaluated.
- The detector sees clip audio only; transcript-based detections (word repetitions, fillers, transcript-supported sound repetitions) are not evaluated here.
- 127 of 385 episodes (6,155 labelled rows) were unavailable; the scored set is not the full corpus.
- SEP-28k-E speakers are clustered, not verified. Intervals cover speaker sampling, not label noise.
- This run says the audio-only rule carries no information on podcast speech. It does not show that sound repetitions cannot be detected from audio; a better acoustic or transcript-assisted detector remains open in #27.
