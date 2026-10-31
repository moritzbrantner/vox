use std::fs::{self, File};
use std::io::ErrorKind;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::speech_analysis::{analyzed_window_len, measure_analyzed_interleaved_window};
use crate::text_analysis_transcription::{
    Transcriber, TranscriptionError, TranscriptionResult, WhisperCliTranscriber, WhisperCppConfig,
    WhisperCppModel, WhisperCppModelStore, WhisperCppTranscriber,
};
use audio_analysis_core::CaptureMetrics;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TranscriptionCommandError {
    #[error("{0}")]
    Invalid(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("WAV error: {0}")]
    Wav(#[from] hound::Error),
    #[error("network error: {0}")]
    Network(String),
    #[error("{0}")]
    Transcription(#[from] crate::text_analysis_transcription::TranscriptionError),
}

type Result<T> = std::result::Result<T, TranscriptionCommandError>;

static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAudioRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub provider: TranscriptionProvider,
    pub model: String,
    pub language: Option<String>,
    #[serde(default)]
    pub device: DevicePreference,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAudioFileRequest {
    pub path: PathBuf,
    pub provider: TranscriptionProvider,
    pub model: String,
    pub language: Option<String>,
    pub ffmpeg_bin: Option<String>,
    #[serde(default)]
    pub device: DevicePreference,
}

/// Where whisper.cpp-engine transcription may run. `Auto` uses the GPU when one is usable and
/// falls back to the CPU; `Cpu` never tries the GPU.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DevicePreference {
    #[default]
    Auto,
    Cpu,
}

/// The runtime that produced a transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputeBackend {
    /// native-whisperx (Candle) on CUDA.
    NativeWhisperx,
    /// whisper.cpp from audio-analysis.
    WhisperCpp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputeDevice {
    Cuda,
    Cpu,
}

/// Which backend and device transcribed the audio, and why the GPU was not used when it was
/// allowed but unavailable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionCompute {
    pub backend: ComputeBackend,
    pub device: ComputeDevice,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelsRequest {
    pub provider: TranscriptionProvider,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTranscriptionModelRequest {
    pub provider: TranscriptionProvider,
    pub model: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptionProvider {
    Browser,
    WhisperCpp,
    WhisperCli,
    FasterWhisper,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelsResult {
    pub provider: TranscriptionProviderResult,
    pub models: Vec<TranscriptionModelStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelStatus {
    pub id: String,
    pub label: String,
    pub cached: bool,
    pub downloadable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAudioResult {
    pub text: Option<String>,
    pub language: Option<String>,
    pub segments: Vec<TranscribedSegment>,
    pub provider: TranscriptionProviderResult,
    pub model: String,
    /// Backend and device of the whisper.cpp engine; absent for external CLI engines, whose
    /// device this app does not choose.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compute: Option<TranscriptionCompute>,
    /// audio-analysis capture observations of the decoded upload (file transcription only),
    /// measured as native analysis measures its audio. Absent when the file could not be measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_metrics: Option<CaptureMetrics>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptionProviderResult {
    Browser,
    WhisperCpp,
    WhisperCli,
    FasterWhisper,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribedSegment {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub confidence: Option<f32>,
    pub is_final: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProgressEvent {
    pub phase: String,
    pub message: String,
    pub model: Option<String>,
    pub progress: Option<f32>,
}

/// Where a whisper.cpp model is stored on this device (present or not).
pub fn whisper_cpp_model_path(model: &str) -> Result<PathBuf> {
    Ok(WhisperCppModelStore::default().model_path(parse_whisper_cpp_model(model)?))
}

pub fn transcription_models_impl(
    request: TranscriptionModelsRequest,
) -> Result<TranscriptionModelsResult> {
    Ok(match request.provider {
        TranscriptionProvider::Browser => TranscriptionModelsResult {
            provider: TranscriptionProviderResult::Browser,
            models: vec![model_status("default", true, false)],
        },
        TranscriptionProvider::WhisperCpp => {
            let store = WhisperCppModelStore::default();
            TranscriptionModelsResult {
                provider: TranscriptionProviderResult::WhisperCpp,
                models: WhisperCppModel::ALL
                    .into_iter()
                    .map(|model| TranscriptionModelStatus {
                        id: model.id().to_string(),
                        label: model.id().to_string(),
                        cached: store.model_path(model).is_file(),
                        downloadable: true,
                    })
                    .collect(),
            }
        }
        TranscriptionProvider::WhisperCli => TranscriptionModelsResult {
            provider: TranscriptionProviderResult::WhisperCli,
            models: ["tiny", "base", "small", "medium", "large", "turbo"]
                .into_iter()
                .map(|model| model_status(model, false, false))
                .collect(),
        },
        TranscriptionProvider::FasterWhisper => TranscriptionModelsResult {
            provider: TranscriptionProviderResult::FasterWhisper,
            models: [
                "tiny",
                "base",
                "small",
                "medium",
                "large-v3",
                "distil-large-v3",
            ]
            .into_iter()
            .map(|model| model_status(model, false, false))
            .collect(),
        },
    })
}

pub fn download_transcription_model_impl<F>(
    request: DownloadTranscriptionModelRequest,
    mut emit: F,
) -> Result<TranscriptionModelStatus>
where
    F: FnMut(TranscriptionProgressEvent),
{
    if !matches!(request.provider, TranscriptionProvider::WhisperCpp) {
        return Err(TranscriptionCommandError::Invalid(
            "only whisper.cpp models can be downloaded by this app".to_string(),
        ));
    }

    let model = parse_whisper_cpp_model(&request.model)?;
    let store = WhisperCppModelStore::default();
    fs::create_dir_all(store.models_dir())?;
    let model_path = store.model_path(model);
    if model_path.is_file() {
        return Ok(TranscriptionModelStatus {
            id: model.id().to_string(),
            label: model.id().to_string(),
            cached: true,
            downloadable: true,
        });
    }

    emit(TranscriptionProgressEvent {
        phase: "downloading".to_string(),
        message: format!("Downloading `{}`", model.id()),
        model: Some(model.id().to_string()),
        progress: Some(0.0),
    });

    let temp_path = model_path.with_extension("bin.part");
    let _ = fs::remove_file(&temp_path);
    let response = ureq::get(&model.download_url())
        .call()
        .map_err(|error| TranscriptionCommandError::Network(error.to_string()))?;
    let total_bytes = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    let mut reader = response.into_reader();
    let mut writer = BufWriter::new(File::create(&temp_path)?);
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| TranscriptionCommandError::Network(error.to_string()))?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        downloaded += read as u64;
        let progress = total_bytes.map(|total| (downloaded as f32 / total as f32).clamp(0.0, 1.0));
        emit(TranscriptionProgressEvent {
            phase: "downloading".to_string(),
            message: format!("Downloading `{}`", model.id()),
            model: Some(model.id().to_string()),
            progress,
        });
    }
    writer.flush()?;

    let checksum: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if checksum != model.checksum_sha256() {
        let _ = fs::remove_file(&temp_path);
        return Err(TranscriptionCommandError::Invalid(format!(
            "downloaded model `{}` failed checksum verification",
            model.id()
        )));
    }

    fs::rename(temp_path, &model_path)?;
    emit(TranscriptionProgressEvent {
        phase: "ready".to_string(),
        message: format!("Model `{}` is ready", model.id()),
        model: Some(model.id().to_string()),
        progress: Some(1.0),
    });

    Ok(TranscriptionModelStatus {
        id: model.id().to_string(),
        label: model.id().to_string(),
        cached: true,
        downloadable: true,
    })
}

pub fn transcribe_audio_impl(request: TranscribeAudioRequest) -> Result<TranscribeAudioResult> {
    validate_samples(&request.samples, request.sample_rate)?;
    let temp_dir = temp_transcription_dir()?;
    let transcribed = transcribe_with_temp_dir(&request, &temp_dir);
    let _ = fs::remove_dir_all(&temp_dir);
    transcribed
}

pub fn transcribe_audio_file_impl(
    request: TranscribeAudioFileRequest,
) -> Result<TranscribeAudioResult> {
    validate_input_file(&request.path)?;
    let temp_dir = temp_transcription_dir()?;
    let transcribed = transcribe_with_input_path(
        request.provider,
        &request.model,
        request.language.as_deref(),
        request.device,
        &request.path,
        &temp_dir,
        request.ffmpeg_bin.as_deref(),
    );
    let _ = fs::remove_dir_all(&temp_dir);
    let mut transcribed = transcribed?;
    // A file that cannot be measured is still transcribed; clients then show the capture as
    // unchecked rather than failing the upload.
    transcribed.capture_metrics =
        match audio_file_capture_metrics(&request.path, request.ffmpeg_bin.as_deref()) {
            Ok(metrics) => Some(metrics),
            Err(error) => {
                eprintln!("capture metrics unavailable: {error}");
                None
            }
        };
    Ok(transcribed)
}

/// Measures an audio file with the audio-analysis capture kernel, as native analysis measures
/// its audio (same kernel, configuration and window length), at the file's own sample rate and
/// channel layout. A file longer than the analyzed window is measured over its last
/// `ANALYZED_AUDIO_SECONDS`, the part a partial-coverage note names. WAV files are read directly;
/// other formats are decoded with ffmpeg (`ffmpeg_bin`, `STUTTER_FFMPEG_BIN` or `ffmpeg` on PATH)
/// without resampling or downmixing.
pub fn audio_file_capture_metrics(path: &Path, ffmpeg_bin: Option<&str>) -> Result<CaptureMetrics> {
    validate_input_file(path)?;
    let direct = if has_wav_extension(path) {
        read_wav_tail(path).ok()
    } else {
        None
    };
    let (samples, sample_rate, channels) = match direct {
        Some(decoded) => decoded,
        None => {
            let temp_dir = temp_transcription_dir()?;
            let decoded = decode_to_float_wav(path, &temp_dir, ffmpeg_bin)
                .and_then(|wav_path| read_wav_tail(&wav_path));
            let _ = fs::remove_dir_all(&temp_dir);
            decoded?
        }
    };
    measure_analyzed_interleaved_window(&samples, sample_rate, channels)
        .map_err(|error| TranscriptionCommandError::Invalid(error.to_string()))
}

/// Interleaved samples of the last analyzed window of a WAV file, normalized to [-1, 1].
fn read_wav_tail(path: &Path) -> Result<(Vec<f32>, u32, u16)> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Err(TranscriptionCommandError::Invalid(format!(
            "audio file `{}` has no samples",
            path.display()
        )));
    }
    let window = analyzed_window_len(spec.sample_rate, spec.channels);
    let window_frames = window / usize::from(spec.channels);
    let frames = reader.duration() as usize;
    if frames > window_frames {
        reader.seek((frames - window_frames) as u32)?;
    }
    let samples = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .take(window)
            .collect::<std::result::Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 2f32.powi(i32::from(spec.bits_per_sample) - 1);
            reader
                .into_samples::<i32>()
                .take(window)
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    // A truncated file can end mid-frame; measure whole sample frames only.
    let whole = samples.len() - samples.len() % usize::from(spec.channels);
    let mut samples = samples;
    samples.truncate(whole);
    Ok((samples, spec.sample_rate, spec.channels))
}

/// Decodes the end of `input_path` (slightly more than the analyzed window) to 32-bit float WAV
/// at its source rate and channel layout.
fn decode_to_float_wav(
    input_path: &Path,
    temp_dir: &Path,
    ffmpeg_bin: Option<&str>,
) -> Result<PathBuf> {
    let wav_path = temp_dir.join("capture.wav");
    let binary = ffmpeg_binary(ffmpeg_bin);
    let output = Command::new(&binary)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-sseof",
        ])
        .arg(DECODED_TAIL_SECONDS_ARG)
        .arg("-i")
        .arg(input_path)
        .args(["-vn", "-c:a", "pcm_f32le", "-f", "wav"])
        .arg(&wav_path)
        .output()
        .map_err(|error| {
            TranscriptionCommandError::Invalid(format!(
                "`{binary}` is required to measure non-WAV audio: {error}"
            ))
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TranscriptionCommandError::Invalid(format!(
            "`{binary}` failed to decode audio for measurement: {}",
            stderr.trim()
        )));
    }
    Ok(wav_path)
}

/// ffmpeg seeks this far before the end of the input (the whole input when it is shorter);
/// `read_wav_tail` then cuts the analyzed window exactly.
const DECODED_TAIL_SECONDS_ARG: &str = "-91";

fn has_wav_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("wav"))
}

fn ffmpeg_binary(ffmpeg_bin: Option<&str>) -> String {
    ffmpeg_bin
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("STUTTER_FFMPEG_BIN").ok())
        .unwrap_or_else(|| "ffmpeg".to_string())
}

fn transcribe_with_temp_dir(
    request: &TranscribeAudioRequest,
    temp_dir: &Path,
) -> Result<TranscribeAudioResult> {
    let wav_path = temp_dir.join("input.wav");
    write_mono_wav(&wav_path, &request.samples, request.sample_rate)?;

    transcribe_with_input_path(
        request.provider,
        &request.model,
        request.language.as_deref(),
        request.device,
        &wav_path,
        temp_dir,
        None,
    )
}

fn transcribe_with_input_path(
    provider: TranscriptionProvider,
    model: &str,
    language: Option<&str>,
    device: DevicePreference,
    input_path: &Path,
    temp_dir: &Path,
    ffmpeg_bin: Option<&str>,
) -> Result<TranscribeAudioResult> {
    let language = normalize_language(language);
    let model = model.trim().to_string();
    Ok(match provider {
        TranscriptionProvider::Browser => {
            return Err(TranscriptionCommandError::Invalid(
                "browser transcription runs in the web view".to_string(),
            ));
        }
        TranscriptionProvider::WhisperCpp => {
            let wav_path = whisper_cpp_input_path(input_path, temp_dir, ffmpeg_bin)?;
            let parsed_model = parse_whisper_cpp_model(&model)?;
            let gpu_unavailable_reason = match device {
                DevicePreference::Cpu => None,
                DevicePreference::Auto => match crate::native_whisperx::transcribe_on_gpu(
                    &wav_path,
                    parsed_model.id(),
                    language.as_deref(),
                    temp_dir,
                ) {
                    Ok(transcript) => return Ok(gpu_result(transcript, parsed_model)),
                    Err(reason) => Some(reason),
                },
            };
            let store = WhisperCppModelStore::default();
            if !store.model_path(parsed_model).is_file() {
                download_transcription_model_impl(
                    DownloadTranscriptionModelRequest {
                        provider: TranscriptionProvider::WhisperCpp,
                        model: parsed_model.id().to_string(),
                    },
                    |_| {},
                )?;
            }
            let mut transcriber = WhisperCppTranscriber::new(WhisperCppConfig {
                model: parsed_model,
                language,
                translate: false,
                threads: None,
            });
            let result = transcriber.transcribe(&wav_path)?;
            TranscribeAudioResult {
                compute: Some(TranscriptionCompute {
                    backend: ComputeBackend::WhisperCpp,
                    device: ComputeDevice::Cpu,
                    gpu_unavailable_reason,
                }),
                ..build_result(
                    result,
                    TranscriptionProviderResult::WhisperCpp,
                    parsed_model.id().to_string(),
                )
            }
        }
        TranscriptionProvider::WhisperCli => {
            let mut transcriber = WhisperCliTranscriber::new("whisper")
                .args(cli_args(&model, language.as_deref()))
                .output_dir(temp_dir.join("whisper-output"));
            let result = transcriber
                .transcribe(input_path)
                .map_err(|error| cli_transcription_error("whisper", error))?;
            build_result(result, TranscriptionProviderResult::WhisperCli, model)
        }
        TranscriptionProvider::FasterWhisper => {
            let mut transcriber = WhisperCliTranscriber::new("faster-whisper")
                .args(cli_args(&model, language.as_deref()))
                .output_dir(temp_dir.join("faster-whisper-output"));
            let result = transcriber
                .transcribe(input_path)
                .map_err(|error| cli_transcription_error("faster-whisper", error))?;
            build_result(result, TranscriptionProviderResult::FasterWhisper, model)
        }
    })
}

fn cli_transcription_error(command: &str, error: TranscriptionError) -> TranscriptionCommandError {
    match error {
        TranscriptionError::Io(error) if error.kind() == ErrorKind::NotFound => {
            TranscriptionCommandError::Invalid(format!(
                "`{command}` was not found on PATH. Install it, or switch the transcription engine to whisper.cpp."
            ))
        }
        other => other.into(),
    }
}

fn validate_input_file(path: &Path) -> Result<()> {
    if !path.is_file() {
        return Err(TranscriptionCommandError::Invalid(format!(
            "audio file `{}` does not exist",
            path.display()
        )));
    }
    Ok(())
}

fn whisper_cpp_input_path<'a>(
    input_path: &'a Path,
    temp_dir: &'a Path,
    ffmpeg_bin: Option<&str>,
) -> Result<PathBuf> {
    if has_wav_extension(input_path) {
        return Ok(input_path.to_path_buf());
    }

    let wav_path = temp_dir.join("input.wav");
    let binary = ffmpeg_binary(ffmpeg_bin);
    let output = Command::new(&binary)
        .arg("-y")
        .arg("-i")
        .arg(input_path)
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg(&wav_path)
        .output()
        .map_err(|error| {
            TranscriptionCommandError::Invalid(format!(
                "`{binary}` is required to transcribe non-WAV audio with whisper.cpp: {error}"
            ))
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TranscriptionCommandError::Invalid(format!(
            "`{binary}` failed to convert audio to WAV: {}",
            stderr.trim()
        )));
    }
    Ok(wav_path)
}

fn validate_samples(samples: &[f32], sample_rate: u32) -> Result<()> {
    if sample_rate == 0 {
        return Err(TranscriptionCommandError::Invalid(
            "sample rate must be greater than zero".to_string(),
        ));
    }
    if samples.len() < sample_rate as usize / 2 {
        return Err(TranscriptionCommandError::Invalid(
            "at least 500ms of audio samples are required".to_string(),
        ));
    }
    if !samples.iter().all(|sample| sample.is_finite()) {
        return Err(TranscriptionCommandError::Invalid(
            "audio samples must be finite".to_string(),
        ));
    }
    Ok(())
}

fn model_status(model: &str, cached: bool, downloadable: bool) -> TranscriptionModelStatus {
    TranscriptionModelStatus {
        id: model.to_string(),
        label: model.to_string(),
        cached,
        downloadable,
    }
}

fn build_result(
    result: TranscriptionResult,
    provider: TranscriptionProviderResult,
    model: String,
) -> TranscribeAudioResult {
    let segments = result
        .segments
        .into_iter()
        .enumerate()
        .map(|(index, segment)| {
            let start_seconds = segment.start_seconds.unwrap_or(index as f64 * 2.0);
            let end_seconds = segment
                .end_seconds
                .unwrap_or_else(|| (start_seconds + 2.0).max(start_seconds));
            TranscribedSegment {
                text: segment.text.trim().to_string(),
                start_seconds,
                end_seconds,
                confidence: segment.confidence,
                is_final: true,
            }
        })
        .filter(|segment| !segment.text.is_empty())
        .collect();
    TranscribeAudioResult {
        text: result.text,
        language: result.language,
        segments,
        provider,
        model,
        compute: None,
        capture_metrics: None,
    }
}

/// A whisper.cpp-engine result transcribed by native-whisperx on the GPU. The model is the same
/// Whisper checkpoint (native-whisperx loads its safetensors), so the engine and model ids stay.
fn gpu_result(
    transcript: crate::native_whisperx::GpuTranscript,
    model: WhisperCppModel,
) -> TranscribeAudioResult {
    TranscribeAudioResult {
        text: Some(transcript.text),
        language: transcript.language,
        segments: transcript
            .segments
            .into_iter()
            .map(|segment| TranscribedSegment {
                text: segment.text,
                start_seconds: segment.start_seconds,
                end_seconds: segment.end_seconds,
                confidence: None,
                is_final: true,
            })
            .collect(),
        provider: TranscriptionProviderResult::WhisperCpp,
        model: model.id().to_string(),
        compute: Some(TranscriptionCompute {
            backend: ComputeBackend::NativeWhisperx,
            device: ComputeDevice::Cuda,
            gpu_unavailable_reason: None,
        }),
        capture_metrics: None,
    }
}

fn cli_args(model: &str, language: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if !model.is_empty() && model != "default" {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(language) = language {
        args.push("--language".to_string());
        args.push(language.to_string());
    }
    args
}

fn parse_whisper_cpp_model(value: &str) -> Result<WhisperCppModel> {
    match value.trim() {
        "tiny.en" => Ok(WhisperCppModel::TinyEn),
        "tiny" => Ok(WhisperCppModel::Tiny),
        "base.en" | "" | "default" => Ok(WhisperCppModel::BaseEn),
        "base" => Ok(WhisperCppModel::Base),
        "small.en" => Ok(WhisperCppModel::SmallEn),
        "small" => Ok(WhisperCppModel::Small),
        "medium.en" => Ok(WhisperCppModel::MediumEn),
        "medium" => Ok(WhisperCppModel::Medium),
        "large-v1" => Ok(WhisperCppModel::LargeV1),
        "large-v2" => Ok(WhisperCppModel::LargeV2),
        "large-v3" => Ok(WhisperCppModel::LargeV3),
        "large-v3-turbo" => Ok(WhisperCppModel::LargeV3Turbo),
        other => Err(TranscriptionCommandError::Invalid(format!(
            "unsupported whisper.cpp model `{other}`"
        ))),
    }
}

fn normalize_language(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("auto") {
        return None;
    }
    value
        .split(['-', '_'])
        .next()
        .map(str::to_lowercase)
        .filter(|value| !value.is_empty())
}

fn temp_transcription_dir() -> Result<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let counter = TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
    for attempt in 0..100 {
        let dir = std::env::temp_dir().join(format!(
            "stutter-tracker-transcription-{}-{nanos}-{counter}-{attempt}",
            std::process::id()
        ));
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(TranscriptionCommandError::Invalid(
        "could not create a unique transcription temp directory".to_string(),
    ))
}

fn write_mono_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec)?;
    for sample in samples {
        writer.write_sample(sample.clamp(-1.0, 1.0))?;
    }
    writer.finalize()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_request_rejects_missing_path() {
        let error = transcribe_audio_file_impl(TranscribeAudioFileRequest {
            path: PathBuf::from("/tmp/stutter-tracker-missing-input.wav"),
            provider: TranscriptionProvider::WhisperCpp,
            model: "base.en".to_string(),
            language: None,
            ffmpeg_bin: None,
            device: DevicePreference::Auto,
        })
        .unwrap_err();

        assert!(error.to_string().contains("does not exist"));
    }

    #[test]
    fn whisper_cpp_uses_wav_path_directly() {
        let dir = temp_transcription_dir().unwrap();
        let wav = dir.join("input.wav");
        fs::write(&wav, b"not a real wav").unwrap();

        let selected =
            whisper_cpp_input_path(&wav, &dir, Some("/definitely/missing/ffmpeg")).unwrap();

        assert_eq!(selected, wav);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cli_missing_command_reports_actionable_error() {
        let error = cli_transcription_error(
            "whisper",
            TranscriptionError::Io(std::io::Error::from(ErrorKind::NotFound)),
        );

        let message = error.to_string();
        assert!(message.contains("`whisper` was not found on PATH"));
        assert!(message.contains("whisper.cpp"));
    }

    #[test]
    fn file_capture_metrics_measure_the_last_analyzed_window_of_a_long_wav() {
        let dir = temp_transcription_dir().unwrap();
        let wav = dir.join("long.wav");
        let sample_rate = 1_000;
        // 10 s of full-scale clipping, then 90 s of silence: only the last 90 s are measured.
        let mut samples = vec![1.0_f32; 10 * sample_rate as usize];
        samples.extend(vec![0.0_f32; 90 * sample_rate as usize]);
        write_mono_wav(&wav, &samples, sample_rate).unwrap();

        let metrics = audio_file_capture_metrics(&wav, Some("/definitely/missing/ffmpeg")).unwrap();

        assert_eq!(metrics.samples_per_channel, 90 * sample_rate as usize);
        assert_eq!(metrics.clipped_sample_count, 0);
        assert!((metrics.no_input_seconds - 90.0).abs() < 1e-9);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn file_capture_metrics_normalize_integer_wav() {
        let dir = temp_transcription_dir().unwrap();
        let wav = dir.join("int16.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 8_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&wav, spec).unwrap();
        for index in 0..8_000 * 2 {
            writer
                .write_sample(if index % 2 == 0 { i16::MAX } else { 0 })
                .unwrap();
        }
        writer.finalize().unwrap();

        let metrics = audio_file_capture_metrics(&wav, Some("/definitely/missing/ffmpeg")).unwrap();

        assert_eq!(metrics.channels, 2);
        assert_eq!(metrics.samples_per_channel, 8_000);
        assert_eq!(metrics.clipped_sample_count, 8_000);
        assert!((metrics.clipped_sample_ratio - 0.5).abs() < 1e-12);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn temp_transcription_dirs_are_unique() {
        let first = temp_transcription_dir().unwrap();
        let second = temp_transcription_dir().unwrap();

        assert_ne!(first, second);
        assert!(first.is_dir());
        assert!(second.is_dir());

        let _ = fs::remove_dir_all(first);
        let _ = fs::remove_dir_all(second);
    }
}
