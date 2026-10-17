use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub use audio_analysis_transcription::{WhisperCppConfig, WhisperCppModel, WhisperCppModelStore};
pub use text_transcripts::{TranscriptSegment, TranscriptionResult};

#[derive(Debug, thiserror::Error)]
pub enum TranscriptionError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid transcript: {0}")]
    InvalidTranscript(String),
    #[error("transcriber command `{0}` failed")]
    CommandFailed(String),
    #[error("{0}")]
    Transcript(#[from] text_transcripts::TranscriptionError),
    #[error("{0}")]
    WhisperCpp(#[from] audio_analysis_transcription::WhisperCppError),
}

pub type Result<T> = std::result::Result<T, TranscriptionError>;

pub trait Transcriber {
    fn transcribe(&mut self, input: &Path) -> Result<TranscriptionResult>;
}

#[derive(Debug, Clone)]
pub struct WhisperCliTranscriber {
    command: PathBuf,
    args: Vec<String>,
    output_dir: Option<PathBuf>,
}

impl WhisperCliTranscriber {
    pub fn new(command: impl Into<PathBuf>) -> Self {
        Self {
            command: command.into(),
            args: Vec::new(),
            output_dir: None,
        }
    }

    pub fn args(mut self, args: impl IntoIterator<Item = String>) -> Self {
        self.args.extend(args);
        self
    }

    pub fn output_dir(mut self, output_dir: impl Into<PathBuf>) -> Self {
        self.output_dir = Some(output_dir.into());
        self
    }
}

impl Transcriber for WhisperCliTranscriber {
    fn transcribe(&mut self, input: &Path) -> Result<TranscriptionResult> {
        let output_dir = self.output_dir.clone().unwrap_or_else(|| {
            input
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("transcript")
        });
        fs::create_dir_all(&output_dir)?;

        let status = Command::new(&self.command)
            .arg(input)
            .args(&self.args)
            .arg("--output_format")
            .arg("json")
            .arg("--output_dir")
            .arg(&output_dir)
            .stdin(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(TranscriptionError::CommandFailed(
                self.command.display().to_string(),
            ));
        }

        let transcript_path = find_transcript_json(&output_dir).ok_or_else(|| {
            TranscriptionError::InvalidTranscript(
                "transcriber completed but no JSON transcript was found".to_string(),
            )
        })?;
        let bytes = fs::read(&transcript_path)?;
        let mut result = text_transcripts::parse_whisper_json(&bytes)?;
        result.source = Some(transcript_path.to_string_lossy().into_owned());
        Ok(result)
    }
}

pub struct WhisperCppTranscriber {
    inner: audio_analysis_transcription::NativeWhisperCppTranscriber,
}

impl WhisperCppTranscriber {
    pub fn new(config: WhisperCppConfig) -> Self {
        Self {
            inner: audio_analysis_transcription::NativeWhisperCppTranscriber::new(config),
        }
    }
}

impl Transcriber for WhisperCppTranscriber {
    fn transcribe(&mut self, input: &Path) -> Result<TranscriptionResult> {
        let transcript = self.inner.transcribe_file(input)?;
        Ok(whisper_cpp_result(transcript))
    }
}

fn whisper_cpp_result(
    transcript: audio_analysis_transcription::WhisperCppTranscription,
) -> TranscriptionResult {
    let language = transcript.language.clone();
    TranscriptionResult {
        text: transcript.text,
        language: language.clone(),
        segments: transcript
            .segments
            .into_iter()
            .map(|segment| TranscriptSegment {
                index: segment.index,
                start_seconds: segment.start_seconds,
                end_seconds: segment.end_seconds,
                text: segment.text,
                language: language.clone(),
                speaker: None,
                confidence: segment.confidence,
                is_final: true,
            })
            .collect(),
        source: transcript.source,
    }
}

fn find_transcript_json(output_dir: &Path) -> Option<PathBuf> {
    let mut candidates = fs::read_dir(output_dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}
