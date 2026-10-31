use std::io::{self, Read};
use std::process::ExitCode;

use serde::Deserialize;
use serde_json::Value;
use stutter_tracker_lib::capture::{capture_metrics_impl, CaptureMetricsRequest};
use stutter_tracker_lib::transcription::{
    download_transcription_model_impl, transcribe_audio_file_impl, transcribe_audio_impl,
    transcription_models_impl, DownloadTranscriptionModelRequest, TranscribeAudioFileRequest,
    TranscribeAudioRequest, TranscriptionModelsRequest, TranscriptionProgressEvent,
};

#[derive(Debug, Deserialize)]
#[serde(tag = "command", content = "request", rename_all = "kebab-case")]
enum WorkerCommand {
    TranscriptionModels(TranscriptionModelsRequest),
    DownloadTranscriptionModel(DownloadTranscriptionModelRequest),
    TranscribeAudio(TranscribeAudioRequest),
    TranscribeAudioFile(TranscribeAudioFileRequest),
    CaptureMetrics(CaptureMetricsRequest),
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let command = read_command()?;
    let response = match command {
        WorkerCommand::TranscriptionModels(request) => {
            to_value(transcription_models_impl(request).map_err(|error| error.to_string())?)?
        }
        WorkerCommand::DownloadTranscriptionModel(request) => to_value(
            download_transcription_model_impl(request, print_progress)
                .map_err(|error| error.to_string())?,
        )?,
        WorkerCommand::TranscribeAudio(request) => {
            to_value(transcribe_audio_impl(request).map_err(|error| error.to_string())?)?
        }
        WorkerCommand::TranscribeAudioFile(request) => {
            to_value(transcribe_audio_file_impl(request).map_err(|error| error.to_string())?)?
        }
        WorkerCommand::CaptureMetrics(request) => {
            to_value(capture_metrics_impl(request).map_err(|error| error.to_string())?)?
        }
    };
    println!("{response}");
    Ok(())
}

fn read_command() -> Result<WorkerCommand, String> {
    let mut payload = String::new();
    io::stdin()
        .read_to_string(&mut payload)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&payload).map_err(|error| format!("invalid worker command: {error}"))
}

fn to_value(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

fn print_progress(event: TranscriptionProgressEvent) {
    if let Some(progress) = event.progress {
        eprintln!(
            "{}: {:.0}%",
            event.model.as_deref().unwrap_or("model"),
            progress * 100.0
        );
        return;
    }
    eprintln!("{}", event.message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use stutter_tracker_lib::transcription::{DevicePreference, TranscriptionProvider};

    #[test]
    fn parses_transcription_models_command() {
        let command: WorkerCommand = serde_json::from_str(
            r#"{"command":"transcription-models","request":{"provider":"whisperCpp"}}"#,
        )
        .unwrap();
        match command {
            WorkerCommand::TranscriptionModels(request) => {
                assert!(matches!(
                    request.provider,
                    TranscriptionProvider::WhisperCpp
                ));
            }
            _ => panic!("unexpected command"),
        }
    }

    #[test]
    fn rejects_unknown_command() {
        let err = serde_json::from_str::<WorkerCommand>(
            r#"{"command":"missing","request":{"provider":"whisperCpp"}}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown variant"));
    }

    #[test]
    fn parses_transcribe_audio_file_command() {
        let command: WorkerCommand = serde_json::from_str(
            r#"{"command":"transcribe-audio-file","request":{"path":"/tmp/input.m4a","provider":"whisperCpp","model":"base.en","language":"en-US"}}"#,
        )
        .unwrap();
        match command {
            WorkerCommand::TranscribeAudioFile(request) => {
                assert_eq!(request.path.to_string_lossy(), "/tmp/input.m4a");
                assert!(matches!(
                    request.provider,
                    TranscriptionProvider::WhisperCpp
                ));
                assert_eq!(request.device, DevicePreference::Auto);
            }
            _ => panic!("unexpected command"),
        }
    }

    #[test]
    fn measures_capture_metrics_of_analysis_audio() {
        let command: WorkerCommand = serde_json::from_str(
            r#"{"command":"capture-metrics","request":{"samples":[0.0,1.0,-1.0,0.5],"sampleRate":16000}}"#,
        )
        .unwrap();
        let WorkerCommand::CaptureMetrics(request) = command else {
            panic!("unexpected command");
        };
        let metrics = to_value(capture_metrics_impl(request).unwrap()).unwrap();
        assert_eq!(metrics["sampleRate"], 16000);
        assert_eq!(metrics["samplesPerChannel"], 4);
        assert_eq!(metrics["clippedSampleCount"], 2);
    }

    // #94 acceptance: `transcribe-audio-file` also measures the decoded upload with the
    // audio-analysis capture kernel, at the upload's source rate, exactly as native analysis
    // measures the same PCM (`capture_metrics_impl`). Seam contract:
    // `stutter_tracker_lib::capture::audio_file_capture_metrics(path, ffmpeg_bin)` measures an
    // audio file, and `TranscribeAudioResult::capture_metrics` carries the measurement to the
    // worker's JSON response as `captureMetrics` (omitted when the file could not be measured).
    mod file_capture_metrics {
        use super::*;
        use std::path::{Path, PathBuf};
        use std::process::Command;
        use stutter_tracker_lib::capture::audio_file_capture_metrics;
        use stutter_tracker_lib::transcription::{
            TranscribeAudioResult, TranscriptionProviderResult,
        };

        struct TempDir(PathBuf);

        impl TempDir {
            fn new(name: &str) -> Self {
                let dir = std::env::temp_dir().join(format!(
                    "stutter-file-capture-{name}-{}",
                    std::process::id()
                ));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();
                Self(dir)
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        fn write_wav(path: &Path, interleaved: &[f32], sample_rate: u32, channels: u16) {
            let spec = hound::WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let mut writer = hound::WavWriter::create(path, spec).unwrap();
            for sample in interleaved {
                writer.write_sample(*sample).unwrap();
            }
            writer.finalize().unwrap();
        }

        fn silence(sample_rate: u32, seconds: f32) -> Vec<f32> {
            vec![0.0; (sample_rate as f32 * seconds) as usize]
        }

        /// Full-scale square wave: every sample is at the clip level.
        fn clipping(sample_rate: u32, seconds: f32) -> Vec<f32> {
            (0..(sample_rate as f32 * seconds) as usize)
                .map(|index| if (index / 100) % 2 == 0 { 1.0 } else { -1.0 })
                .collect()
        }

        fn native(samples: Vec<f32>, sample_rate: u32) -> Value {
            to_value(
                capture_metrics_impl(CaptureMetricsRequest {
                    samples,
                    sample_rate,
                })
                .unwrap(),
            )
            .unwrap()
        }

        fn measured(path: &Path) -> Value {
            to_value(audio_file_capture_metrics(path, None).unwrap()).unwrap()
        }

        fn ffmpeg_encode(input: &Path, output: &Path) {
            // Needs ffmpeg on PATH, as the compute server's file transcription does.
            let status = Command::new("ffmpeg")
                .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
                .arg(input)
                .args(["-c:a", "flac"])
                .arg(output)
                .status()
                .expect("ffmpeg is required for the compressed-upload acceptance test");
            assert!(
                status.success(),
                "ffmpeg failed to encode {}",
                output.display()
            );
        }

        #[test]
        fn measures_a_silent_upload_at_its_source_rate_like_native_analysis() {
            let dir = TempDir::new("silent");
            let path = dir.0.join("recording.wav");
            let samples = silence(44_100, 4.0);
            write_wav(&path, &samples, 44_100, 1);

            let metrics = measured(&path);

            assert_eq!(metrics, native(samples, 44_100));
            assert_eq!(metrics["sampleRate"], 44_100);
            assert_eq!(metrics["samplesPerChannel"], 4 * 44_100);
            assert_eq!(metrics["clippedSampleCount"], 0);
            assert_eq!(metrics["activitySeconds"], 0.0);
            assert!(metrics["noInputSeconds"].as_f64().unwrap() > 3.9);
        }

        #[test]
        fn measures_a_clipping_upload_like_native_analysis() {
            let dir = TempDir::new("clipping");
            let path = dir.0.join("recording.wav");
            let mut samples = silence(48_000, 1.0);
            samples.extend(clipping(48_000, 3.0));
            write_wav(&path, &samples, 48_000, 1);

            let metrics = measured(&path);

            assert_eq!(metrics, native(samples, 48_000));
            assert_eq!(metrics["sampleRate"], 48_000);
            assert_eq!(metrics["clippedSampleCount"], 3 * 48_000);
            assert!(metrics["clippedSampleRatio"].as_f64().unwrap() > 0.001);
        }

        #[test]
        fn decodes_a_compressed_upload_at_its_source_rate() {
            let dir = TempDir::new("compressed");
            let wav = dir.0.join("source.wav");
            let flac = dir.0.join("recording.flac");
            let mut samples = silence(48_000, 2.0);
            samples.extend(clipping(48_000, 1.0));
            write_wav(&wav, &samples, 48_000, 1);
            ffmpeg_encode(&wav, &flac);

            let metrics = measured(&flac);
            let expected = native(samples, 48_000);

            // Not resampled to the 16 kHz transcription rate.
            assert_eq!(metrics["sampleRate"], 48_000);
            for field in [
                "samplesPerChannel",
                "durationSeconds",
                "clippedSampleCount",
                "noInputSeconds",
                "longestNoInputSeconds",
                "config",
            ] {
                assert_eq!(metrics[field], expected[field], "{field}");
            }
        }

        #[test]
        fn measures_a_stereo_upload_at_its_source_rate() {
            let dir = TempDir::new("stereo");
            let wav = dir.0.join("source.wav");
            let flac = dir.0.join("recording.flac");
            let interleaved: Vec<f32> = clipping(44_100, 3.0)
                .into_iter()
                .flat_map(|sample| [sample, sample])
                .collect();
            write_wav(&wav, &interleaved, 44_100, 2);
            ffmpeg_encode(&wav, &flac);

            let metrics = measured(&flac);

            assert_eq!(metrics["sampleRate"], 44_100);
            assert_eq!(metrics["samplesPerChannel"], 3 * 44_100);
            assert!((metrics["durationSeconds"].as_f64().unwrap() - 3.0).abs() < 1e-6);
            assert!(metrics["clippedSampleRatio"].as_f64().unwrap() > 0.001);
        }

        #[test]
        fn rejects_a_missing_or_undecodable_upload() {
            let dir = TempDir::new("invalid");
            assert!(audio_file_capture_metrics(&dir.0.join("missing.m4a"), None).is_err());
            let garbage = dir.0.join("recording.m4a");
            std::fs::write(&garbage, b"not audio").unwrap();
            assert!(audio_file_capture_metrics(&garbage, None).is_err());
        }

        #[test]
        fn file_transcription_response_carries_capture_metrics_only_when_measured() {
            let dir = TempDir::new("response");
            let path = dir.0.join("recording.wav");
            write_wav(&path, &silence(16_000, 3.0), 16_000, 1);
            let result = |capture_metrics| TranscribeAudioResult {
                text: Some(String::new()),
                language: Some("en".to_string()),
                segments: Vec::new(),
                provider: TranscriptionProviderResult::WhisperCpp,
                model: "base.en".to_string(),
                compute: None,
                capture_metrics,
            };

            let measured_response = to_value(result(Some(
                audio_file_capture_metrics(&path, None).unwrap(),
            )))
            .unwrap();
            assert_eq!(measured_response["captureMetrics"], measured(&path));

            let unmeasured = to_value(result(None)).unwrap();
            assert!(unmeasured.get("captureMetrics").is_none());
        }
    }
}
