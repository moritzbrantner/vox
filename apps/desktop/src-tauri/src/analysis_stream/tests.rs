use super::*;
use crate::speech_reference::{cases, pause, segment};

const RUN: &str = "run";

fn start() -> AnalysisStream {
    AnalysisStream::start(&StreamStartRequest {
        run_id: RUN.into(),
        session_started_at: Some("fixture".into()),
    })
}

fn oracle(segments: &[TranscriptSegmentInput], pauses: &[PauseInput]) -> AnalysisReport {
    analyze_speech_session(AnalyzeSpeechRequest {
        segments: segments.to_vec(),
        pauses: pauses.to_vec(),
        session_started_at: Some("fixture".into()),
        samples: None,
        sample_rate: None,
    })
    .unwrap()
}

fn assert_same(live: &AnalysisReport, segments: &[TranscriptSegmentInput], pauses: &[PauseInput]) {
    let parity = compare_reports(live, &oracle(segments, pauses));
    assert!(
        matches!(parity, StreamParity::Match { .. }),
        "{parity:?} after {} segments and {} pauses",
        segments.len(),
        pauses.len()
    );
}

fn finish(
    stream: AnalysisStream,
    segments: &[TranscriptSegmentInput],
    pauses: &[PauseInput],
) -> StreamFinished {
    stream.finish(StreamFinishRequest {
        run_id: RUN.into(),
        segments: segments.to_vec(),
        pauses: pauses.to_vec(),
        session_started_at: Some("fixture".into()),
    })
}

/// A client that sends what changed since its last update, as the web app does.
struct Client {
    stream: AnalysisStream,
    seq: u64,
    sent_segments: Vec<TranscriptSegmentInput>,
    sent_pauses: Vec<PauseInput>,
}

impl Client {
    fn new() -> Self {
        Self {
            stream: start(),
            seq: 0,
            sent_segments: Vec::new(),
            sent_pauses: Vec::new(),
        }
    }

    /// Sends the difference to `segments`/`pauses` and checks the report against the batch
    /// report of exactly that input.
    fn sync(&mut self, segments: &[TranscriptSegmentInput], pauses: &[PauseInput]) -> StreamUpdate {
        let segments_from = common_prefix(&self.sent_segments, segments, same_segment);
        let pauses_from = common_prefix(&self.sent_pauses, pauses, same_pause);
        let update = self
            .stream
            .push(StreamPushRequest {
                run_id: RUN.into(),
                seq: self.seq,
                segments_from,
                segments: segments[segments_from..].to_vec(),
                pauses_from,
                pauses: pauses[pauses_from..].to_vec(),
            })
            .unwrap();
        self.seq += 1;
        self.sent_segments = segments.to_vec();
        self.sent_pauses = pauses.to_vec();
        assert_eq!(update.status, StreamStatus::Live, "{:?}", update.reason);
        if let Some(report) = &update.report {
            assert_same(report, segments, pauses);
        }
        update
    }
}

fn common_prefix<T>(left: &[T], right: &[T], same: impl Fn(&T, &T) -> bool) -> usize {
    left.iter()
        .zip(right)
        .take_while(|(left, right)| same(left, right))
        .count()
}

fn same_segment(left: &TranscriptSegmentInput, right: &TranscriptSegmentInput) -> bool {
    left.text == right.text
        && left.start_seconds.to_bits() == right.start_seconds.to_bits()
        && left.end_seconds.to_bits() == right.end_seconds.to_bits()
        && left.is_final == right.is_final
        && left.confidence.map(f32::to_bits) == right.confidence.map(f32::to_bits)
        && left.speaker_score.map(f32::to_bits) == right.speaker_score.map(f32::to_bits)
        && left.alignment == right.alignment
}

fn same_pause(left: &PauseInput, right: &PauseInput) -> bool {
    left.start_seconds.to_bits() == right.start_seconds.to_bits()
        && left.end_seconds.to_bits() == right.end_seconds.to_bits()
        && left.after_text == right.after_text
}

/// Deterministic xorshift, so every chunking is reproducible.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

const WORDS: &[&str] = &[
    "the", "the", "ball", "b", "b-b-ball", "um", "uh", "like", "sooooo", "went", "home", "I", "I",
    "I", "wanted", "to", "go", "c", "cat", "and", "then", "ähm", "mmmmilk", "",
];

/// A session with every event kind, events spanning segment boundaries, near-duplicate events
/// in neighbouring segments, unaligned and non-final segments, and pauses inside, between and
/// across segments.
fn session(seed: u64, segment_count: usize) -> (Vec<TranscriptSegmentInput>, Vec<PauseInput>) {
    let mut rng = Rng(seed);
    let mut segments = Vec::new();
    let mut pauses = Vec::new();
    let mut clock = rng.unit() * 0.5;
    for index in 0..segment_count {
        let words = (0..1 + rng.below(9))
            .map(|_| WORDS[rng.below(WORDS.len())])
            .collect::<Vec<_>>()
            .join(" ");
        let length = 0.2 + rng.unit() * 4.0;
        // Some segments overlap the previous one, some start exactly at its end.
        let start = match rng.below(6) {
            0 => (clock - rng.unit()).max(0.0),
            1 => clock,
            _ => clock + rng.unit() * 1.5,
        };
        let mut item = segment(&words, start, start + length, rng.below(9) != 0);
        if rng.below(7) == 0 {
            item.alignment = Some(crate::speech_analysis::SegmentAlignment::Unaligned);
        }
        if rng.below(5) == 0 {
            item.speaker_score = Some(rng.unit() as f32);
        }
        if rng.below(11) == 0 {
            item.confidence = None;
        }
        segments.push(item);
        if index > 0 && rng.below(8) == 0 {
            // A near-duplicate of the previous event text, starting within 0.08 s.
            let mut twin = segment("um", start + 0.01, start + 0.3, true);
            twin.confidence = None;
            segments.push(twin);
        }
        clock = start + length;
        for _ in 0..rng.below(3) {
            let pause_start = start + rng.unit() * (length + 1.5) - 0.5;
            let pause_length = rng.unit() * 2.4;
            let mut item = pause(pause_start, pause_start + pause_length);
            if rng.below(2) == 0 {
                item.after_text = Some(words.clone());
            }
            pauses.push(item);
        }
    }
    (segments, pauses)
}

/// Feeds the final input as appends of `segment_step` segments and `pause_step` pauses.
fn append_in_steps(
    segments: &[TranscriptSegmentInput],
    pauses: &[PauseInput],
    segment_step: usize,
    pause_step: usize,
) -> Client {
    let mut client = Client::new();
    let (mut s, mut p) = (0, 0);
    while s < segments.len() || p < pauses.len() {
        s = (s + segment_step).min(segments.len());
        p = (p + pause_step).min(pauses.len());
        client.sync(&segments[..s], &pauses[..p]);
    }
    client
}

#[test]
fn every_prefix_in_every_chunking_equals_the_batch_report() {
    for seed in 1..=12u64 {
        let (segments, pauses) = session(seed * 7_919, 40);
        for (segment_step, pause_step) in [(1, 1), (1, 0), (2, 3), (3, 1), (5, 2), (7, 7), (40, 40)]
        {
            let pause_step = if pause_step == 0 {
                pauses.len()
            } else {
                pause_step
            };
            let client = append_in_steps(&segments, &pauses, segment_step, pause_step);
            let finished = finish(client.stream, &segments, &pauses);
            assert!(
                matches!(finished.parity, StreamParity::Match { .. }),
                "seed {seed} steps {segment_step}/{pause_step}: {:?}",
                finished.parity
            );
            assert_eq!(finished.work.segments_revisited, 0);
            assert_eq!(finished.work.full_rebuilds, 0);
        }
    }
}

#[test]
fn reference_cases_match_in_every_chunking() {
    for (name, case) in cases() {
        let valid = case.segments.iter().all(|segment| {
            !segment.is_final
                || (segment.start_seconds.is_finite() && segment.end_seconds.is_finite())
        });
        if !valid {
            let mut stream = start();
            let error = stream
                .push(StreamPushRequest {
                    run_id: RUN.into(),
                    seq: 0,
                    segments_from: 0,
                    segments: case.segments.clone(),
                    pauses_from: 0,
                    pauses: case.pauses.clone(),
                })
                .unwrap_err();
            assert_eq!(error, "segment times must be finite", "{name}");
            let finished = finish(stream, &case.segments, &case.pauses);
            assert!(
                matches!(finished.parity, StreamParity::NotComparable { .. }),
                "{name}"
            );
            continue;
        }
        for step in 1..=3 {
            let client = append_in_steps(&case.segments, &case.pauses, step, step);
            let finished = finish(client.stream, &case.segments, &case.pauses);
            assert!(
                matches!(finished.parity, StreamParity::Match { .. }),
                "{name} step {step}: {:?}",
                finished.parity
            );
        }
    }
}

#[test]
fn revisions_of_recent_segments_and_partial_to_final_corrections_converge() {
    for seed in 1..=10u64 {
        let (segments, pauses) = session(seed * 104_729, 30);
        let mut rng = Rng(seed);
        let mut client = Client::new();
        for count in 1..=segments.len() {
            let mut shown = segments[..count].to_vec();
            // The newest segment first arrives as a partial, sometimes with other words.
            let last = shown.last_mut().unwrap();
            let truth = last.clone();
            last.is_final = false;
            if rng.below(2) == 0 {
                last.text = format!("{} um um", truth.text);
            }
            let visible_pauses = &pauses[..(count * pauses.len() / segments.len())];
            client.sync(&shown, visible_pauses);
            // Then a correction of the last few segments: merged, split or shifted text.
            if count > 3 && rng.below(3) == 0 {
                let mut corrected = segments[..count].to_vec();
                let at = count - 1 - rng.below(3);
                corrected[at].text = format!("{} the the", corrected[at].text);
                corrected[at].start_seconds += 0.05;
                client.sync(&corrected, visible_pauses);
            }
            client.sync(&segments[..count], visible_pauses);
        }
        client.sync(&segments, &pauses);
        let finished = finish(client.stream, &segments, &pauses);
        assert!(
            matches!(finished.parity, StreamParity::Match { .. }),
            "{:?}",
            finished.parity
        );
        assert!(finished.work.segments_revisited > 0);
        // Revisions replaced only recent positions (at most the last three, plus the partial):
        // only the very first segment's correction replaced everything held.
        assert!(finished.work.segments_revisited <= 4 * 2 * segments.len() as u64);
        assert!(finished.work.full_rebuilds <= 1);
    }
}

#[test]
fn removed_segments_and_pauses_leave_no_trace() {
    let (segments, pauses) = session(99, 25);
    let mut client = Client::new();
    client.sync(&segments, &pauses);
    // Shrinking (a recognizer withdrew results) and growing back.
    client.sync(&segments[..10], &pauses[..pauses.len() / 3]);
    client.sync(&segments[..10], &[]);
    client.sync(&[], &[]);
    client.sync(&segments, &pauses);
    let finished = finish(client.stream, &segments, &pauses);
    assert!(
        matches!(finished.parity, StreamParity::Match { .. }),
        "{:?}",
        finished.parity
    );
    assert!(finished.work.full_rebuilds >= 1);
}

#[test]
fn no_input_updates_do_no_work_and_build_no_report() {
    let (segments, pauses) = session(5, 20);
    let mut client = append_in_steps(&segments, &pauses, 1, 1);
    let before = client.stream.work.clone();
    for _ in 0..50 {
        let update = client.sync(&segments, &pauses);
        assert!(!update.changed);
        assert!(update.report.is_none());
    }
    let after = client.stream.work.clone();
    assert_eq!(after.no_op_updates, before.no_op_updates + 50);
    assert_eq!(
        WorkCounters {
            no_op_updates: before.no_op_updates,
            ..after
        },
        before
    );
}

#[test]
fn duplicate_and_reordered_updates_change_nothing() {
    let (segments, pauses) = session(17, 12);
    let mut stream = start();
    let push =
        |stream: &mut AnalysisStream, seq, segments_from, segments: &[TranscriptSegmentInput]| {
            stream
                .push(StreamPushRequest {
                    run_id: RUN.into(),
                    seq,
                    segments_from,
                    segments: segments.to_vec(),
                    pauses_from: 0,
                    pauses: Vec::new(),
                })
                .unwrap()
        };
    push(&mut stream, 0, 0, &segments[..4]);
    let applied = push(&mut stream, 1, 4, &segments[4..8]);
    // A repeat of update 1 and a late update 0 with older content.
    let repeat = push(&mut stream, 1, 4, &segments[4..8]);
    let late = push(&mut stream, 0, 0, &segments[..2]);
    assert!(!repeat.changed && !late.changed);
    assert_eq!(repeat.status, StreamStatus::Live);
    assert_eq!(stream.work.duplicate_updates, 2);
    let report = stream.report();
    assert_same(&report, &segments[..8], &pauses[..0]);
    assert_eq!(
        serde_json::to_value(&report).unwrap(),
        serde_json::to_value(applied.report.unwrap()).unwrap()
    );
}

#[test]
fn a_missing_update_interrupts_until_a_full_resync() {
    let (segments, pauses) = session(23, 15);
    let mut stream = start();
    let request = |seq,
                   segments_from,
                   segments: &[TranscriptSegmentInput],
                   pauses_from,
                   pauses: &[PauseInput]| StreamPushRequest {
        run_id: RUN.into(),
        seq,
        segments_from,
        segments: segments.to_vec(),
        pauses_from,
        pauses: pauses.to_vec(),
    };
    stream
        .push(request(0, 0, &segments[..5], 0, &pauses[..2]))
        .unwrap();
    // Update 1 is lost; update 2 builds on content the stream never saw.
    let gap = stream
        .push(request(2, 9, &segments[9..12], 2, &pauses[2..3]))
        .unwrap();
    assert_eq!(gap.status, StreamStatus::Interrupted);
    assert!(!gap.changed && gap.report.is_none());
    let refused = stream
        .push(request(3, 12, &segments[12..], 3, &pauses[3..]))
        .unwrap();
    assert_eq!(refused.status, StreamStatus::Interrupted);
    assert!(!refused.changed);
    // An interrupted run is never compared as if it were complete.
    let mut probe = AnalysisStream::start(&StreamStartRequest {
        run_id: RUN.into(),
        session_started_at: Some("fixture".into()),
    });
    probe.status = StreamStatus::Interrupted;
    probe.reason = Some("probe".into());
    assert!(matches!(
        finish(probe, &segments, &pauses).parity,
        StreamParity::NotComparable { .. }
    ));
    // Recovery: everything again from position 0.
    let resync = stream.push(request(4, 0, &segments, 0, &pauses)).unwrap();
    assert_eq!(resync.status, StreamStatus::Live);
    assert_same(resync.report.as_ref().unwrap(), &segments, &pauses);
    let finished = finish(stream, &segments, &pauses);
    assert!(matches!(finished.parity, StreamParity::Match { .. }));
    assert_eq!(finished.work.full_rebuilds, 1);
    assert_eq!(finished.work.rejected_updates, 2);
}

#[test]
fn an_update_beyond_the_held_input_interrupts() {
    let (segments, _) = session(31, 6);
    let mut stream = start();
    let update = stream
        .push(StreamPushRequest {
            run_id: RUN.into(),
            seq: 0,
            segments_from: 2,
            segments: segments.clone(),
            pauses_from: 0,
            pauses: Vec::new(),
        })
        .unwrap();
    assert_eq!(update.status, StreamStatus::Interrupted);
    assert!(update.reason.unwrap().contains("beyond"));
}

#[test]
fn input_beyond_the_bound_is_refused_as_overloaded_not_analyzed() {
    let mut stream = start();
    let many = (0..MAX_PAUSES + 1)
        .map(|index| pause(index as f64, index as f64 + 0.1))
        .collect::<Vec<_>>();
    let update = stream
        .push(StreamPushRequest {
            run_id: RUN.into(),
            seq: 0,
            segments_from: 0,
            segments: Vec::new(),
            pauses_from: 0,
            pauses: many.clone(),
        })
        .unwrap();
    assert_eq!(update.status, StreamStatus::Overloaded);
    assert!(update.report.is_none());
    assert_eq!(update.work.pauses_analyzed, 0);
    let finished = finish(stream, &[], &many);
    assert!(matches!(
        finished.parity,
        StreamParity::NotComparable { .. }
    ));
}

#[test]
fn a_finished_or_replaced_run_cannot_change_the_active_one() {
    let state = AnalysisStreamState::default();
    start_active(
        &state,
        &StreamStartRequest {
            run_id: "old".into(),
            session_started_at: None,
        },
    )
    .unwrap();
    start_active(
        &state,
        &StreamStartRequest {
            run_id: "new".into(),
            session_started_at: None,
        },
    )
    .unwrap();
    let late = push_active(
        &state,
        StreamPushRequest {
            run_id: "old".into(),
            seq: 0,
            segments_from: 0,
            segments: vec![segment("the the", 0.0, 1.0, true)],
            pauses_from: 0,
            pauses: Vec::new(),
        },
    );
    assert!(late.is_err());
    let finished = finish_active(
        &state,
        StreamFinishRequest {
            run_id: "new".into(),
            segments: Vec::new(),
            pauses: Vec::new(),
            session_started_at: None,
        },
    )
    .unwrap();
    assert!(matches!(
        finished.parity,
        StreamParity::Match { events: 0, .. }
    ));
    // Finishing ends the run: nothing more is accepted for it.
    assert!(push_active(
        &state,
        StreamPushRequest {
            run_id: "new".into(),
            seq: 0,
            segments_from: 0,
            segments: Vec::new(),
            pauses_from: 0,
            pauses: Vec::new(),
        },
    )
    .is_err());
}

#[test]
fn work_grows_with_new_input_not_with_history() {
    let (segments, pauses) = session(4_242, 2_000);
    let mut client = Client::new();
    let total_tokens: usize = segments
        .iter()
        .enumerate()
        .filter(|(_, segment)| segment.is_final)
        .map(|(index, segment)| timed_tokens(index, segment).len())
        .sum();
    // Appends only, one segment and its pauses at a time; reports are checked at the end
    // (checking every one against the batch would itself be quadratic).
    let mut stream_seq = 0;
    let (mut s, mut p) = (0, 0);
    while s < segments.len() {
        let next_s = s + 1;
        let next_p = (next_s * pauses.len() / segments.len()).max(p);
        client
            .stream
            .push(StreamPushRequest {
                run_id: RUN.into(),
                seq: stream_seq,
                segments_from: s,
                segments: segments[s..next_s].to_vec(),
                pauses_from: p,
                pauses: pauses[p..next_p].to_vec(),
            })
            .unwrap();
        stream_seq += 1;
        s = next_s;
        p = next_p;
    }
    client
        .stream
        .push(StreamPushRequest {
            run_id: RUN.into(),
            seq: stream_seq,
            segments_from: s,
            segments: Vec::new(),
            pauses_from: p,
            pauses: pauses[p..].to_vec(),
        })
        .unwrap();
    let work = client.stream.work.clone();
    assert_eq!(work.tokens_analyzed as usize, total_tokens);
    assert_eq!(
        work.segments_analyzed as usize,
        segments.iter().filter(|s| s.is_final).count()
    );
    assert_eq!(work.pauses_analyzed as usize, pauses.len());
    assert_eq!(
        work.segments_revisited + work.pauses_revisited + work.full_rebuilds,
        0
    );
    // Counting a chunk's events reads only the events near it, not the history.
    let reads_per_chunk = work.chunk_event_reads as f64 / work.report_chunks as f64;
    assert!(
        reads_per_chunk < 12.0,
        "{reads_per_chunk} event reads per chunk"
    );
    assert_eq!(work.retained_segments, segments.len());
    assert_eq!(work.retained_pauses, pauses.len());
    let finished = finish(client.stream, &segments, &pauses);
    assert!(
        matches!(finished.parity, StreamParity::Match { .. }),
        "{:?}",
        finished.parity
    );
}

#[test]
fn a_mismatch_is_reported_with_its_differences() {
    let segments = vec![segment("the the ball", 0.0, 1.0, true)];
    let mut live = oracle(&segments, &[]);
    live.word_count += 1;
    live.speech_stats.words_per_minute += 1e-12;
    match compare_reports(&live, &oracle(&segments, &[])) {
        StreamParity::Mismatch {
            difference_count,
            differences,
        } => {
            assert_eq!(difference_count, 2);
            assert!(differences.iter().any(|item| item.contains("wordCount")));
            assert!(differences
                .iter()
                .any(|item| item.contains("wordsPerMinute")));
        }
        other => panic!("{other:?}"),
    }
}

/// Real recordings: UCLASS release 1 monologues of speakers who stutter with their
/// native-whisperx transcript (`asr-eval` hypotheses, vox#26/#143). Pauses come from the audio
/// the way the recorder finds them (RMS of each 2048-sample chunk above 0.025 is voice; more than
/// 0.75 s between voiced chunks is a pause). Segments arrive when their transcription chunk ends,
/// first as a partial, then final; pauses when they end. Every update is compared with the
/// batch report of exactly that input.
///
/// `VOX_UCLASS_HYPOTHESES` (an asr-eval run file) and `VOX_UCLASS_ROOT` (holding `audio16k/`).
#[test]
#[ignore = "requires the local UCLASS audio and an asr-eval run"]
fn real_uclass_recordings_match_the_batch_report_in_every_chunking() {
    let hypotheses: Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("VOX_UCLASS_HYPOTHESES").unwrap()).unwrap(),
    )
    .unwrap();
    let root = std::path::PathBuf::from(std::env::var("VOX_UCLASS_ROOT").unwrap());
    let chunk_seconds = hypotheses["chunkSeconds"].as_f64().unwrap_or(8.0);
    eprintln!(
        "| recording | audio s | segments | pauses | events | chunks | cadence | updates (no-op) | tokens / analyzed | revisited | max update ms | parity |"
    );
    eprintln!("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for item in hypotheses["items"].as_array().unwrap() {
        let recording = item["item"].as_str().unwrap();
        // The noise subset transcribes the recording with seeded noise added; its pauses still
        // come from the clean recording.
        let id = if item["subset"].as_str().unwrap_or("").contains("noise") {
            format!("{recording} (noise transcript)")
        } else {
            recording.to_string()
        };
        let segments: Vec<TranscriptSegmentInput> = item["segments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| {
                let mut segment = segment(
                    value["text"].as_str().unwrap(),
                    value["startSeconds"].as_f64().unwrap(),
                    value["endSeconds"].as_f64().unwrap(),
                    true,
                );
                segment.confidence = None;
                segment
            })
            .collect();
        let path = root.join("audio16k").join(format!("{recording}.wav"));
        let Ok(mut reader) = hound::WavReader::open(&path) else {
            eprintln!("| {id} | missing audio | | | | | | | | | | |");
            continue;
        };
        let rate = reader.spec().sample_rate as f64;
        let samples = reader
            .samples::<i16>()
            .map(|sample| f32::from(sample.unwrap()) / 32_768.0)
            .collect::<Vec<_>>();
        let audio_seconds = samples.len() as f64 / rate;
        let pauses = recorder_pauses(&samples, rate, &segments);

        // Arrival times: a segment when its transcription chunk is done, a pause when it ends.
        let mut arrivals: Vec<(f64, bool, usize)> = segments
            .iter()
            .enumerate()
            .map(|(index, segment)| {
                (
                    ((segment.end_seconds / chunk_seconds).floor() + 1.0) * chunk_seconds,
                    true,
                    index,
                )
            })
            .chain(
                pauses
                    .iter()
                    .enumerate()
                    .map(|(index, pause)| (pause.end_seconds, false, index)),
            )
            .collect();
        arrivals.sort_by(|left, right| left.0.total_cmp(&right.0));
        for cadence in [1usize, 3, 8] {
            let mut client = Client::new();
            let (mut shown_segments, mut shown_pauses) = (0usize, 0usize);
            for batch in arrivals.chunks(cadence) {
                let arrived_from = shown_segments;
                for (_, is_segment, index) in batch {
                    if *is_segment {
                        shown_segments = shown_segments.max(index + 1);
                    } else {
                        shown_pauses = shown_pauses.max(index + 1);
                    }
                }
                // Newly arrived segments are partial first, then final.
                let mut partial = segments[..shown_segments].to_vec();
                for segment in &mut partial[arrived_from..] {
                    segment.is_final = false;
                }
                client.sync(&partial, &pauses[..shown_pauses]);
                client.sync(&segments[..shown_segments], &pauses[..shown_pauses]);
            }
            client.sync(&segments, &pauses);
            let finished = finish(client.stream, &segments, &pauses);
            let report = oracle(&segments, &pauses);
            let tokens: usize = segments
                .iter()
                .enumerate()
                .map(|(index, segment)| timed_tokens(index, segment).len())
                .sum();
            assert_eq!(finished.work.tokens_analyzed as usize, tokens, "{id}");
            eprintln!(
                "| {id} | {audio_seconds:.1} | {} | {} | {} | {} | {cadence} | {} ({}) | {tokens} / {} | {} | {:.3} | {} |",
                segments.len(),
                pauses.len(),
                report.events.len(),
                report.chunks.len(),
                finished.work.updates,
                finished.work.no_op_updates,
                finished.work.tokens_analyzed,
                finished.work.segments_revisited,
                finished.max_update_ms,
                match &finished.parity {
                    StreamParity::Match { .. } => "match".to_string(),
                    other => format!("{other:?}"),
                }
            );
            assert!(
                matches!(finished.parity, StreamParity::Match { .. }),
                "{id}"
            );
        }
    }
}

fn recorder_pauses(
    samples: &[f32],
    rate: f64,
    segments: &[TranscriptSegmentInput],
) -> Vec<PauseInput> {
    let mut pauses = Vec::new();
    let mut last_voice = 0.0_f64;
    for (index, chunk) in samples.chunks(2_048).enumerate() {
        let energy = chunk.iter().map(|sample| sample * sample).sum::<f32>();
        let rms = (energy / chunk.len().max(1) as f32).sqrt();
        let now = (index * 2_048 + chunk.len()) as f64 / rate;
        if rms > 0.025 {
            if last_voice > 0.0 && now - last_voice > 0.75 {
                pauses.push(PauseInput {
                    start_seconds: last_voice,
                    end_seconds: now,
                    after_text: segments
                        .iter()
                        .rev()
                        .find(|segment| segment.end_seconds <= last_voice)
                        .map(|segment| segment.text.clone()),
                });
            }
            last_voice = now;
        }
    }
    pauses
}
