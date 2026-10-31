//! Speech/non-speech evidence for the recording and review views (audio-analysis#151).
//!
//! Voice activity comes from audio-analysis' Silero VAD, never from RMS: the live path feeds the
//! recorder's chunks through `SileroVadStream`, the finite path runs the Silero provider over the
//! whole capture after Stop. Both resample the recorder's mono PCM to 16 kHz with the same
//! [`LinearResampler`], which gives the same samples in any chunking, so finalized live spans and
//! finite spans of the same capture can be compared exactly. Capture health (clipping, no input,
//! RMS activity) is measured separately with audio-analysis' capture meter at the source rate; it
//! says that there was sound, not that anyone spoke.
//!
//! No model is downloaded: Silero runs only when a local model file exists
//! (`VOX_SILERO_VAD_MODEL`, or `silero-vad/silero_vad.onnx` next to the whisper.cpp models) and
//! ONNX Runtime loads. Otherwise every result says `unavailable` with the reason. Speaker identity
//! is never inferred: every span is unattributed speech.

use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use audio_analysis_core::{CaptureMetrics, CaptureMetricsConfig, CaptureMetricsMeter};
use audio_analysis_transcription::{
    FinalizedSpeechSpan, SileroVadOptions, SileroVadStream, SileroVadTranscriptionProvider,
    SpeakerAudio, SpeechSpan, VadOptions, VoiceActivityDetector, WhisperCppModelStore,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Sample rate Silero runs at.
pub const VAD_SAMPLE_RATE: u32 = 16_000;
/// Environment variable naming a local Silero ONNX model.
pub const SILERO_MODEL_ENV: &str = "VOX_SILERO_VAD_MODEL";

// Silero's own `get_speech_timestamps` defaults (also WhisperX's), not tuned by vox.
const THRESHOLD: f32 = 0.5;
const MIN_SPEECH_MS: usize = 250;
const MIN_SILENCE_MS: usize = 100;
const SPEECH_PAD_MS: usize = 30;
const MAX_SPEECH_SECONDS: f64 = 30.0;

/// The provider, model and configuration that produced a result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VadProvider {
    pub id: String,
    pub model: String,
    pub model_sha256: String,
    pub threshold: f32,
    pub min_speech_ms: usize,
    pub min_silence_ms: usize,
    pub speech_pad_ms: usize,
    pub max_speech_seconds: f64,
    pub sample_rate: u32,
    /// How recorder audio reaches `sample_rate`.
    pub resampling: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VadStatus {
    /// Silero ran over the audio.
    Detected,
    /// No local model or ONNX Runtime: no speech evidence at all (not "no speech").
    Unavailable,
    /// Silero failed part-way; nothing after the failure is known.
    Failed,
    /// Live only: chunks arrived out of order or were missing, so detection stopped.
    Interrupted,
}

/// Linear interpolation from `source_rate` to 16 kHz with exact integer positions: output `k` is
/// at source position `k × source / 16000`. Pushing the same samples in any chunking yields the
/// same output; `finish` emits the tail, holding the last sample where the next is missing.
#[derive(Debug, Clone)]
pub struct LinearResampler {
    source_rate: u64,
    /// Source samples received.
    received: u64,
    /// Outputs emitted.
    emitted: u64,
    /// Source samples from index `base` on that later outputs may still read (at most two).
    tail: Vec<f32>,
    base: u64,
}

impl LinearResampler {
    pub fn new(source_rate: u32) -> Result<Self, String> {
        if source_rate == 0 {
            return Err("sample rate must be positive".to_string());
        }
        Ok(Self {
            source_rate: u64::from(source_rate),
            received: 0,
            emitted: 0,
            tail: Vec::new(),
            base: 0,
        })
    }

    pub fn push(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        self.tail.extend_from_slice(samples);
        self.received += samples.len() as u64;
        self.emit(false, out);
    }

    pub fn finish(&mut self, out: &mut Vec<f32>) {
        self.emit(true, out);
    }

    fn emit(&mut self, finishing: bool, out: &mut Vec<f32>) {
        let target = u64::from(VAD_SAMPLE_RATE);
        loop {
            let position = self.emitted * self.source_rate;
            let index = position / target;
            let fraction = position % target;
            if index >= self.received {
                break;
            }
            let needs_next = fraction != 0;
            if needs_next && index + 1 >= self.received && !finishing {
                break;
            }
            let at = |i: u64| self.tail[(i - self.base) as usize];
            let value = if needs_next && index + 1 < self.received {
                let weight = fraction as f64 / target as f64;
                (f64::from(at(index)) * (1.0 - weight) + f64::from(at(index + 1)) * weight) as f32
            } else {
                at(index)
            };
            out.push(value);
            self.emitted += 1;
        }
        // Keep only what the next output can read.
        let next_index = (self.emitted * self.source_rate / target).min(self.received);
        let drop = (next_index - self.base) as usize;
        self.tail.drain(..drop);
        self.base = next_index;
    }
}

/// Resamples a whole buffer exactly as the live path does chunk by chunk.
pub fn resample_to_vad_rate(samples: &[f32], source_rate: u32) -> Result<Vec<f32>, String> {
    let mut resampler = LinearResampler::new(source_rate)?;
    let mut out = Vec::with_capacity(
        (samples.len() as u64 * u64::from(VAD_SAMPLE_RATE) / u64::from(source_rate)) as usize + 1,
    );
    resampler.push(samples, &mut out);
    resampler.finish(&mut out);
    Ok(out)
}

fn default_model_path() -> PathBuf {
    WhisperCppModelStore::default()
        .models_dir()
        .join("silero-vad")
        .join("silero_vad.onnx")
}

fn model_path() -> PathBuf {
    std::env::var_os(SILERO_MODEL_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(default_model_path)
}

fn silero_options(model_path: &Path) -> SileroVadOptions {
    SileroVadOptions {
        model_path: model_path.to_path_buf(),
        input_name: None,
        output_name: None,
        threshold: THRESHOLD,
        max_speech_duration_seconds: MAX_SPEECH_SECONDS,
        min_speech_duration_ms: MIN_SPEECH_MS,
        min_silence_duration_ms: MIN_SILENCE_MS,
        speech_pad_ms: SPEECH_PAD_MS,
    }
}

/// The provider identity of the local model, or why Silero is unavailable.
fn provider_for(model_path: &Path) -> Result<VadProvider, String> {
    let bytes = fs::read(model_path).map_err(|error| {
        format!(
            "no Silero VAD model at {} ({error}); set {SILERO_MODEL_ENV} to a local silero_vad.onnx",
            model_path.display()
        )
    })?;
    Ok(VadProvider {
        id: "silero-vad".to_string(),
        model: model_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        model_sha256: hex(&Sha256::digest(&bytes)),
        threshold: THRESHOLD,
        min_speech_ms: MIN_SPEECH_MS,
        min_silence_ms: MIN_SILENCE_MS,
        speech_pad_ms: SPEECH_PAD_MS,
        max_speech_seconds: MAX_SPEECH_SECONDS,
        sample_rate: VAD_SAMPLE_RATE,
        resampling: "linear".to_string(),
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Loading ONNX Runtime dynamically panics when the library is missing; that is "unavailable".
fn guarded<T>(load: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(load)).unwrap_or_else(|panic| {
        let message = panic
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|text| text.to_string()))
            .unwrap_or_else(|| "unknown error".to_string());
        Err(format!("ONNX Runtime could not be loaded: {message}"))
    })
}

fn capture_meter(sample_rate: u32) -> Result<CaptureMetricsMeter, String> {
    CaptureMetricsMeter::new(sample_rate, 1, &CaptureMetricsConfig::default())
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStartRequest {
    pub run_id: String,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePushRequest {
    pub run_id: String,
    /// 0 for the first chunk of a run, then 1, 2, ...
    pub seq: u64,
    pub samples: Vec<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveFinishRequest {
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStarted {
    pub run_id: String,
    pub status: VadStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<VadProvider>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// One live update, in session seconds from the start of the capture.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveUpdate {
    pub run_id: String,
    pub seq: u64,
    pub status: VadStatus,
    /// VAD revision (0 while no Silero update exists).
    pub revision: u64,
    pub received_seconds: f64,
    pub analyzed_seconds: f64,
    pub stable_until_seconds: f64,
    /// Spans finalized by this update; never revised later.
    pub finalized: Vec<FinalizedSpeechSpan>,
    /// The provisional window after `stable_until_seconds`; replaces the previous one.
    pub provisional: Vec<SpeechSpan>,
    /// Capture health of everything received so far (source rate, mono).
    pub capture_metrics: CaptureMetrics,
    pub finished: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Silero processing time of this update.
    pub processing_ms: f64,
}

/// One capture's live voice activity.
pub struct LiveVoiceActivity {
    run_id: String,
    next_seq: u64,
    resampler: LinearResampler,
    stream: Option<SileroVadStream>,
    meter: CaptureMetricsMeter,
    status: VadStatus,
    reason: Option<String>,
    last: Option<(u64, f64, f64, f64)>,
    resampled: Vec<f32>,
}

impl LiveVoiceActivity {
    pub fn start(request: &LiveStartRequest) -> Result<(Self, LiveStarted), String> {
        let resampler = LinearResampler::new(request.sample_rate)?;
        let meter = capture_meter(request.sample_rate)?;
        let path = model_path();
        let loaded = provider_for(&path).and_then(|provider| {
            guarded(|| {
                SileroVadStream::from_options(silero_options(&path))
                    .map_err(|error| error.to_string())
            })
            .map(|stream| (provider, stream))
        });
        let (status, provider, stream, reason) = match loaded {
            Ok((provider, stream)) => (VadStatus::Detected, Some(provider), Some(stream), None),
            Err(reason) => (VadStatus::Unavailable, None, None, Some(reason)),
        };
        let started = LiveStarted {
            run_id: request.run_id.clone(),
            status,
            provider,
            reason: reason.clone(),
        };
        Ok((
            Self {
                run_id: request.run_id.clone(),
                next_seq: 0,
                resampler,
                stream,
                meter,
                status,
                reason,
                last: None,
                resampled: Vec::new(),
            },
            started,
        ))
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn push(&mut self, request: &LivePushRequest) -> Result<LiveUpdate, String> {
        if request.run_id != self.run_id {
            return Err(format!("stale voice activity run {}", request.run_id));
        }
        if self.status == VadStatus::Detected && request.seq != self.next_seq {
            self.interrupt(format!(
                "chunk {} arrived where chunk {} was expected; detection stopped",
                request.seq, self.next_seq
            ));
        }
        self.next_seq = request.seq + 1;
        // Capture health keeps measuring what arrives; non-finite samples are rejected whole.
        self.meter
            .push(&request.samples)
            .map_err(|error| error.to_string())?;
        let started = Instant::now();
        let mut finalized = Vec::new();
        let mut provisional = Vec::new();
        if self.status == VadStatus::Detected {
            self.resampled.clear();
            self.resampler.push(&request.samples, &mut self.resampled);
            if let Some(stream) = self.stream.as_mut() {
                match stream.push(&self.resampled) {
                    Ok(update) => {
                        self.last = Some((
                            update.revision,
                            update.analyzed_seconds,
                            update.stable_until_seconds,
                            update.received_seconds,
                        ));
                        finalized = update.finalized;
                        provisional = update.provisional;
                    }
                    Err(error) => self.fail(error.to_string()),
                }
            }
        }
        Ok(self.update(request.seq, finalized, provisional, false, started))
    }

    pub fn finish(mut self) -> LiveUpdate {
        let started = Instant::now();
        let mut finalized = Vec::new();
        if self.status == VadStatus::Detected {
            self.resampled.clear();
            self.resampler.finish(&mut self.resampled);
            if let Some(stream) = self.stream.as_mut() {
                let result = stream
                    .push(&self.resampled)
                    .and_then(|first| stream.finish().map(|last| (first, last)));
                match result {
                    Ok((first, last)) => {
                        self.last = Some((
                            last.revision,
                            last.analyzed_seconds,
                            last.stable_until_seconds,
                            last.received_seconds,
                        ));
                        finalized = first.finalized;
                        finalized.extend(last.finalized);
                    }
                    Err(error) => self.fail(error.to_string()),
                }
            }
        }
        let seq = self.next_seq;
        self.update(seq, finalized, Vec::new(), true, started)
    }

    fn interrupt(&mut self, reason: String) {
        self.status = VadStatus::Interrupted;
        self.reason = Some(reason);
        self.stream = None;
    }

    fn fail(&mut self, reason: String) {
        self.status = VadStatus::Failed;
        self.reason = Some(reason);
        self.stream = None;
    }

    fn update(
        &self,
        seq: u64,
        finalized: Vec<FinalizedSpeechSpan>,
        provisional: Vec<SpeechSpan>,
        finished: bool,
        started: Instant,
    ) -> LiveUpdate {
        let capture_metrics = self.meter.snapshot();
        let (revision, analyzed, stable_until, _) = self.last.unwrap_or((0, 0.0, 0.0, 0.0));
        LiveUpdate {
            run_id: self.run_id.clone(),
            seq,
            status: self.status,
            revision,
            received_seconds: capture_metrics.duration_seconds,
            analyzed_seconds: analyzed,
            stable_until_seconds: stable_until,
            finalized,
            provisional,
            capture_metrics,
            finished,
            reason: self.reason.clone(),
            processing_ms: started.elapsed().as_secs_f64() * 1000.0,
        }
    }
}

/// The live capture currently feeding voice activity, if any (one at a time).
#[derive(Default)]
pub struct LiveVoiceActivityState(pub Mutex<Option<LiveVoiceActivity>>);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FiniteRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// Silero over a whole capture after Stop.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiniteResult {
    pub status: VadStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<VadProvider>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Seconds of the supplied audio.
    pub analyzed_seconds: f64,
    /// Speech spans relative to the start of the supplied audio.
    pub segments: Vec<SpeechSpan>,
    pub capture_metrics: CaptureMetrics,
    pub processing_ms: f64,
}

pub fn analyze_finite(request: &FiniteRequest) -> Result<FiniteResult, String> {
    let capture_metrics = audio_analysis_core::capture_metrics(
        &request.samples,
        request.sample_rate,
        1,
        &CaptureMetricsConfig::default(),
    )
    .map_err(|error| error.to_string())?;
    let analyzed_seconds = capture_metrics.duration_seconds;
    let started = Instant::now();
    let path = model_path();
    let result = provider_for(&path).and_then(|provider| {
        let mut detector = guarded(|| {
            SileroVadTranscriptionProvider::from_options(silero_options(&path), Vec::new())
                .map_err(|error| error.to_string())
        })?;
        Ok((provider, detector_run(&mut detector, request)))
    });
    let (status, provider, reason, segments) = match result {
        Ok((provider, Ok(segments))) => (VadStatus::Detected, Some(provider), None, segments),
        Ok((provider, Err(reason))) => {
            (VadStatus::Failed, Some(provider), Some(reason), Vec::new())
        }
        Err(reason) => (VadStatus::Unavailable, None, Some(reason), Vec::new()),
    };
    Ok(FiniteResult {
        status,
        provider,
        reason,
        analyzed_seconds,
        segments,
        capture_metrics,
        processing_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

fn detector_run(
    detector: &mut SileroVadTranscriptionProvider,
    request: &FiniteRequest,
) -> Result<Vec<SpeechSpan>, String> {
    let resampled = resample_to_vad_rate(&request.samples, request.sample_rate)?;
    let audio =
        SpeakerAudio::mono(&resampled, VAD_SAMPLE_RATE).map_err(|error| error.to_string())?;
    detector
        .detect_speech(&audio, &VadOptions::default())
        .map(|response| response.segments)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chirp(len: usize, rate: f32) -> Vec<f32> {
        (0..len)
            .map(|index| ((index as f32 / rate) * 440.0 * (1.0 + index as f32 / 10_000.0)).sin())
            .collect()
    }

    #[test]
    fn resampler_output_does_not_depend_on_chunking() {
        for rate in [8_000u32, 16_000, 22_050, 44_100, 48_000] {
            let input = chirp(rate as usize * 2 + 37, rate as f32);
            let whole = resample_to_vad_rate(&input, rate).unwrap();
            let expected_len = (input.len() as u64 * 16_000).div_ceil(u64::from(rate)) as usize;
            assert_eq!(whole.len(), expected_len, "rate {rate}");
            for chunk in [1usize, 127, 128, 4_096, input.len()] {
                let mut resampler = LinearResampler::new(rate).unwrap();
                let mut out = Vec::new();
                for samples in input.chunks(chunk) {
                    resampler.push(samples, &mut out);
                    assert!(resampler.tail.len() <= 2 + samples.len().min(2));
                }
                resampler.finish(&mut out);
                assert_eq!(out, whole, "rate {rate}, chunk {chunk}");
            }
        }
    }

    #[test]
    fn resampler_keeps_16k_input_unchanged() {
        let input = chirp(1_000, 16_000.0);
        assert_eq!(resample_to_vad_rate(&input, 16_000).unwrap(), input);
    }

    #[test]
    fn missing_model_is_unavailable_never_no_speech() {
        std::env::set_var(SILERO_MODEL_ENV, "/nonexistent/silero_vad.onnx");
        let finite = analyze_finite(&FiniteRequest {
            samples: vec![0.3; 48_000],
            sample_rate: 48_000,
        })
        .unwrap();
        assert_eq!(finite.status, VadStatus::Unavailable);
        assert!(finite.reason.unwrap().contains(SILERO_MODEL_ENV));
        // Sound was there: capture health still reports activity.
        assert!(finite.capture_metrics.activity_seconds > 0.9);

        let (mut live, started) = LiveVoiceActivity::start(&LiveStartRequest {
            run_id: "run".into(),
            sample_rate: 48_000,
        })
        .unwrap();
        assert_eq!(started.status, VadStatus::Unavailable);
        let update = live
            .push(&LivePushRequest {
                run_id: "run".into(),
                seq: 0,
                samples: vec![0.3; 4_800],
            })
            .unwrap();
        assert_eq!(update.status, VadStatus::Unavailable);
        assert!(update.finalized.is_empty() && update.provisional.is_empty());
        assert!(live
            .push(&LivePushRequest {
                run_id: "other".into(),
                seq: 1,
                samples: vec![0.0; 10],
            })
            .is_err());
        std::env::remove_var(SILERO_MODEL_ENV);
    }

    /// Real model and recording: live chunks and the finite run agree span for span.
    /// `VOX_SILERO_VAD_MODEL`, `VOX_VAD_AUDIO` (mono 16-bit WAV, any rate), `ORT_DYLIB_PATH`.
    #[test]
    #[ignore = "requires a local Silero model, ONNX Runtime and a WAV"]
    fn real_live_and_finite_voice_activity_agree() {
        let path = std::env::var("VOX_VAD_AUDIO").expect("VOX_VAD_AUDIO");
        let mut reader = hound::WavReader::open(path).unwrap();
        let rate = reader.spec().sample_rate;
        let samples = reader
            .samples::<i16>()
            .map(|sample| f32::from(sample.unwrap()) / 32_768.0)
            .collect::<Vec<_>>();
        let finite = analyze_finite(&FiniteRequest {
            samples: samples.clone(),
            sample_rate: rate,
        })
        .unwrap();
        assert_eq!(finite.status, VadStatus::Detected, "{:?}", finite.reason);
        eprintln!(
            "finite: {} spans in {:.1} ms",
            finite.segments.len(),
            finite.processing_ms
        );
        for chunk in [4_096usize, 2_048, 9_600] {
            let (mut live, _) = LiveVoiceActivity::start(&LiveStartRequest {
                run_id: "run".into(),
                sample_rate: rate,
            })
            .unwrap();
            let mut spans = Vec::new();
            let mut slowest = 0.0_f64;
            for (seq, samples) in samples.chunks(chunk).enumerate() {
                let update = live
                    .push(&LivePushRequest {
                        run_id: "run".into(),
                        seq: seq as u64,
                        samples: samples.to_vec(),
                    })
                    .unwrap();
                slowest = slowest.max(update.processing_ms);
                spans.extend(update.finalized.into_iter().map(|span| span.span));
            }
            let last = live.finish();
            spans.extend(last.finalized.into_iter().map(|span| span.span));
            eprintln!("chunk {chunk}: slowest update {slowest:.2} ms");
            assert_eq!(spans, finite.segments, "chunk {chunk}");
            assert_eq!(last.capture_metrics, finite.capture_metrics);
        }
    }
}
