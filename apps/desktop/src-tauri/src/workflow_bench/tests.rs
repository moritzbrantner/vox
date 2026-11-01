use super::*;

/// A synthetic monologue: 3-second segments, a 1-second silence every 3 seconds, a
/// repetition every fourth segment and a filler every seventh.
fn synthetic(id: &str, seconds: usize) -> Recording {
    let rate = 16_000u32;
    let samples = (0..seconds * rate as usize)
        .map(|index| {
            let time = index as f64 / f64::from(rate);
            if (1.9..2.9).contains(&(time % 3.0)) {
                0.0
            } else {
                let carrier = (time * 180.0 * std::f64::consts::TAU).sin();
                (carrier * ((time * 3.0 * std::f64::consts::TAU).sin() * 0.08 + 0.22)) as f32
            }
        })
        .collect();
    let segments = (0..seconds / 3)
        .map(|index| {
            let text = if index % 4 == 0 {
                "I I want to explain this clearly"
            } else if index % 7 == 0 {
                "um this is a synthetic speaking sample"
            } else {
                "this is a synthetic speaking sample"
            };
            let start = index as f64 * 3.0;
            (text.to_string(), start, start + 1.9)
        })
        .collect();
    Recording {
        id: id.into(),
        sample_rate: rate,
        samples,
        segments,
    }
}

fn store_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("vox-workflow-bench-{name}-{}", std::process::id()))
}

#[test]
fn every_workflow_does_work_proportional_to_its_input() {
    // 28 segments repeat the text pattern exactly (lcm of 4 and 7), so 168 s is twice 84 s.
    let report = run(
        [Ok(synthetic("short", 84)), Ok(synthetic("long", 168))],
        &Options {
            chunk_seconds: 8.0,
            store_root: store_root("proportional"),
        },
    )
    .unwrap();
    assert!(report.violations.is_empty(), "{:#?}", report.violations);

    let [short, long] = [
        &report.recordings[0].counters,
        &report.recordings[1].counters,
    ];
    // Twice the audio, twice the transcript: twice the analysis, not more.
    assert_eq!(long.tokens, 2 * short.tokens);
    assert_eq!(
        long.stream.tokens_analyzed,
        2 * short.stream.tokens_analyzed
    );
    assert_eq!(
        long.stream.segments_analyzed,
        2 * short.stream.segments_analyzed
    );
    assert_eq!(
        long.stream.pauses_analyzed,
        2 * short.stream.pauses_analyzed
    );
    // The recorder's last chunk is partial, so chunk counts round up.
    assert!(long.vad_chunks.abs_diff(2 * short.vad_chunks) <= 1);
    let reads = |counters: &RecordCounters| {
        counters.stream.chunk_event_reads as f64 / counters.stream.report_chunks as f64
    };
    assert!(
        reads(long) <= reads(short) * 1.1,
        "{} vs {}",
        reads(long),
        reads(short)
    );
    // The acoustic batch stops at its window.
    assert_eq!(short.acoustic_samples, short.audio_samples);
    assert_eq!(
        long.acoustic_samples,
        (ACOUSTIC_WINDOW_SECONDS * 16_000.0) as u64
    );

    // Kept audio is the capture plus a small header; the session list holds both sessions.
    assert!(long.saved_audio_bytes >= 4 * long.audio_samples);
    assert!(long.saved_audio_bytes < 4 * long.audio_samples + 512);
    assert_eq!(long.saved_sessions_in_list, 2);
    assert_eq!(long.saved_corpus_sessions, 2);

    // Review reads each sealed value once (two sessions and the index); import rewrites each
    // session, the index and the corpus once.
    let stored_sessions =
        short.saved_session_bytes + long.saved_session_bytes + long.saved_session_index_bytes;
    let (review, _) = &report.review;
    assert_eq!(review.web_entries_unsealed, 3);
    assert_eq!(review.web_bytes_unsealed, stored_sessions);
    assert_eq!(review.audio_opened, 2);
    assert_eq!(
        review.audio_bytes_unsealed,
        short.saved_audio_bytes + long.saved_audio_bytes
    );
    assert_eq!(review.corpus_sessions_loaded, 2);
    let (import, _) = &report.import;
    assert_eq!(import.sessions, 2);
    assert_eq!(import.session_list_bytes, stored_sessions);
}

/// vox#157: Save wrote the whole session list and rewrote the whole corpus document, so a save's
/// bytes grew with every session saved before (1x, 2x, 3x here). Now a save writes the session
/// and its corpus entry only; just the id index grows, by one id per session.
#[test]
fn a_save_writes_the_same_bytes_however_many_sessions_were_saved_before() {
    let report = run(
        ["a", "b", "c"].map(|id| Ok(synthetic(id, 30))),
        &Options {
            chunk_seconds: 8.0,
            store_root: store_root("save-growth"),
        },
    )
    .unwrap();
    let saves = report
        .recordings
        .iter()
        .map(|recording| &recording.counters)
        .collect::<Vec<_>>();
    for save in &saves[1..] {
        assert_eq!(save.saved_session_bytes, saves[0].saved_session_bytes);
        assert_eq!(save.saved_corpus_bytes, saves[0].saved_corpus_bytes);
        assert_eq!(save.saved_audio_bytes, saves[0].saved_audio_bytes);
    }
    let id_bytes = saves[1].saved_session_index_bytes - saves[0].saved_session_index_bytes;
    assert_eq!(
        saves[2].saved_session_index_bytes,
        saves[0].saved_session_index_bytes + 2 * id_bytes
    );
    assert!(id_bytes < 32, "{id_bytes} index bytes per session");
    assert_eq!(saves[2].saved_corpus_sessions, 3);
}

#[test]
fn disproportionate_work_is_a_violation() {
    let report = run(
        [Ok(synthetic("one", 30))],
        &Options {
            chunk_seconds: 8.0,
            store_root: store_root("violation"),
        },
    )
    .unwrap();
    let mut counters = report.recordings[0].counters.clone();
    assert!(record_violations("one", &counters).is_empty());
    counters.stream.full_rebuilds = 2;
    counters.stream.tokens_analyzed += 1;
    counters.stream.chunk_event_reads = counters.stream.report_chunks * 40;
    let violations = record_violations("one", &counters);
    assert_eq!(violations.len(), 3, "{violations:#?}");
}
