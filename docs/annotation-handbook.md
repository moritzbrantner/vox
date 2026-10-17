# Annotation handbook

Version: 0.1 (2026-10-17) · Status: **provisional, no clinical review yet** · Tracking: #23, intended use #19

How people mark speech events in the annotation workbench so that a human reference is
independent of the app's analysis. Until a stuttering-specialist SLT has reviewed it, nothing
annotated with this handbook may be called clinically validated. Changing a rule means bumping
the version and noting it below.

## Labels

| Label                        | Mark when                                                                                                         | Span                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Sound/syllable repetition    | A sound or syllable is repeated before the word continues ("b-b-but", "ba-ba-baby").                              | First repeated part to the start of the completed word.              |
| Word repetition              | A whole one-syllable word is repeated ("I I I want").                                                             | First instance to the start of the instance that continues.          |
| Prolongation                 | A sound is audibly stretched ("ssssun").                                                                          | Start to end of the stretched sound.                                 |
| Block                        | Speech is stopped or audibly tense with no sound coming, at a point where the speaker is trying to speak.         | From where speech stops or tension begins to the release.            |
| Filler / typical disfluency  | Fillers ("um", "uh"), revisions and phrase repetitions that typical speakers also produce.                        | The filler or revised part.                                          |
| No speech                    | Nobody speaks (pauses, silence before or after speaking). Not a judgement about the speaker.                      | The silent stretch.                                                  |
| Overlapping speakers         | Someone else speaks at the same time, so the user's speech cannot be judged alone.                                | The overlap.                                                         |
| Unusable / uncertain audio   | Noise, dropouts, clipping or distance make a judgement impossible.                                                | The affected stretch.                                                |

The last three are span conditions, not disfluency events. They are never counted as events
(evidence export and reports exclude them).

## Certainty

- **Certain**: you would mark it the same way on another listening.
- **Possible**: you suspect an event but the recording alone cannot settle it. Use it for most
  silent blocks. Audio silence alone cannot establish what the speaker experienced. The speaker's
  own report, or separately consented clinical audiovisual evidence, can settle it. Video is never
  required for normal use.

## Spans and boundaries

- Times are seconds on the session clock, entered as numbers. Use the waveform and looping to
  find a boundary; then nudge it in 10 ms steps (Shift: 100 ms). Do not estimate a boundary from
  the transcript alone when audio is kept.
- Mark one span per event. Events may overlap (e.g. a prolongation inside a block, or a
  disfluency during "Overlapping speakers"); mark each one.
- A run of repetitions of the same unit is one event.
- When no audio was kept, use the transcript segment times as the span and mark the event
  "Possible" if its exact position within the segment is unknown. Never invent finer timing.
- Clip-level corpus labels (e.g. SEP-28k) stay clip-level: they say an event occurred somewhere in
  a clip, not when. They are never converted into exact spans.

## Independence

- For a reference, annotate in **Blind review**: it hides analysis results, dates and conditions,
  and the revision records that no analysis was shown (`basedOnRunId: null`).
- Each rater saves under their own role and name. Saving replaces only your own previous revision;
  another rater's draft stays untouched.
- Self-labels (role "self"), clinician labels and researcher labels stay distinguishable.

## Disagreements

Two raters annotate the same predeclared sessions independently. Disagreements are recorded, not
overwritten. An adjudicator resolves them in a separate revision that cites both rater revisions,
and agreement between the raters is reported as measured. Human agreement is not assumed.
(Tooling: #23.)

## Changelog

- 0.1 (2026-10-17): initial provisional handbook.
