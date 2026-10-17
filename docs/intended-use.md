# Intended use and outcomes — decision record

Version: 0.1 (2026-10-02) · Status: **provisional, no clinical review yet** · Tracking: #19, roadmap #18

This record states what the product is for, what counts as benefit and which decisions are still open.
It contains no personal health information. Changing a decision means bumping the version and noting it below.

## Decided

| Decision                    | Value                                                                                                                                                                                                                                                                       | Source                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Speech-analysis languages   | English (`en`) first; German (`de`) and Spanish (`es`) later, order between them open. The first English workflow does not wait for the others. Explicit other/`unknown` spoken languages stay recordable without claiming support.                                          | Owner, 2026-09-29      |
| Spoken vs interface language | Spoken language is recorded per session/observation and never derived from the interface language (`resolveSpokenLanguage`).                                                                                                                                              | This record            |
| Provisional population      | Adults with developmental stuttering. Newly acquired (e.g. neurogenic) stuttering and children need separate assessment pathways and are out of scope for self-help features.                                                                                               | This record, provisional |
| No combined score           | Outcomes are reported per measure. No universal severity score.                                                                                                                                                                                                             | This record            |

## Open decisions

| Decision                                                   | Owner                       | Blocks                                       |
| ---------------------------------------------------------- | --------------------------- | -------------------------------------------- |
| First everyday speaking situation                          | Product owner               | #35, #37 goal templates                      |
| Personal pilot vs broader distribution                     | Product owner               | #44, #46                                     |
| Clinical reviewer (stuttering-specialist SLT)              | Product owner — **unassigned** | Any treatment-oriented content (#34), stop/referral rules sign-off |
| Risk owner for discomfort/stop/referral rules              | **Unassigned**              | #29, #32, #44                                |
| Validated questionnaires (licence, age, language)          | Clinical reviewer           | Use of any instrument beyond app self-ratings |
| German vs Spanish order                                    | Product owner               | #28 rollout                                  |

Unresolved clinical approval means: no treatment claims, no exercise prescription and no clinician-reviewed label on any content.

## Language capability matrix

Source: `LANGUAGE_CAPABILITIES` in `packages/shared/src/outcomes.ts` (shown in the app under "Compare two sessions"). A capability is *evaluated* only with evaluation evidence for that language.

| Language | Recording and review | Transcription | Event detection | Reviewed practice |
| -------- | -------------------- | ------------- | --------------- | ----------------- |
| English (`en`) | Available | Runs, not evaluated | Runs, not evaluated | Not available |
| German (`de`) | Available | Runs, not evaluated | Runs, not evaluated (English rules) | Not available |
| Spanish (`es`) | Available | Runs, not evaluated (Whisper only) | Runs, not evaluated | Not available |
| Other / unknown | Available | Runs, not evaluated | Not available | Not available |

## Product categories

Kept separate in UI, data and claims:

1. **Tracking** — recording and reviewing one's own speech.
2. **User-controlled assistance** — aids the user starts and stops (e.g. auditory feedback, pacing).
3. **Clinician-guided practice** — content reviewed by a named clinician (none yet).
4. **Investigational treatment claims** — only after a study (#45) and regulatory review (#46). None today.

## Benefit horizons

- **During assistance** — while an aid is active.
- **Transfer** — on an untrained, real-world task.
- **Maintenance** — after assistance or practice has been reduced, when the user wants that.

## Outcome set

Schema: `packages/shared/src/outcomes.ts` (`OutcomeObservation`). Every observation records measure, source
(`observed` / `selfReported` / `clinicianRated`), assistance condition (`unassisted` / `assisted` + aid),
benefit horizon, task (kind, trained or not), spoken language and sample duration.

- User-selected communication goal
- Speaking effort / discomfort (lower is better)
- Naturalness
- Participation / avoidance
- Event burden and event duration (lower is better)

Percent syllables stuttered is not computed until there is a valid syllable denominator and a separate human
reference (#23, #24). App self-ratings are not validated instruments; validated instruments are referenced by
id only after licensing review and never reproduced here. German and Spanish adaptations are reviewed
independently when their rollout starts.

Reports (`summarizeOutcomes`) compare only within the same measure, source, horizon, condition (aid and
settings), spoken language, task (kind and trained/untrained) and scale, order by time instant, show worse and unchanged results as such, and always include: "This app has not demonstrated a
cure or treatment efficacy."

## Evidence matrix

| Intervention                  | Population | Evidence | Benefits | Limitations / burdens | Reviewer | Permitted claim                  | Next experiment |
| ----------------------------- | ---------- | -------- | -------- | --------------------- | -------- | -------------------------------- | --------------- |
| Altered auditory feedback     | Adults     | To review | —       | —                     | —        | "Experimental practice aid"      | #33 within-person comparison |
| Pacing / rhythm cues          | Adults     | To review | —       | —                     | —        | "Experimental practice aid"      | #32, #33        |
| Self-tracking                 | Adults     | —        | —        | —                     | —        | "Helps you review your speech"   | #44 feasibility |

This app has not demonstrated a cure or treatment efficacy.

## Safety: stop and referral

- Stop any exercise or feedback that causes discomfort, distress or makes speaking harder; Stop must be immediate (#29).
- Signpost assessment by a stuttering-specialist speech-language therapist; recommend prompt assessment for
  recently started stuttering or for children.
- Do not attribute stuttering to anxiety or prescribe generic breathing cures.
- Risk owner: **unassigned** (open decision).

## Release gates

First human pilot (#44) and public release (#46) are separate decisions:

- **Pilot**: named clinical/research lead, ethics/data-protection review as required, privacy boundary (#20), stop/referral rules signed off.
- **Public release**: intended-purpose and regulatory assessment (#46), claims limited to what evidence supports.

## Changelog

- 0.1 (2026-10-02): initial provisional record.
