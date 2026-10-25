//! Legacy-to-refactored comparison for the speech analysis.
//!
//! `fixtures/speech/legacy-reference.json` holds the reports the batch detector produced for the
//! cases below before its stages moved onto the typed evidence path (speech analysis version 1).
//! The evidence path must reproduce them; only what it adds (`observations`, `capabilities` and
//! event `evidence`) is ignored. Regenerate only for an intentional, benchmarked semantic change:
//!
//! ```bash
//! VOX_UPDATE_SPEECH_REFERENCE=1 cargo test speech_reference
//! ```

use serde_json::Value;

use crate::speech_analysis::{AnalyzeSpeechRequest, PauseInput, TranscriptSegmentInput};

const REFERENCE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/fixtures/speech/legacy-reference.json"
);

/// Numbers derived from audio go through resampling, FFT and autocorrelation in the
/// audio-analysis crates; a different platform, compiler or SIMD path may round differently.
/// Transcript- and pause-derived numbers are plain arithmetic on the input and match exactly
/// on one platform, but they share the comparison below for simplicity.
pub(crate) const ABSOLUTE_TOLERANCE: f64 = 1e-9;
pub(crate) const RELATIVE_TOLERANCE: f64 = 1e-9;

pub(crate) fn segment(text: &str, start: f64, end: f64, is_final: bool) -> TranscriptSegmentInput {
    TranscriptSegmentInput {
        text: text.to_string(),
        start_seconds: start,
        end_seconds: end,
        confidence: Some(0.9),
        speaker_score: None,
        is_final,
    }
}

pub(crate) fn pause(start: f64, end: f64) -> PauseInput {
    PauseInput {
        start_seconds: start,
        end_seconds: end,
        after_text: None,
    }
}

pub(crate) fn request(
    segments: Vec<TranscriptSegmentInput>,
    pauses: Vec<PauseInput>,
    audio: Option<(Vec<f32>, Option<u32>)>,
) -> AnalyzeSpeechRequest {
    let (samples, sample_rate) = match audio {
        Some((samples, rate)) => (Some(samples), rate),
        None => (None, None),
    };
    AnalyzeSpeechRequest {
        segments,
        pauses,
        session_started_at: Some("fixture".to_string()),
        samples,
        sample_rate,
    }
}

pub(crate) fn sine(frequency: f32, sample_rate: u32, seconds: f32) -> Vec<f32> {
    let count = (sample_rate as f32 * seconds) as usize;
    (0..count)
        .map(|index| {
            let phase = index as f32 * frequency * std::f32::consts::TAU / sample_rate as f32;
            phase.sin() * 0.4
        })
        .collect()
}

pub(crate) fn silence(sample_rate: u32, seconds: f32) -> Vec<f32> {
    vec![0.0; (sample_rate as f32 * seconds) as usize]
}

fn bursts(sample_rate: u32, count: usize) -> Vec<f32> {
    let mut samples = Vec::new();
    for _ in 0..count {
        samples.extend(sine(440.0, sample_rate, 0.08));
        samples.extend(silence(sample_rate, 0.12));
    }
    samples
}

/// Named inputs covering silence, repetitions, overlapping channels, incomplete input,
/// partial/final transcripts and invalid numeric or timing data.
pub(crate) fn cases() -> Vec<(&'static str, AnalyzeSpeechRequest)> {
    let rate = 16_000;
    vec![
        ("empty", request(vec![], vec![], None)),
        ("silence/pause only", request(vec![], vec![pause(0.0, 3.0)], None)),
        (
            "silence/zero audio",
            request(vec![], vec![], Some((silence(rate, 2.0), Some(rate)))),
        ),
        (
            "repetitions/transcript",
            request(
                vec![
                    segment("I I I want to go", 0.0, 2.0, true),
                    segment("b- but the the train", 2.5, 4.0, true),
                    segment("um um so so", 4.5, 5.5, true),
                    segment("w-w-what a sssssstart uh", 6.0, 8.0, true),
                ],
                vec![pause(2.0, 2.5), pause(4.0, 4.5), pause(5.5, 6.0)],
                None,
            ),
        ),
        (
            "repetitions/acoustic bursts only",
            request(vec![], vec![], Some((bursts(rate, 3), Some(rate)))),
        ),
        (
            "partial and final",
            request(
                vec![
                    segment("we we", 0.0, 1.0, false),
                    segment("we we need", 0.0, 1.5, true),
                    segment("need need", 1.5, 9.0, false),
                ],
                vec![],
                None,
            ),
        ),
        (
            "partial only",
            request(vec![segment("go go", 0.0, 1.0, false)], vec![pause(1.0, 2.0)], None),
        ),
        (
            "overlap/prolongation fused",
            request(
                vec![segment("ssssstart", 0.0, 0.9, true)],
                vec![],
                Some((sine(180.0, rate, 0.9), Some(rate))),
            ),
        ),
        (
            "overlap/repetition bursts and transcript",
            request(
                vec![segment("go go now", 0.0, 0.6, true)],
                vec![],
                Some((bursts(rate, 3), Some(rate))),
            ),
        ),
        (
            "overlap/pause and acoustic block",
            request(
                vec![
                    segment("well", 0.0, 0.6, true),
                    segment("then", 1.3, 1.9, true),
                ],
                vec![PauseInput {
                    start_seconds: 0.6,
                    end_seconds: 1.4,
                    after_text: Some("then".to_string()),
                }],
                Some((
                    [
                        sine(220.0, rate, 0.6),
                        silence(rate, 0.7),
                        sine(220.0, rate, 0.6),
                    ]
                    .concat(),
                    Some(rate),
                )),
            ),
        ),
        (
            "overlap/speech during a transcript pause",
            request(
                vec![segment("so", 0.0, 0.4, true)],
                vec![pause(0.4, 1.6)],
                Some((sine(200.0, rate, 2.0), Some(rate))),
            ),
        ),
        (
            "overlap/resampled 8 kHz audio",
            request(
                vec![segment("ssssso", 0.0, 0.9, true)],
                vec![],
                Some((sine(180.0, 8_000, 0.9), Some(8_000))),
            ),
        ),
        (
            "incomplete/audio too short",
            request(
                vec![segment("go go", 0.0, 1.0, true)],
                vec![],
                Some((vec![0.1; 800], Some(rate))),
            ),
        ),
        (
            "incomplete/audio beyond the analyzed window",
            request(
                vec![segment("late late words", 91.0, 92.0, true)],
                vec![],
                Some(([silence(4_000, 91.0), sine(180.0, 4_000, 1.0)].concat(), Some(4_000))),
            ),
        ),
        (
            "incomplete/transcript without audio",
            request(vec![segment("no no audio", 0.0, 1.5, true)], vec![], None),
        ),
        (
            "invalid/non-finite final segment",
            request(vec![segment("I I", f64::NAN, 1.0, true)], vec![], None),
        ),
        (
            "invalid/non-finite partial segment",
            request(
                vec![
                    segment("x", f64::NAN, 1.0, false),
                    segment("so so", 0.0, 1.0, true),
                ],
                vec![],
                None,
            ),
        ),
        (
            "invalid/inverted segment",
            request(vec![segment("to to", 2.0, 1.0, true)], vec![], None),
        ),
        (
            "invalid/non-finite pause",
            request(
                vec![segment("ok", 0.0, 1.0, true)],
                vec![pause(f64::NAN, 2.0), pause(1.0, f64::INFINITY)],
                None,
            ),
        ),
        (
            "invalid/non-finite sample",
            request(vec![], vec![], Some((vec![0.0, f32::NAN], Some(rate)))),
        ),
        (
            "invalid/zero sample rate",
            request(vec![], vec![], Some((vec![0.1; 800], Some(0)))),
        ),
        (
            "invalid/samples without rate",
            request(vec![], vec![], Some((vec![0.1; 800], None))),
        ),
    ]
}

/// A report as the legacy detector serialized it, or its error.
pub(crate) fn legacy_view(
    result: Result<crate::speech_analysis::AnalysisReport, crate::speech_analysis::SpeechAnalysisError>,
) -> Value {
    match result {
        Ok(report) => {
            let mut value = serde_json::to_value(report).unwrap();
            let object = value.as_object_mut().unwrap();
            object.remove("observations");
            object.remove("capabilities");
            for event in object["events"].as_array_mut().unwrap() {
                event.as_object_mut().unwrap().remove("evidence");
            }
            // byKind is a map; its key order is not part of the contract.
            if let Some(Value::Object(by_kind)) = object.get_mut("byKind") {
                let sorted: serde_json::Map<String, Value> = by_kind
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<std::collections::BTreeMap<_, _>>()
                    .into_iter()
                    .collect();
                *by_kind = sorted;
            }
            value
        }
        Err(error) => serde_json::json!({ "error": error.to_string() }),
    }
}

/// Differences between two JSON values, numbers compared within the documented tolerance.
pub(crate) fn differences(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Number(left), Value::Number(right)) => {
            let (left, right) = (left.as_f64().unwrap(), right.as_f64().unwrap());
            let tolerance = ABSOLUTE_TOLERANCE.max(RELATIVE_TOLERANCE * left.abs().max(right.abs()));
            if (left - right).abs() > tolerance {
                out.push(format!("{path}: expected {left}, got {right}"));
            }
        }
        (Value::Object(left), Value::Object(right)) => {
            for key in left.keys().chain(right.keys().filter(|key| !left.contains_key(*key))) {
                differences(
                    &format!("{path}.{key}"),
                    left.get(key).unwrap_or(&Value::Null),
                    right.get(key).unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                out.push(format!("{path}: expected {} items, got {}", left.len(), right.len()));
                return;
            }
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                differences(&format!("{path}[{index}]"), left, right, out);
            }
        }
        _ if expected != actual => out.push(format!("{path}: expected {expected}, got {actual}")),
        _ => {}
    }
}

#[test]
fn evidence_path_reproduces_the_legacy_reference() {
    let actual: serde_json::Map<String, Value> = cases()
        .into_iter()
        .map(|(name, case)| {
            (
                name.to_string(),
                legacy_view(crate::speech_pipeline::analyze_speech_session(case)),
            )
        })
        .collect();
    if std::env::var_os("VOX_UPDATE_SPEECH_REFERENCE").is_some() {
        let text = serde_json::to_string_pretty(&Value::Object(actual)).unwrap();
        std::fs::create_dir_all(std::path::Path::new(REFERENCE_PATH).parent().unwrap()).unwrap();
        std::fs::write(REFERENCE_PATH, text + "\n").unwrap();
        return;
    }
    let expected: serde_json::Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(REFERENCE_PATH).unwrap()).unwrap();
    assert_eq!(
        expected.keys().collect::<Vec<_>>(),
        actual.keys().collect::<Vec<_>>(),
        "reference cases changed; regenerate only for an intentional change"
    );
    let mut out = Vec::new();
    for (name, value) in &expected {
        differences(name, value, &actual[name], &mut out);
    }
    assert!(out.is_empty(), "semantic differences:\n{}", out.join("\n"));
}
