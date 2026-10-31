//! GPU transcription through the native-whisperx CLI (CUDA).
//!
//! whisper.cpp in audio-analysis is built for the CPU only, so the GPU path runs the
//! native-whisperx CLI (`STUTTER_NATIVE_WHISPERX_BIN`, else `native-whisperx` on PATH) with
//! `--device cuda`. When the binary is missing, was built without CUDA or finds no usable GPU,
//! the caller falls back to whisper.cpp on the CPU.
//!
//! Until the GPU path has worked once in this process, a failure marks it unavailable for the
//! rest of the process, so chunked recording does not pay a failed GPU attempt per chunk. Once it
//! has worked, a failure is about that audio (for example native-whisperx#418) and only that
//! call falls back to the CPU.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Deserialize;

/// Why the GPU path is unavailable in this process, once it failed before ever working.
static GPU_UNAVAILABLE: Mutex<Option<String>> = Mutex::new(None);
/// Whether a GPU transcription has succeeded in this process.
static GPU_WORKED: AtomicBool = AtomicBool::new(false);

/// One native-whisperx segment.
#[derive(Debug, Clone, PartialEq)]
pub struct GpuSegment {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GpuTranscript {
    pub text: String,
    pub language: Option<String>,
    pub segments: Vec<GpuSegment>,
}

/// The reason an earlier GPU attempt in this process failed, if one did.
pub fn gpu_unavailable_reason() -> Option<String> {
    GPU_UNAVAILABLE
        .lock()
        .ok()
        .and_then(|reason| reason.clone())
}

/// Transcribes a 16 kHz mono WAV on the GPU, or returns why it did not.
pub fn transcribe_on_gpu(
    wav_path: &Path,
    model: &str,
    language: Option<&str>,
    temp_dir: &Path,
) -> Result<GpuTranscript, String> {
    if let Some(reason) = gpu_unavailable_reason() {
        return Err(reason);
    }
    match run(wav_path, model, language, temp_dir) {
        Ok(transcript) => {
            GPU_WORKED.store(true, Ordering::Relaxed);
            Ok(transcript)
        }
        Err(reason) => {
            eprintln!("GPU transcription failed, using whisper.cpp on the CPU: {reason}");
            if !GPU_WORKED.load(Ordering::Relaxed) {
                if let Ok(mut slot) = GPU_UNAVAILABLE.lock() {
                    *slot = Some(reason.clone());
                }
            }
            Err(reason)
        }
    }
}

fn binary() -> PathBuf {
    std::env::var_os("STUTTER_NATIVE_WHISPERX_BIN")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("native-whisperx"))
}

fn run(
    wav_path: &Path,
    model: &str,
    language: Option<&str>,
    temp_dir: &Path,
) -> Result<GpuTranscript, String> {
    let binary = binary();
    let output_dir = temp_dir.join("native-whisperx-output");
    let output = Command::new(&binary)
        .arg("transcribe")
        .arg(wav_path)
        .args(["--model", model, "--device", "cuda", "--no-align"])
        .args(
            language
                .into_iter()
                .flat_map(|language| ["--language", language]),
        )
        .args([
            "--format",
            "json",
            "--basename",
            "transcript",
            "--output-dir",
        ])
        .arg(&output_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("`{}` could not run: {error}", binary.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty() && !line.starts_with("progress "))
            .unwrap_or("no error output")
            .trim();
        return Err(format!(
            "native-whisperx failed ({}): {detail}",
            output.status
        ));
    }
    let json_path = output_dir.join("transcript.json");
    let text = std::fs::read_to_string(&json_path)
        .map_err(|error| format!("{}: {error}", json_path.display()))?;
    parse_transcript(&text)
}

#[derive(Deserialize)]
struct JsonTranscript {
    #[serde(default)]
    language: Option<String>,
    segments: Vec<JsonSegment>,
}

#[derive(Deserialize)]
struct JsonSegment {
    start: f64,
    end: f64,
    #[serde(default)]
    text: String,
}

/// Parses native-whisperx `--format json` output (WhisperX JSON).
fn parse_transcript(json: &str) -> Result<GpuTranscript, String> {
    let parsed: JsonTranscript = serde_json::from_str(json)
        .map_err(|error| format!("native-whisperx JSON is invalid: {error}"))?;
    let segments: Vec<GpuSegment> = parsed
        .segments
        .into_iter()
        .map(|segment| GpuSegment {
            text: segment.text.trim().to_string(),
            start_seconds: segment.start,
            end_seconds: segment.end,
        })
        .filter(|segment| !segment.text.is_empty())
        .collect();
    Ok(GpuTranscript {
        text: segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        language: parsed.language.filter(|language| !language.is_empty()),
        segments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whisperx_json_segments_and_language() {
        let transcript = parse_transcript(
            r#"{"language":"en","segments":[{"id":0,"start":0.18,"end":7.54,"text":" And they went off. "},{"start":8.0,"end":8.5,"text":"  "}],"text":"ignored","word_segments":[]}"#,
        )
        .unwrap();

        assert_eq!(transcript.language.as_deref(), Some("en"));
        assert_eq!(
            transcript.segments,
            vec![GpuSegment {
                text: "And they went off.".to_string(),
                start_seconds: 0.18,
                end_seconds: 7.54,
            }]
        );
        assert_eq!(transcript.text, "And they went off.");
    }

    #[test]
    fn rejects_output_without_segments() {
        assert!(parse_transcript(r#"{"language":"en"}"#).is_err());
    }
}
