//! GPU transcription through one persistent `native-whisperx serve` child (CUDA).
//!
//! whisper.cpp in audio-analysis is built for the CPU only, so the GPU path runs the
//! native-whisperx CLI (`STUTTER_NATIVE_WHISPERX_BIN`, else `native-whisperx` on PATH). The
//! process starts `native-whisperx serve` on its first request and keeps it: one JSON request per
//! stdin line, one answer per stdout line, in order, with the models kept loaded between requests
//! (native-whisperx#420). Requests are serialized through a mutex because the answers come back
//! strictly in order.
//!
//! [`transcribe_on_gpu`] adds the product's fallback policy. Until the GPU path has worked once in
//! this process, a failure marks it unavailable for the rest of the process, so chunked recording
//! does not pay a failed GPU attempt per chunk. Once it has worked, an error answer is about that
//! audio (for example native-whisperx#418) and only that chunk falls back to the CPU; a child that
//! exited is started again on the next request.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

/// Why the GPU path is unavailable in this process, once it failed before ever working.
static GPU_UNAVAILABLE: Mutex<Option<String>> = Mutex::new(None);
/// Whether a GPU transcription has succeeded in this process.
static GPU_WORKED: AtomicBool = AtomicBool::new(false);
/// The process's `native-whisperx serve` child, started on first use.
static SERVE: Mutex<Option<ServeChild>> = Mutex::new(None);

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

/// A successful serve answer.
#[derive(Debug, Clone, PartialEq)]
pub struct ServeAnswer {
    pub transcript: GpuTranscript,
    /// The device the ASR model ran on, from the answer's provenance (for example `cuda:0`).
    pub device: String,
    /// Time native-whisperx spent on the request.
    pub seconds: f64,
}

/// Why a serve request did not produce a transcript.
#[derive(Debug, Clone, PartialEq)]
pub enum ServeError {
    /// The child answered `{"error"}` for this request and keeps serving.
    Request(String),
    /// The child could not start, exited, or broke the protocol; it is dropped and the next
    /// request starts a new one.
    Child(String),
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServeError::Request(message) | ServeError::Child(message) => {
                formatter.write_str(message)
            }
        }
    }
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
) -> Result<ServeAnswer, String> {
    if let Some(reason) = gpu_unavailable_reason() {
        return Err(reason);
    }
    let mut args = vec![
        wav_path.to_string_lossy().into_owned(),
        "--model".to_string(),
        model.to_string(),
        "--device".to_string(),
        "cuda".to_string(),
        "--no-align".to_string(),
    ];
    if let Some(language) = language {
        args.extend(["--language".to_string(), language.to_string()]);
    }
    match serve(&args) {
        Ok(answer) => {
            GPU_WORKED.store(true, Ordering::Relaxed);
            Ok(answer)
        }
        Err(error) => {
            let reason = error.to_string();
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

/// Sends one request (`transcribe` arguments for one input) to the process's serve child,
/// starting it first when there is none.
pub fn serve(args: &[String]) -> Result<ServeAnswer, ServeError> {
    let mut slot = SERVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_none() {
        *slot = Some(ServeChild::spawn(&binary()).map_err(ServeError::Child)?);
    }
    let child = slot.as_mut().expect("serve child was just started");
    let answer = child.request(args);
    if matches!(answer, Err(ServeError::Child(_))) {
        *slot = None;
    }
    answer
}

/// Peak resident memory of the serve child so far (Linux `VmHWM`), if one is running.
pub fn serve_peak_rss_bytes() -> Option<u64> {
    let slot = SERVE.lock().ok()?;
    let pid = slot.as_ref()?.child.id();
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

fn binary() -> PathBuf {
    std::env::var_os("STUTTER_NATIVE_WHISPERX_BIN")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("native-whisperx"))
}

struct ServeChild {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// The last meaningful stderr line, for the message when the child dies.
    last_stderr: Arc<Mutex<String>>,
    next_id: u64,
}

impl ServeChild {
    fn spawn(binary: &Path) -> Result<Self, String> {
        let mut child = Command::new(binary)
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("`{} serve` could not run: {error}", binary.display()))?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
        let stderr = child.stderr.take().expect("stderr is piped");
        let last_stderr = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&last_stderr);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let line = line.trim();
                if line.is_empty() || line.starts_with("progress ") {
                    continue;
                }
                if let Ok(mut last) = sink.lock() {
                    line.clone_into(&mut last);
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            stdout,
            last_stderr,
            next_id: 0,
        })
    }

    fn request(&mut self, args: &[String]) -> Result<ServeAnswer, ServeError> {
        self.next_id += 1;
        let id = self.next_id;
        let mut line = json!({ "id": id, "args": args }).to_string();
        line.push('\n');
        if let Err(error) = self
            .stdin
            .write_all(line.as_bytes())
            .and_then(|()| self.stdin.flush())
        {
            return Err(self.died(&format!("could not take a request: {error}")));
        }
        let mut answer = String::new();
        match self.stdout.read_line(&mut answer) {
            Ok(0) => Err(self.died("closed its output")),
            Ok(_) => parse_answer(&answer, id).map_err(|error| match error {
                ServeError::Child(message) => self.died(&message),
                request => request,
            }),
            Err(error) => Err(self.died(&format!("output could not be read: {error}"))),
        }
    }

    /// Ends the child and describes why it is unusable.
    fn died(&mut self, what: &str) -> ServeError {
        let _ = self.child.kill();
        let status = self
            .child
            .wait()
            .map(|status| status.to_string())
            .unwrap_or_else(|error| error.to_string());
        let stderr = self
            .last_stderr
            .lock()
            .map(|last| last.clone())
            .unwrap_or_default();
        let detail = if stderr.is_empty() {
            "no error output".to_string()
        } else {
            stderr
        };
        ServeError::Child(format!("native-whisperx serve {what} ({status}): {detail}"))
    }
}

impl Drop for ServeChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Deserialize)]
struct Answer {
    id: Value,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    transcript: Option<JsonTranscript>,
    #[serde(default)]
    provenance: Option<Provenance>,
    #[serde(default)]
    seconds: f64,
}

#[derive(Deserialize)]
struct Provenance {
    device: String,
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

/// Parses one serve answer line for request `id`.
fn parse_answer(line: &str, id: u64) -> Result<ServeAnswer, ServeError> {
    let answer: Answer = serde_json::from_str(line)
        .map_err(|error| ServeError::Child(format!("answered invalid JSON: {error}")))?;
    if answer.id != json!(id) {
        return Err(ServeError::Child(format!(
            "answered request {} while {id} was pending",
            answer.id
        )));
    }
    if let Some(error) = answer.error {
        return Err(ServeError::Request(format!(
            "native-whisperx failed: {error}"
        )));
    }
    let (Some(transcript), Some(provenance)) = (answer.transcript, answer.provenance) else {
        return Err(ServeError::Request(
            "native-whisperx answered without a transcript or provenance".to_string(),
        ));
    };
    Ok(ServeAnswer {
        transcript: gpu_transcript(transcript),
        device: provenance.device,
        seconds: answer.seconds,
    })
}

fn gpu_transcript(parsed: JsonTranscript) -> GpuTranscript {
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
    GpuTranscript {
        text: segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        language: parsed.language.filter(|language| !language.is_empty()),
        segments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_serve_answer_with_segments_language_and_device() {
        let answer = parse_answer(
            r#"{"id":3,"transcript":{"language":"en","segments":[{"id":0,"start":0.18,"end":7.54,"text":" And they went off. "},{"start":8.0,"end":8.5,"text":"  "}],"word_segments":[]},"provenance":{"provider":"candle-whisper","modelId":"openai/whisper-base.en","device":"cuda:0"},"seconds":0.19,"outputFiles":[]}"#,
            3,
        )
        .unwrap();

        assert_eq!(answer.device, "cuda:0");
        assert_eq!(answer.seconds, 0.19);
        assert_eq!(answer.transcript.language.as_deref(), Some("en"));
        assert_eq!(
            answer.transcript.segments,
            vec![GpuSegment {
                text: "And they went off.".to_string(),
                start_seconds: 0.18,
                end_seconds: 7.54,
            }]
        );
        assert_eq!(answer.transcript.text, "And they went off.");
    }

    #[test]
    fn an_error_answer_fails_only_the_request() {
        assert_eq!(
            parse_answer(r#"{"id":1,"error":"no timestamps"}"#, 1),
            Err(ServeError::Request(
                "native-whisperx failed: no timestamps".to_string()
            ))
        );
    }

    #[test]
    fn a_broken_or_out_of_order_answer_fails_the_child() {
        assert!(matches!(
            parse_answer("not json", 1),
            Err(ServeError::Child(_))
        ));
        assert!(matches!(
            parse_answer(r#"{"id":2,"error":"x"}"#, 1),
            Err(ServeError::Child(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_exits_fails_the_child() {
        let mut child = ServeChild::spawn(Path::new("true")).unwrap();
        let error = child.request(&["a.wav".to_string()]).unwrap_err();
        assert!(matches!(error, ServeError::Child(_)), "{error:?}");
    }
}
