# Annotation handbook

Version: 0.3 (2026-10-25) · Status: **provisional, no clinical review yet** · Tracking: #23, open validation work #131, intended use #19

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

## Disagreements and agreement

1. **Declare first.** In "Two-rater validation", name the two raters for a session before either
   of them annotates it. A rater who already annotated that session cannot be declared.
2. **Rate independently.** Each rater annotates in Blind review under their declared role and
   name, then saves with "Save as reference". Only a rater's current reference revision counts.
3. **Measure.** The panel compares the two references. Each span is paired with at most one span
   of the other rater (spans that overlap or start within 250 ms; full agreements first, then
   same-label pairs, then the largest overlap).
   - A pair **agrees** when the label matches, the certainty matches, and both onset and offset
     differ by at most 250 ms. This rule is **provisional and not empirically validated**
     (validation on an approved example set: #131).
   - **Event agreement** = 2 × agreed disfluency events / all disfluency events of both raters.
     Span conditions (no speech, overlap, unusable) can agree but are not counted as events.
   - **Time agreement** is Cohen's kappa over 10 ms frames for "some disfluency is marked here".
   - Every **disagreement** is listed: a pair that differs in label, certainty or boundaries,
     a span only rater 1 marked, a span only rater 2 marked.
4. **Accept agreements automatically.** Every agreeing pair enters the human reference with its
   label and certainty and the **mean** of the two raters' onsets and of their offsets. Nobody
   decides these again.
5. **Adjudicate only what is referred.** Every disagreement is referred to the adjudicator, who
   decides each one separately (see below) and saves. Saving is also needed when nothing is
   referred: it confirms the automatically accepted reference.

## Adjudication

- **Who.** A named person who is neither rater, in the Clinician role. They enter a short
  statement of their qualification (for example "SLT, stuttering specialist"), which is stored
  with their decisions. The app records the statement; it does not verify credentials.
- **Per referred item**, one of:
  - **Rater 1's span** or **Rater 2's span** (only offered when that rater marked one);
  - **Adjusted span**: the adjudicator enters label, start, end and certainty;
  - **No event**: nothing enters the reference;
  - **Uncertain**: the evidence does not settle it. The span is kept as "Possible" from the
    earlier onset to the later offset of the raters' spans. For a label disagreement both
    candidate labels are kept (rater 1's first); the label is not forced.
- **What is kept.** Both raters' revisions and the list of disagreements stay unchanged. The
  adjudication is a separate revision attributed to the adjudicator. It cites both rating
  revisions, the agreement rule, the qualification statement and each item's decision. Its
  events (accepted agreements plus decisions) are the session's **human reference**.
- **Revising.** If a rater saves a new reference afterwards, the panel shows that the
  adjudication needs revising; the earlier adjudication stays in the history. An adjudication is
  revised only through the validation panel, never by a plain annotation.

Raters on other devices receive the session through **Exchange annotations** (a file needing clinician-sharing consent; permitted use: review only, no redistribution, no model training) and send their revisions back the same way.

Agreement is reported as measured. It is never assumed, and synthetic examples are never
presented as clinical validation.

## Changelog

- 0.1 (2026-10-17): initial provisional handbook.
- 0.2 (2026-10-17): two-rater declaration, agreement measures and adjudication.
- 0.3 (2026-10-25): selective adjudication. Agreement needs matching label and certainty and
  onset and offset within 250 ms (provisional); agreements are accepted automatically at the mean
  boundaries; only disagreements are referred to a named, qualified Clinician who decides each
  item (rater 1, rater 2, adjusted span, no event, uncertain).
