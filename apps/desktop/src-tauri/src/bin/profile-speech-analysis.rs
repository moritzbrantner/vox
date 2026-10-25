use std::env;
use std::time::Instant;

mod video_analysis_core {
    pub use media_core::DetectError;
}

// Shared with the app; this binary uses only the analysis entry point.
#[allow(dead_code)]
#[path = "../speech_analysis.rs"]
mod speech_analysis;
#[allow(dead_code)]
#[path = "../speech_pipeline.rs"]
mod speech_pipeline;
// The pipeline's tests use the shared reference cases.
#[cfg(test)]
#[path = "../speech_reference.rs"]
mod speech_reference;

use speech_analysis::{AnalyzeSpeechRequest, PauseInput, TranscriptSegmentInput};

fn main() {
    let options = Options::parse();
    let request = fixture(options.duration_seconds, options.audio);
    // The capture-quality pass on its own, so its share of post-session latency stays visible.
    let capture_metrics_seconds = request.samples.as_ref().map(|samples| {
        let started = Instant::now();
        audio_analysis_core::capture_metrics(
            samples,
            request.sample_rate.unwrap_or(16_000),
            1,
            &audio_analysis_core::CaptureMetricsConfig::default(),
        )
        .expect("synthetic capture metrics must succeed");
        started.elapsed().as_secs_f64()
    });
    let started = Instant::now();
    let report = speech_pipeline::analyze_speech_session(request)
        .expect("synthetic speech analysis must succeed");
    let elapsed = started.elapsed().as_secs_f64();
    let real_time_factor = elapsed / options.duration_seconds.max(0.001);

    println!(
        "{}",
        serde_json::json!({
            "schemaVersion": 1,
            "workload": "speech-analysis",
            "durationSeconds": options.duration_seconds,
            "audio": options.audio,
            "elapsedSeconds": elapsed,
            "realTimeFactor": real_time_factor,
            "captureMetricsSeconds": capture_metrics_seconds,
            "eventCount": report.events.len(),
            "wordCount": report.word_count,
            "analyzedAudioSeconds": report.acoustic_stats.as_ref().map(|stats| stats.analyzed_duration_seconds),
        })
    );
}

#[derive(Debug, Clone, Copy)]
struct Options {
    duration_seconds: f64,
    audio: bool,
}

impl Options {
    fn parse() -> Self {
        let mut duration_seconds = 30.0;
        let mut audio = true;
        let mut args = env::args().skip(1);
        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--duration-seconds" => {
                    duration_seconds = args
                        .next()
                        .expect("--duration-seconds requires a value")
                        .parse::<f64>()
                        .expect("duration must be a number");
                }
                "--no-audio" => audio = false,
                "--audio" => audio = true,
                unknown => panic!("unknown argument: {unknown}"),
            }
        }
        assert!(duration_seconds.is_finite() && duration_seconds >= 1.0);
        Self {
            duration_seconds,
            audio,
        }
    }
}

fn fixture(duration_seconds: f64, include_audio: bool) -> AnalyzeSpeechRequest {
    let segment_seconds = 3.0;
    let segment_count = (duration_seconds / segment_seconds).ceil() as usize;
    let segments = (0..segment_count)
        .map(|index| {
            let start_seconds = index as f64 * segment_seconds;
            let end_seconds = (start_seconds + segment_seconds).min(duration_seconds);
            TranscriptSegmentInput {
                text: if index % 4 == 0 {
                    "I I want to explain this clearly".to_string()
                } else if index % 7 == 0 {
                    "um this is a synthetic speaking sample".to_string()
                } else {
                    "this is a synthetic speaking sample".to_string()
                },
                start_seconds,
                end_seconds,
                confidence: Some(0.94),
                speaker_score: Some(0.98),
                is_final: true,
                alignment: None,
            }
        })
        .collect::<Vec<_>>();

    let pauses = (1..segment_count)
        .filter(|index| index % 5 == 0)
        .map(|index| {
            let start_seconds = index as f64 * segment_seconds - 0.7;
            PauseInput {
                start_seconds,
                end_seconds: start_seconds + 0.65,
                after_text: Some("sample".to_string()),
            }
        })
        .collect::<Vec<_>>();

    let sample_rate = 16_000_u32;
    let samples = include_audio.then(|| synthetic_audio(duration_seconds, sample_rate));

    AnalyzeSpeechRequest {
        segments,
        pauses,
        session_started_at: None,
        samples,
        sample_rate: include_audio.then_some(sample_rate),
    }
}

fn synthetic_audio(duration_seconds: f64, sample_rate: u32) -> Vec<f32> {
    let sample_count = (duration_seconds * sample_rate as f64).round() as usize;
    (0..sample_count)
        .map(|index| {
            let time = index as f64 / sample_rate as f64;
            let cycle = time % 3.0;
            if (1.9..2.55).contains(&cycle) {
                0.0
            } else {
                let carrier = (time * 180.0 * std::f64::consts::TAU).sin();
                let modulation = (time * 3.0 * std::f64::consts::TAU).sin() * 0.08 + 0.22;
                (carrier * modulation) as f32
            }
        })
        .collect()
}
