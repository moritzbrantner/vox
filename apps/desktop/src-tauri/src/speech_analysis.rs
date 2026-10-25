use std::collections::HashMap;

use audio_analysis_core::{capture_metrics, rms, CaptureMetrics, CaptureMetricsConfig, FrameSpec};
use audio_analysis_fourier::FourierTransform;
use audio_analysis_pitch::{AutocorrelationPitchDetector, PitchDetectorConfig};
use audio_analysis_recognition::{
    AudioEmbedding, AudioEmbeddingExtractor, AudioMatchOptions, AudioReference,
    AudioReferenceLibrary, SpectralAudioEmbedder, SpectralEmbeddingConfig,
};
use audio_analysis_rhythm::{detect_onsets, onset_envelope, Onset, OnsetDetectorConfig};
use audio_analysis_speakers::{
    EnergyVadConfig, EnergyVoiceActivityDetector, SpeakerAudio, VoiceActivityDetector,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::speech_pipeline::{
    onset_id, pause_id, speech_id, token_id, AnalysisCapabilities, INTERPOLATED_TIMING_NOTE,
};

#[derive(Debug, Error)]
pub enum SpeechAnalysisError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Audio(#[from] crate::video_analysis_core::DetectError),
}

type Result<T> = std::result::Result<T, SpeechAnalysisError>;

/// Bump whenever the detector's output can change for the same input; saved sessions record it.
pub const SPEECH_ANALYSIS_VERSION: &str = "2";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSpeechRequest {
    pub segments: Vec<TranscriptSegmentInput>,
    pub pauses: Vec<PauseInput>,
    pub session_started_at: Option<String>,
    pub samples: Option<Vec<f32>>,
    pub sample_rate: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentInput {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub confidence: Option<f32>,
    pub speaker_score: Option<f32>,
    pub is_final: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseInput {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub after_text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisReport {
    /// Identifies this detector's behaviour in saved analysis provenance.
    pub analyzer_version: &'static str,
    pub session_started_at: Option<String>,
    pub total_duration_seconds: f64,
    pub word_count: usize,
    pub stutter_count: usize,
    pub stutters_per_minute: f64,
    pub severity: Severity,
    pub speech_stats: SpeechStats,
    pub blocker_stats: BlockerStats,
    pub chunks: Vec<ChunkAnalysis>,
    pub events: Vec<StutterEvent>,
    pub by_kind: HashMap<StutterKind, usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acoustic_stats: Option<AcousticStats>,
    /// Generic capture observations (audio-analysis) of the audio window this report analyzed, at
    /// the request's sample rate. The product quality gate interprets them; absent without audio.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_metrics: Option<CaptureMetrics>,
    /// Typed observations that interpreted events cite, plus explicit missing observations.
    /// Absent from the batch reference (`analyze_speech_session_impl`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observations: Option<Vec<crate::speech_pipeline::Observation>>,
    /// Which outputs this analyzer produces, so a reduced analyzer is never read as a richer
    /// one. Absent from the batch reference and older reports.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<AnalysisCapabilities>,
    /// Detections withheld for insufficient evidence: not events, and left out of every count,
    /// rate and trend. Each keeps the candidate it was withheld from, with its evidence.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub insufficient_evidence: Vec<PossibleEvent>,
}

/// Which candidate detections the analyzer reports as events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EvidencePolicy {
    /// Every candidate that passes its threshold is an event (the detector before #27).
    #[cfg_attr(not(test), allow(dead_code))]
    ReportAll,
    /// Sound repetitions found in the audio alone (repeated onset bursts with no transcript
    /// support) are withheld as insufficient evidence: on SEP-28k such clusters fire on fluent
    /// speech about as often as on sound repetitions (`docs/benchmarks/sep28k-sound-repetition.md`).
    WithholdAudioOnlySoundRepetitions,
}

/// The policy the product uses; the benchmark compares it with `ReportAll`.
pub(crate) const PRODUCT_EVIDENCE_POLICY: EvidencePolicy =
    EvidencePolicy::WithholdAudioOnlySoundRepetitions;

/// A "possible – not enough evidence" detection (`AnalysisReport::insufficient_evidence`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PossibleEvent {
    pub reason: InsufficientEvidenceReason,
    /// The withheld candidate, with its evidence (cited observations are in the report).
    pub candidate: StutterEvent,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InsufficientEvidenceReason {
    /// Only the audio supports it; no transcript evidence was available or overlapping.
    AudioOnly,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStats {
    pub speaking_duration_seconds: f64,
    pub pause_duration_seconds: f64,
    pub words_per_minute: f64,
    pub articulation_rate_wpm: f64,
    pub mean_chunk_words: f64,
    pub mean_chunk_duration_seconds: f64,
    pub event_density_per_100_words: f64,
    pub fluency_percentage: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockerStats {
    pub block_count: usize,
    pub total_block_seconds: f64,
    pub average_block_seconds: f64,
    pub longest_block_seconds: f64,
    pub blocks_per_minute: f64,
    pub blocked_time_percentage: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcousticStats {
    pub analyzed_duration_seconds: f64,
    pub speech_duration_seconds: f64,
    pub silence_duration_seconds: f64,
    pub voice_activity_ratio: f64,
    pub onset_count: usize,
    pub mean_onset_rate: f64,
    pub mean_rms: f64,
    pub noise_floor_rms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkAnalysis {
    pub index: usize,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub duration_seconds: f64,
    pub text: String,
    pub word_count: usize,
    pub stutter_count: usize,
    pub block_count: usize,
    pub filler_count: usize,
    pub words_per_minute: f64,
    pub silent_pause_seconds: f64,
    pub average_confidence: Option<f32>,
}

#[derive(Debug, Clone, Copy, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StutterKind {
    WordRepetition,
    SoundRepetition,
    Prolongation,
    Block,
    Filler,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    None,
    Mild,
    Moderate,
    High,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StutterEvent {
    pub kind: StutterKind,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
    pub detail: String,
    pub confidence: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<EventSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acoustic_evidence: Option<AcousticEvidence>,
    /// Stable id, supporting observations and decision of an event interpreted from typed
    /// observations (`speech_pipeline`); absent for events of stages not yet on that path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<EventEvidence>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEvidence {
    pub id: String,
    /// Ids of the observations (in `AnalysisReport::observations`) the decision rests on.
    pub supporting: Vec<String>,
    /// Ids of observations that speak against the decision without overturning it (e.g. speech
    /// activity inside a transcript pause reported as a block). Empty when none were observed;
    /// a missing channel is never a conflict or a confirmation.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub conflicting: Vec<String>,
    pub explanation: String,
}

impl EventEvidence {
    fn new(id: String, supporting: Vec<String>, explanation: String) -> Self {
        Self {
            id,
            supporting,
            conflicting: Vec::new(),
            explanation,
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EventSource {
    Transcript,
    Acoustic,
    Fused,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcousticEvidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy_rms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silence_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onset_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onset_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_mean_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_stability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spectral_centroid_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zero_crossing_rate: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceprintRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceprintResult {
    pub embedding: Vec<f32>,
    pub sample_rate: u32,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMatchRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub reference_embedding: Vec<f32>,
    pub threshold: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMatchResult {
    pub score: f32,
    pub is_match: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerProfileRequest {
    pub id: Option<String>,
    pub label: String,
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerProfileResult {
    pub id: String,
    pub label: String,
    pub embeddings: Vec<Vec<f32>>,
    pub sample_rate: u32,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerIdentificationRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub speakers: Vec<SpeakerProfileResult>,
    pub threshold: Option<f32>,
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMatchResult {
    pub speaker_id: String,
    pub label: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerIdentificationResult {
    pub best_match: Option<SpeakerMatchResult>,
    pub matches: Vec<SpeakerMatchResult>,
    pub is_match: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct TimedToken {
    /// Observation id of the token (`speech_pipeline::token_id`).
    pub(crate) id: String,
    pub(crate) raw: String,
    pub(crate) normalized: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
}

#[derive(Debug, Clone)]
struct AcousticFrame {
    start_seconds: f64,
    end_seconds: f64,
    rms: f64,
    zero_crossing_rate: f64,
    pitch_hz: Option<f64>,
    spectral_centroid_hz: f64,
}

#[derive(Debug, Clone)]
struct AcousticAnalysis {
    stats: AcousticStats,
    events: Vec<StutterEvent>,
    speech_spans: Vec<AcousticSpan>,
    onsets: Vec<AcousticOnset>,
}

/// Generic speech-activity interval (energy VAD from audio-analysis) in the analyzed window. It
/// says that someone spoke, not who: identity is never inferred from it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct AcousticSpan {
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
    pub(crate) score: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct AcousticOnset {
    pub(crate) seconds: f64,
    pub(crate) strength: f32,
}

/// What the acoustic front end observed, for the typed observations of a report.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AcousticObservations {
    /// Seconds of audio the acoustic analysis read, from the start of the recording.
    pub(crate) analyzed_seconds: f64,
    pub(crate) speech_spans: Vec<AcousticSpan>,
    pub(crate) onsets: Vec<AcousticOnset>,
}

/// The report alone, as the detector's own tests read it; production and the benchmark use
/// `speech_pipeline::analyze_speech_session`, which adds the cited observations.
#[cfg(test)]
pub fn analyze_speech_session_impl(request: AnalyzeSpeechRequest) -> Result<AnalysisReport> {
    analyze_with_evidence(request, PRODUCT_EVIDENCE_POLICY).map(|(report, _)| report)
}

/// The stuttering-specific detector. Every stage gives its events `evidence` citing the
/// observations they rest on (ids from `speech_pipeline`); fusion merges the evidence of the
/// candidates it combines. Also returns the acoustic observations, when audio was analyzed.
pub(crate) fn analyze_with_evidence(
    request: AnalyzeSpeechRequest,
    policy: EvidencePolicy,
) -> Result<(AnalysisReport, Option<AcousticObservations>)> {
    let mut events = Vec::new();
    let mut tokens = Vec::new();
    let mut duration = 0.0_f64;
    let mut speaking_duration_seconds = 0.0_f64;

    for (segment_index, segment) in request
        .segments
        .iter()
        .enumerate()
        .filter(|(_, segment)| segment.is_final)
    {
        if !segment.start_seconds.is_finite() || !segment.end_seconds.is_finite() {
            return Err(SpeechAnalysisError::Invalid(
                "segment times must be finite".to_string(),
            ));
        }
        let _segment_quality = (
            segment.confidence.unwrap_or(1.0),
            segment.speaker_score.unwrap_or(1.0),
        );
        duration = duration.max(segment.end_seconds);
        speaking_duration_seconds += (segment.end_seconds - segment.start_seconds).max(0.0);
        let segment_tokens = timed_tokens(segment_index, segment);
        events.extend(detect_repetitions(&segment_tokens));
        events.extend(detect_prolongations(&segment_tokens));
        events.extend(detect_fillers(&segment_tokens));
        tokens.extend(segment_tokens);
    }

    events.extend(detect_blocks(&request.pauses));
    let mut acoustic = analyze_acoustics(&request)?;
    let capture = measure_capture(&request)?;
    if let Some(acoustic) = &acoustic {
        duration = duration.max(acoustic.stats.analyzed_duration_seconds);
    }
    events = fuse_events(
        events,
        acoustic
            .as_ref()
            .map_or(&[][..], |value| value.events.as_slice()),
    );
    events.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    events.dedup_by(|left, right| {
        left.kind == right.kind
            && (left.start_seconds - right.start_seconds).abs() < 0.08
            && left.text == right.text
    });
    // Withholding is a pure partition of the fused events, so `ReportAll` events are exactly
    // the events plus the withheld candidates of the same input.
    let mut insufficient_evidence = Vec::new();
    if policy == EvidencePolicy::WithholdAudioOnlySoundRepetitions {
        let (withheld, kept): (Vec<_>, Vec<_>) = events.into_iter().partition(|event| {
            event.kind == StutterKind::SoundRepetition
                && event.source == Some(EventSource::Acoustic)
        });
        events = kept;
        insufficient_evidence = withheld
            .into_iter()
            .map(|candidate| PossibleEvent {
                reason: InsufficientEvidenceReason::AudioOnly,
                candidate,
            })
            .collect();
    }

    let word_count = tokens
        .iter()
        .filter(|token| !is_filler(&token.normalized))
        .count();
    let total_duration_seconds = duration.max(
        request
            .pauses
            .iter()
            .map(|pause| pause.end_seconds)
            .fold(0.0, f64::max),
    );
    let minutes = (total_duration_seconds / 60.0).max(1.0 / 60.0);
    let stutters_per_minute = events.len() as f64 / minutes;
    let severity = classify_severity(stutters_per_minute, word_count, events.len());
    let mut by_kind = HashMap::new();
    for event in &events {
        *by_kind.entry(event.kind).or_insert(0) += 1;
    }
    let speech_stats = speech_stats(
        total_duration_seconds,
        speaking_duration_seconds,
        &request.pauses,
        word_count,
        events.len(),
        request
            .segments
            .iter()
            .filter(|segment| segment.is_final)
            .count(),
    );
    let blocker_stats = blocker_stats(&events, total_duration_seconds);
    let chunks = chunk_analysis(&request.segments, &request.pauses, &events);
    let acoustic_observations = acoustic.as_mut().map(|value| AcousticObservations {
        analyzed_seconds: value.stats.analyzed_duration_seconds,
        speech_spans: std::mem::take(&mut value.speech_spans),
        onsets: std::mem::take(&mut value.onsets),
    });

    let report = AnalysisReport {
        analyzer_version: SPEECH_ANALYSIS_VERSION,
        session_started_at: request.session_started_at,
        total_duration_seconds,
        word_count,
        stutter_count: events.len(),
        stutters_per_minute,
        severity,
        speech_stats,
        blocker_stats,
        chunks,
        events,
        by_kind,
        acoustic_stats: acoustic.map(|value| value.stats),
        capture_metrics: capture,
        observations: None,
        capabilities: None,
        insufficient_evidence,
    };
    Ok((report, acoustic_observations))
}

/// Seconds of request audio the acoustic analysis reads; capture metrics cover the same window.
const ANALYZED_AUDIO_SECONDS: usize = 90;

/// Measures the analyzed audio window before clamping, so out-of-range input counts as clipped.
fn measure_capture(request: &AnalyzeSpeechRequest) -> Result<Option<CaptureMetrics>> {
    let (Some(samples), Some(sample_rate)) = (&request.samples, request.sample_rate) else {
        return Ok(None);
    };
    measure_analyzed_window(samples, sample_rate).map(Some)
}

fn measure_analyzed_window(samples: &[f32], sample_rate: u32) -> Result<CaptureMetrics> {
    measure_analyzed_interleaved_window(samples, sample_rate, 1)
}

/// Interleaved samples per channel count that native analysis measures: the first
/// `ANALYZED_AUDIO_SECONDS` of the audio.
pub(crate) fn analyzed_window_len(sample_rate: u32, channels: u16) -> usize {
    (sample_rate as usize)
        .saturating_mul(ANALYZED_AUDIO_SECONDS)
        .saturating_mul(usize::from(channels))
}

/// The capture measurement of native analysis, for interleaved audio of `channels` channels:
/// the same kernel, configuration and analyzed window.
pub(crate) fn measure_analyzed_interleaved_window(
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
) -> Result<CaptureMetrics> {
    let window = samples
        .len()
        .min(analyzed_window_len(sample_rate, channels));
    capture_metrics(
        &samples[..window],
        sample_rate,
        channels,
        &CaptureMetricsConfig::default(),
    )
    .map_err(|error| SpeechAnalysisError::Invalid(error.to_string()))
}

/// Mono analysis audio, as sent with an analysis request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMetricsRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// The capture observations native analysis reports for the same audio, for analysis paths that
/// do not run the native analyzer (the compute server's shared analyzer).
pub fn capture_metrics_impl(request: CaptureMetricsRequest) -> Result<CaptureMetrics> {
    measure_analyzed_window(&request.samples, request.sample_rate)
}

pub fn create_voiceprint_impl(request: VoiceprintRequest) -> Result<VoiceprintResult> {
    validate_samples(&request.samples, request.sample_rate)?;
    let embedder = SpectralAudioEmbedder::new(SpectralEmbeddingConfig::default())?;
    let embedding = embedder.embed_samples(&request.samples, request.sample_rate)?;
    Ok(VoiceprintResult {
        embedding: embedding.values().to_vec(),
        sample_rate: request.sample_rate,
        sample_count: request.samples.len(),
    })
}

pub fn compare_voiceprint_impl(request: VoiceMatchRequest) -> Result<VoiceMatchResult> {
    validate_samples(&request.samples, request.sample_rate)?;
    let threshold = request.threshold.unwrap_or(0.82).clamp(-1.0, 1.0);
    let embedder = SpectralAudioEmbedder::new(SpectralEmbeddingConfig::default())?;
    let current = embedder.embed_samples(&request.samples, request.sample_rate)?;
    let reference = AudioEmbedding::new(request.reference_embedding)?;
    let score = current.cosine_similarity(&reference)?;
    Ok(VoiceMatchResult {
        score,
        is_match: score >= threshold,
    })
}

pub fn create_speaker_profile_impl(request: SpeakerProfileRequest) -> Result<SpeakerProfileResult> {
    validate_samples(&request.samples, request.sample_rate)?;
    let label = request.label.trim();
    if label.is_empty() {
        return Err(SpeechAnalysisError::Invalid(
            "speaker label must not be empty".to_string(),
        ));
    }
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| speaker_id_from_label(label));
    let embedder = SpectralAudioEmbedder::new(SpectralEmbeddingConfig::default())?;
    let embedding = embedder.embed_samples(&request.samples, request.sample_rate)?;
    Ok(SpeakerProfileResult {
        id,
        label: label.to_string(),
        embeddings: vec![embedding.values().to_vec()],
        sample_rate: request.sample_rate,
        sample_count: request.samples.len(),
    })
}

pub fn identify_speaker_impl(
    request: SpeakerIdentificationRequest,
) -> Result<SpeakerIdentificationResult> {
    validate_samples(&request.samples, request.sample_rate)?;
    let threshold = request.threshold.unwrap_or(0.85).clamp(-1.0, 1.0);
    let max_results = request.max_results.unwrap_or(3).max(1);
    let embedder = SpectralAudioEmbedder::new(SpectralEmbeddingConfig::default())?;
    let current = embedder.embed_samples(&request.samples, request.sample_rate)?;
    let library = speaker_library(request.speakers)?;
    if library.is_empty() {
        return Ok(SpeakerIdentificationResult {
            best_match: None,
            matches: Vec::new(),
            is_match: false,
        });
    }
    let options = AudioMatchOptions::new(threshold)?.max_results(max_results);
    let matches = library
        .search(&current, &options)?
        .into_iter()
        .map(|item| SpeakerMatchResult {
            speaker_id: item.reference_id,
            label: item.label,
            score: item.score,
        })
        .collect::<Vec<_>>();
    let best_match = matches.first().cloned();
    Ok(SpeakerIdentificationResult {
        is_match: best_match.is_some(),
        best_match,
        matches,
    })
}

fn analyze_acoustics(request: &AnalyzeSpeechRequest) -> Result<Option<AcousticAnalysis>> {
    let (samples, sample_rate) = match (&request.samples, request.sample_rate) {
        (None, None) => return Ok(None),
        (Some(samples), Some(sample_rate)) => (samples.as_slice(), sample_rate),
        _ => {
            return Err(SpeechAnalysisError::Invalid(
                "samples and sampleRate must be provided together".to_string(),
            ))
        }
    };
    if !validate_analysis_audio(samples, sample_rate)? {
        // Too short for acoustic analysis; the report still carries its capture metrics, so the
        // quality gate can call it too short instead of the run falling back without them.
        return Ok(None);
    }

    let target_sample_rate = 16_000_u32;
    let mut normalized = samples
        .iter()
        .map(|sample| sample.clamp(-1.0, 1.0))
        .collect::<Vec<_>>();
    if sample_rate != target_sample_rate {
        normalized = resample_linear(&normalized, sample_rate, target_sample_rate);
    }
    normalized.truncate(target_sample_rate as usize * ANALYZED_AUDIO_SECONDS);
    if normalized.is_empty() {
        return Ok(None);
    }

    let frame_size = (target_sample_rate as f64 * 0.03).round() as usize;
    let hop_size = (target_sample_rate as f64 * 0.01).round() as usize;
    let frames = acoustic_frames(&normalized, target_sample_rate, frame_size, hop_size)?;
    if frames.is_empty() {
        return Ok(None);
    }

    let rms_values = frames.iter().map(|frame| frame.rms).collect::<Vec<_>>();
    let noise_floor_rms = percentile(&rms_values, 0.2);
    let mean_rms_value = mean(&rms_values);
    let speech_threshold = (noise_floor_rms * 3.0)
        .max(0.01)
        .min((mean_rms_value * 0.8).max(0.01));
    let silence_threshold = (noise_floor_rms * 1.5).max(0.006);

    let audio = SpeakerAudio::mono(&normalized, target_sample_rate)?;
    let mut vad = EnergyVoiceActivityDetector::new(EnergyVadConfig {
        rms_threshold: speech_threshold as f32,
        frame_seconds: 0.03,
        hop_seconds: 0.01,
        min_speech_seconds: 0.08,
        merge_gap_seconds: 0.08,
    })?;
    let speech_spans = vad.detect_speech(&audio)?;

    let frame_spec = FrameSpec::new(frame_size, hop_size)?;
    let envelope = onset_envelope(&normalized, target_sample_rate, frame_spec)?;
    let strengths = envelope
        .iter()
        .map(|item| item.strength as f64)
        .collect::<Vec<_>>();
    let onset_threshold = (median(&strengths) + 1.5 * mad(&strengths)).max(0.03) as f32;
    let onsets = detect_onsets(
        &envelope,
        OnsetDetectorConfig {
            strength_threshold: onset_threshold,
            min_interval_seconds: 0.07,
        },
    )?;

    let mut events = Vec::new();
    events.extend(detect_acoustic_blocks(
        &frames,
        &speech_spans,
        &onsets,
        request,
        silence_threshold,
    ));
    events.extend(detect_acoustic_prolongations(
        &frames,
        &speech_spans,
        &onsets,
        request,
    ));
    events.extend(detect_acoustic_repetitions(&frames, &onsets, request));

    let analyzed_duration_seconds = normalized.len() as f64 / target_sample_rate as f64;
    let speech_duration_seconds = speech_spans
        .iter()
        .map(|span| span.duration_seconds().max(0.0))
        .sum::<f64>();
    let stats = AcousticStats {
        analyzed_duration_seconds,
        speech_duration_seconds,
        silence_duration_seconds: (analyzed_duration_seconds - speech_duration_seconds).max(0.0),
        voice_activity_ratio: if analyzed_duration_seconds <= 0.0 {
            0.0
        } else {
            speech_duration_seconds / analyzed_duration_seconds
        },
        onset_count: onsets.len(),
        mean_onset_rate: if analyzed_duration_seconds <= 0.0 {
            0.0
        } else {
            onsets.len() as f64 / analyzed_duration_seconds
        },
        mean_rms: mean_rms_value,
        noise_floor_rms,
    };

    Ok(Some(AcousticAnalysis {
        stats,
        events,
        speech_spans: speech_spans
            .iter()
            .map(|span| AcousticSpan {
                start_seconds: span.start_seconds,
                end_seconds: span.end_seconds,
                score: span.score,
            })
            .collect(),
        onsets: onsets
            .iter()
            .map(|onset| AcousticOnset {
                seconds: onset.timestamp_seconds,
                strength: onset.strength,
            })
            .collect(),
    }))
}

/// Rejects malformed audio; returns whether it is long enough (250 ms) for acoustic analysis.
fn validate_analysis_audio(samples: &[f32], sample_rate: u32) -> Result<bool> {
    if sample_rate == 0 {
        return Err(SpeechAnalysisError::Invalid(
            "sampleRate must be greater than zero".to_string(),
        ));
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err(SpeechAnalysisError::Invalid(
            "audio samples must be finite".to_string(),
        ));
    }
    Ok(samples.len() >= (sample_rate as usize / 4).max(1024))
}

fn acoustic_frames(
    samples: &[f32],
    sample_rate: u32,
    frame_size: usize,
    hop_size: usize,
) -> Result<Vec<AcousticFrame>> {
    let frame_spec = FrameSpec::new(frame_size, hop_size)?;
    let pitch_detector = AutocorrelationPitchDetector::new(PitchDetectorConfig {
        min_frequency_hz: 50.0,
        max_frequency_hz: 2_000.0,
        confidence_threshold: 0.45,
    })?;
    let fourier = FourierTransform::new(512)?;
    let mut frames = Vec::new();
    for (start_sample, frame) in frame_spec.frames(samples) {
        let rms_value = rms(frame) as f64;
        let pitch = pitch_detector
            .estimate_samples(frame, sample_rate)?
            .frequency_hz
            .map(|value| value as f64);
        let spectral = fourier.analyze_samples(frame, sample_rate)?.features();
        frames.push(AcousticFrame {
            start_seconds: start_sample as f64 / sample_rate as f64,
            end_seconds: (start_sample + frame.len()).min(samples.len()) as f64
                / sample_rate as f64,
            rms: rms_value,
            zero_crossing_rate: zero_crossing_rate(frame),
            pitch_hz: pitch,
            spectral_centroid_hz: spectral.centroid_hz as f64,
        });
    }
    Ok(frames)
}

fn detect_acoustic_blocks(
    frames: &[AcousticFrame],
    speech_spans: &[audio_analysis_speakers::SpeechSpan],
    onsets: &[Onset],
    request: &AnalyzeSpeechRequest,
    silence_threshold: f64,
) -> Vec<StutterEvent> {
    let mut events = Vec::new();
    for (span_index, pair) in speech_spans.windows(2).enumerate() {
        let left = pair[0];
        let right = pair[1];
        let duration = right.start_seconds - left.end_seconds;
        if !(0.5..=1.25).contains(&duration) {
            continue;
        }
        let gap_frames = frames
            .iter()
            .filter(|frame| {
                frame.start_seconds >= left.end_seconds && frame.end_seconds <= right.start_seconds
            })
            .collect::<Vec<_>>();
        if gap_frames.iter().any(|frame| frame.rms > silence_threshold) {
            continue;
        }
        let overlapping_pauses = request
            .pauses
            .iter()
            .enumerate()
            .filter(|(_, pause)| {
                overlap_seconds(
                    pause.start_seconds,
                    pause.end_seconds,
                    left.end_seconds,
                    right.start_seconds,
                ) >= 0.1
            })
            .map(|(index, _)| pause_id(index))
            .collect::<Vec<_>>();
        let has_pause = !overlapping_pauses.is_empty();
        let following_onsets = onsets
            .iter()
            .enumerate()
            .filter(|(_, onset)| {
                onset.timestamp_seconds >= right.start_seconds
                    && onset.timestamp_seconds <= right.start_seconds + 0.18
            })
            .map(|(index, _)| onset_id(index))
            .collect::<Vec<_>>();
        let followed_by_onset = !following_onsets.is_empty();
        let mut supporting = vec![speech_id(span_index), speech_id(span_index + 1)];
        supporting.extend(following_onsets);
        supporting.extend(overlapping_pauses);
        let confidence = (0.62_f64
            + if followed_by_onset { 0.1 } else { 0.0 }
            + if has_pause { 0.1 } else { 0.0 })
        .min(0.95_f64) as f32;
        events.push(StutterEvent {
            kind: StutterKind::Block,
            start_seconds: left.end_seconds,
            end_seconds: right.start_seconds,
            text: nearest_text_after(&request.segments, right.start_seconds)
                .unwrap_or_else(|| "pause".to_string()),
            detail: format!("{duration:.1}s acoustic silent block before speech"),
            confidence,
            source: Some(EventSource::Acoustic),
            acoustic_evidence: Some(AcousticEvidence {
                silence_seconds: Some(duration),
                onset_count: Some(if followed_by_onset { 1 } else { 0 }),
                energy_rms: Some(mean_refs(&gap_frames, |frame| frame.rms)),
                zero_crossing_rate: Some(mean_refs(&gap_frames, |frame| frame.zero_crossing_rate)),
                ..AcousticEvidence::default()
            }),
            evidence: Some(EventEvidence::new(
                format!("block:{}", speech_id(span_index)),
                supporting,
                format!(
                    "{duration:.2} s without speech activity or energy above the silence threshold between two speech-activity intervals{}{}.",
                    if followed_by_onset { "; speech resumes with an onset" } else { "" },
                    if has_pause { "; a captured pause overlaps the gap" } else { "" },
                ),
            )),
        });
    }
    events
}

fn detect_acoustic_prolongations(
    frames: &[AcousticFrame],
    speech_spans: &[audio_analysis_speakers::SpeechSpan],
    onsets: &[Onset],
    request: &AnalyzeSpeechRequest,
) -> Vec<StutterEvent> {
    let mut events = Vec::new();
    for (span_index, span) in speech_spans.iter().enumerate() {
        let duration = span.duration_seconds();
        if duration < 0.45 {
            continue;
        }
        let (span_onset_ids, span_onsets): (Vec<String>, Vec<&Onset>) = onsets
            .iter()
            .enumerate()
            .filter(|(_, onset)| {
                onset.timestamp_seconds >= span.start_seconds
                    && onset.timestamp_seconds <= span.end_seconds
            })
            .map(|(index, onset)| (onset_id(index), onset))
            .unzip();
        let span_frames = frames
            .iter()
            .filter(|frame| {
                frame.start_seconds >= span.start_seconds && frame.end_seconds <= span.end_seconds
            })
            .collect::<Vec<_>>();
        let pitch_values = span_frames
            .iter()
            .filter_map(|frame| frame.pitch_hz)
            .collect::<Vec<_>>();
        let pitch_stability = stability_score(&pitch_values).or_else(|| {
            let centroids = span_frames
                .iter()
                .map(|frame| frame.spectral_centroid_hz)
                .collect::<Vec<_>>();
            stability_score(&centroids)
        });
        let transcript_support = request
            .segments
            .iter()
            .filter(|segment| {
                segment.is_final
                    && overlaps(
                        span.start_seconds,
                        span.end_seconds,
                        segment.start_seconds,
                        segment.end_seconds,
                    )
            })
            .any(|segment| transcript_has_prolongation(&segment.text));
        let stable = pitch_stability.unwrap_or(0.0) >= 0.55;
        if span_onsets.len() > 1 && !stable {
            continue;
        }
        let confidence = (0.6_f64
            + if duration >= 0.7 { 0.15 } else { 0.0 }
            + if stable { 0.1 } else { 0.0 }
            + if transcript_support { 0.1 } else { 0.0 })
        .min(0.95_f64) as f32;
        events.push(StutterEvent {
            kind: StutterKind::Prolongation,
            start_seconds: span.start_seconds,
            end_seconds: span.end_seconds,
            text: nearest_text_at(&request.segments, span.start_seconds, span.end_seconds)
                .unwrap_or_else(|| "voiced stretch".to_string()),
            detail: format!("{duration:.1}s stable voiced stretch"),
            confidence,
            source: Some(EventSource::Acoustic),
            acoustic_evidence: Some(AcousticEvidence {
                energy_rms: Some(span.score as f64),
                onset_count: Some(span_onsets.len()),
                onset_rate: Some(span_onsets.len() as f64 / duration.max(0.001)),
                pitch_mean_hz: (!pitch_values.is_empty()).then(|| mean(&pitch_values)),
                pitch_stability,
                spectral_centroid_hz: Some(mean_refs(&span_frames, |frame| {
                    frame.spectral_centroid_hz
                })),
                zero_crossing_rate: Some(mean_refs(&span_frames, |frame| frame.zero_crossing_rate)),
                ..AcousticEvidence::default()
            }),
            evidence: Some(EventEvidence::new(
                format!("prolongation:{}", speech_id(span_index)),
                std::iter::once(speech_id(span_index))
                    .chain(span_onset_ids)
                    .collect(),
                format!(
                    "{duration:.2} s speech-activity interval with {} onset(s){}{}.",
                    span_onsets.len(),
                    if stable {
                        "; pitch or spectral centroid stays stable"
                    } else {
                        ""
                    },
                    if transcript_support {
                        "; an overlapping final transcript segment contains a stretched word"
                    } else {
                        ""
                    },
                ),
            )),
        });
    }
    events
}

fn detect_acoustic_repetitions(
    frames: &[AcousticFrame],
    onsets: &[Onset],
    request: &AnalyzeSpeechRequest,
) -> Vec<StutterEvent> {
    let mut events = Vec::new();
    let mut index = 0;
    while index < onsets.len() {
        let mut end = index + 1;
        while end < onsets.len() && end - index < 5 {
            let interval = onsets[end].timestamp_seconds - onsets[end - 1].timestamp_seconds;
            if !(0.08..=0.35).contains(&interval) {
                break;
            }
            end += 1;
        }
        let cluster = &onsets[index..end];
        if cluster.len() >= 2 {
            let start_seconds = (cluster[0].timestamp_seconds - 0.04).max(0.0);
            let end_seconds = cluster[cluster.len() - 1].timestamp_seconds + 0.12;
            let duration = (end_seconds - start_seconds).max(0.001);
            let intervals = cluster
                .windows(2)
                .map(|pair| pair[1].timestamp_seconds - pair[0].timestamp_seconds)
                .collect::<Vec<_>>();
            let regular = stddev(&intervals) <= 0.08;
            let supported_by_transcript = request.segments.iter().any(|segment| {
                segment.is_final
                    && overlaps(
                        start_seconds,
                        end_seconds,
                        segment.start_seconds,
                        segment.end_seconds,
                    )
                    && has_repeated_transcript_token(&segment.text)
            });
            let strength_values = cluster
                .iter()
                .map(|onset| onset.strength as f64)
                .collect::<Vec<_>>();
            let mut confidence = 0.58_f64
                + if supported_by_transcript { 0.15 } else { 0.0 }
                + if regular { 0.1 } else { 0.0 };
            if mean(&strength_values) >= 0.08 {
                confidence += 0.1;
            }
            let event_frames = frames
                .iter()
                .filter(|frame| {
                    overlaps(
                        frame.start_seconds,
                        frame.end_seconds,
                        start_seconds,
                        end_seconds,
                    )
                })
                .collect::<Vec<_>>();
            let kind = if supported_by_transcript {
                StutterKind::WordRepetition
            } else {
                StutterKind::SoundRepetition
            };
            let prefix = if supported_by_transcript {
                "wordRepetition"
            } else {
                "soundRepetition"
            };
            events.push(StutterEvent {
                kind,
                start_seconds,
                end_seconds,
                text: nearest_text_at(&request.segments, start_seconds, end_seconds)
                    .unwrap_or_else(|| "repeated bursts".to_string()),
                detail: format!("{} repeated onset bursts", cluster.len()),
                confidence: confidence.min(0.95_f64) as f32,
                source: Some(EventSource::Acoustic),
                acoustic_evidence: Some(AcousticEvidence {
                    onset_count: Some(cluster.len()),
                    onset_rate: Some(cluster.len() as f64 / duration),
                    energy_rms: Some(mean_refs(&event_frames, |frame| frame.rms)),
                    spectral_centroid_hz: Some(mean_refs(&event_frames, |frame| {
                        frame.spectral_centroid_hz
                    })),
                    ..AcousticEvidence::default()
                }),
                evidence: Some(EventEvidence::new(
                    format!("{prefix}:{}", onset_id(index)),
                    (index..end).map(onset_id).collect(),
                    format!(
                        "{} onsets 0.08-0.35 s apart{}{}.",
                        cluster.len(),
                        if regular { " at regular intervals" } else { "" },
                        if supported_by_transcript {
                            "; an overlapping final transcript segment repeats a word"
                        } else {
                            ""
                        },
                    ),
                )),
            });
            index = end;
        } else {
            index += 1;
        }
    }
    events
}

fn fuse_events(
    transcript_events: Vec<StutterEvent>,
    acoustic_events: &[StutterEvent],
) -> Vec<StutterEvent> {
    let mut used_acoustic = vec![false; acoustic_events.len()];
    let mut fused = Vec::new();
    for mut text_event in transcript_events {
        if let Some((index, acoustic)) =
            acoustic_events
                .iter()
                .enumerate()
                .find(|(index, candidate)| {
                    !used_acoustic[*index]
                        && candidate.kind == text_event.kind
                        && overlap_seconds(
                            candidate.start_seconds,
                            candidate.end_seconds,
                            text_event.start_seconds,
                            text_event.end_seconds,
                        ) >= 0.1
                })
        {
            used_acoustic[index] = true;
            text_event.start_seconds = text_event.start_seconds.min(acoustic.start_seconds);
            text_event.end_seconds = text_event.end_seconds.max(acoustic.end_seconds);
            text_event.detail = format!("{}; {}", text_event.detail, acoustic.detail);
            text_event.confidence =
                (text_event.confidence.max(acoustic.confidence) + 0.08).min(0.98);
            text_event.source = Some(EventSource::Fused);
            text_event.acoustic_evidence = acoustic.acoustic_evidence.clone();
            if let (Some(text), Some(acoustic)) = (&mut text_event.evidence, &acoustic.evidence) {
                text.supporting.extend(acoustic.supporting.iter().cloned());
                text.explanation = format!(
                    "{} Fused with the overlapping acoustic candidate {}: {}",
                    text.explanation, acoustic.id, acoustic.explanation
                );
            }
        } else {
            text_event.source = text_event.source.or(Some(EventSource::Transcript));
        }
        fused.push(text_event);
    }
    for (index, acoustic) in acoustic_events.iter().enumerate() {
        if !used_acoustic[index] && passes_acoustic_threshold(acoustic) {
            fused.push(acoustic.clone());
        }
    }
    fused
}

fn passes_acoustic_threshold(event: &StutterEvent) -> bool {
    match event.kind {
        StutterKind::SoundRepetition => event.confidence >= 0.68,
        StutterKind::Block | StutterKind::Prolongation => event.confidence >= 0.60,
        _ => event.confidence >= 0.55,
    }
}

fn resample_linear(samples: &[f32], sample_rate: u32, target_sample_rate: u32) -> Vec<f32> {
    if sample_rate == target_sample_rate {
        return samples.to_vec();
    }
    let output_len =
        ((samples.len() as f64 * target_sample_rate as f64) / sample_rate as f64).round() as usize;
    let ratio = sample_rate as f64 / target_sample_rate as f64;
    (0..output_len.max(1))
        .map(|index| {
            let source_index = index as f64 * ratio;
            let left = source_index.floor() as usize;
            let right = (left + 1).min(samples.len().saturating_sub(1));
            let fraction = (source_index - left as f64) as f32;
            samples.get(left).copied().unwrap_or_default() * (1.0 - fraction)
                + samples.get(right).copied().unwrap_or_default() * fraction
        })
        .collect()
}

fn zero_crossing_rate(samples: &[f32]) -> f64 {
    if samples.len() < 2 {
        return 0.0;
    }
    let crossings = samples
        .windows(2)
        .filter(|pair| (pair[0] >= 0.0) != (pair[1] >= 0.0))
        .count();
    crossings as f64 / (samples.len() - 1) as f64
}

fn nearest_text_after(segments: &[TranscriptSegmentInput], seconds: f64) -> Option<String> {
    segments
        .iter()
        .filter(|segment| segment.is_final && segment.start_seconds >= seconds)
        .min_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds))
        .map(|segment| segment.text.clone())
}

fn nearest_text_at(
    segments: &[TranscriptSegmentInput],
    start_seconds: f64,
    end_seconds: f64,
) -> Option<String> {
    segments
        .iter()
        .find(|segment| {
            segment.is_final
                && overlaps(
                    start_seconds,
                    end_seconds,
                    segment.start_seconds,
                    segment.end_seconds,
                )
        })
        .map(|segment| segment.text.clone())
}

fn transcript_has_prolongation(text: &str) -> bool {
    text.split_whitespace().any(|word| {
        let normalized = normalize_token(word);
        longest_character_run(&normalized) >= 4 || word.matches('-').count() >= 2
    })
}

fn has_repeated_transcript_token(text: &str) -> bool {
    let tokens = text
        .split_whitespace()
        .map(normalize_token)
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    tokens.windows(2).any(|pair| pair[0] == pair[1])
}

fn percentile(values: &[f64], quantile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() as f64) * quantile)
        .floor()
        .clamp(0.0, (sorted.len() - 1) as f64) as usize;
    sorted[index]
}

fn median(values: &[f64]) -> f64 {
    percentile(values, 0.5)
}

fn mad(values: &[f64]) -> f64 {
    let center = median(values);
    let deviations = values
        .iter()
        .map(|value| (value - center).abs())
        .collect::<Vec<_>>();
    median(&deviations)
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn mean_refs<T>(values: &[&T], map: impl Fn(&T) -> f64) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().map(|value| map(*value)).sum::<f64>() / values.len() as f64
    }
}

fn stddev(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let center = mean(values);
    (values
        .iter()
        .map(|value| (value - center).powi(2))
        .sum::<f64>()
        / values.len() as f64)
        .sqrt()
}

fn stability_score(values: &[f64]) -> Option<f64> {
    if values.len() < 3 {
        return None;
    }
    let center = mean(values).abs().max(1.0);
    Some((1.0 - (stddev(values) / center)).clamp(0.0, 1.0))
}

/// Tokens of one segment with interpolated times; `segment_index` is the segment's index among
/// all request segments and names the tokens' observation ids.
pub(crate) fn timed_tokens(
    segment_index: usize,
    segment: &TranscriptSegmentInput,
) -> Vec<TimedToken> {
    let raw_tokens = segment
        .text
        .split_whitespace()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    if raw_tokens.is_empty() {
        return Vec::new();
    }

    let duration = (segment.end_seconds - segment.start_seconds).max(0.01);
    let step = duration / raw_tokens.len() as f64;
    raw_tokens
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let start_seconds = segment.start_seconds + step * index as f64;
            TimedToken {
                id: String::new(),
                raw: (*raw).to_string(),
                normalized: normalize_token(raw),
                start_seconds,
                end_seconds: (start_seconds + step).min(segment.end_seconds),
            }
        })
        .filter(|token| !token.normalized.is_empty())
        .enumerate()
        .map(|(index, token)| TimedToken {
            id: token_id(segment_index, index),
            ..token
        })
        .collect()
}

fn detect_repetitions(tokens: &[TimedToken]) -> Vec<StutterEvent> {
    let mut events = Vec::new();
    let mut index = 0;
    while index + 1 < tokens.len() {
        let token = &tokens[index];
        if token.normalized.is_empty() || is_filler(&token.normalized) {
            index += 1;
            continue;
        }
        let mut run_end = index + 1;
        while run_end < tokens.len() && tokens[run_end].normalized == token.normalized {
            run_end += 1;
        }
        if run_end - index >= 2 {
            let end = &tokens[run_end - 1];
            events.push(StutterEvent {
                kind: StutterKind::WordRepetition,
                start_seconds: token.start_seconds,
                end_seconds: end.end_seconds,
                text: tokens[index..run_end]
                    .iter()
                    .map(|item| item.raw.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                detail: "Repeated word sequence".to_string(),
                confidence: 0.86,
                source: Some(EventSource::Transcript),
                acoustic_evidence: None,
                evidence: Some(EventEvidence::new(
                    format!("wordRepetition:{}", token.id),
                    tokens[index..run_end].iter().map(|item| item.id.clone()).collect(),
                    format!(
                        "The same word appears {} times in a row in one final transcript segment; {INTERPOLATED_TIMING_NOTE}",
                        run_end - index
                    ),
                )),
            });
            index = run_end;
            continue;
        }

        if index + 2 < tokens.len() && sound_repetition(token, &tokens[index + 1]) {
            events.push(StutterEvent {
                kind: StutterKind::SoundRepetition,
                start_seconds: token.start_seconds,
                end_seconds: tokens[index + 1].end_seconds,
                text: format!("{} {}", token.raw, tokens[index + 1].raw),
                detail: "Repeated initial sound".to_string(),
                confidence: 0.74,
                source: Some(EventSource::Transcript),
                acoustic_evidence: None,
                evidence: Some(EventEvidence::new(
                    format!("soundRepetition:{}", token.id),
                    vec![token.id.clone(), tokens[index + 1].id.clone()],
                    format!("A short fragment is followed by a word starting with it in one final transcript segment; {INTERPOLATED_TIMING_NOTE}"),
                )),
            });
            index += 2;
            continue;
        }
        index += 1;
    }
    events
}

fn detect_prolongations(tokens: &[TimedToken]) -> Vec<StutterEvent> {
    tokens
        .iter()
        .filter_map(|token| {
            let repeated = longest_character_run(&token.normalized);
            let has_hyphenated_sound = token.raw.matches('-').count() >= 2;
            if repeated >= 4 || has_hyphenated_sound {
                Some(StutterEvent {
                    kind: if has_hyphenated_sound {
                        StutterKind::SoundRepetition
                    } else {
                        StutterKind::Prolongation
                    },
                    start_seconds: token.start_seconds,
                    end_seconds: token.end_seconds,
                    text: token.raw.clone(),
                    detail: if has_hyphenated_sound {
                        "Hyphenated sound repetition".to_string()
                    } else {
                        "Extended sound in word".to_string()
                    },
                    confidence: 0.81,
                    source: Some(EventSource::Transcript),
                    acoustic_evidence: None,
                    evidence: Some(if has_hyphenated_sound {
                        EventEvidence::new(
                            format!("hyphenatedSoundRepetition:{}", token.id),
                            vec![token.id.clone()],
                            format!("The transcript writes the word with two or more hyphenated sound repeats; {INTERPOLATED_TIMING_NOTE}"),
                        )
                    } else {
                        EventEvidence::new(
                            format!("prolongation:{}", token.id),
                            vec![token.id.clone()],
                            format!("The transcript repeats one letter {repeated} times in a row within the word; {INTERPOLATED_TIMING_NOTE}"),
                        )
                    }),
                })
            } else {
                None
            }
        })
        .collect()
}

fn detect_fillers(tokens: &[TimedToken]) -> Vec<StutterEvent> {
    tokens
        .iter()
        .filter(|token| is_filler(&token.normalized))
        .map(|token| StutterEvent {
            kind: StutterKind::Filler,
            start_seconds: token.start_seconds,
            end_seconds: token.end_seconds,
            text: token.raw.clone(),
            detail: "Filler or restart marker".to_string(),
            confidence: 0.61,
            source: Some(EventSource::Transcript),
            acoustic_evidence: None,
            evidence: Some(EventEvidence::new(
                format!("filler:{}", token.id),
                vec![token.id.clone()],
                format!("The transcript token is a listed filler word; {INTERPOLATED_TIMING_NOTE}"),
            )),
        })
        .collect()
}

fn detect_blocks(pauses: &[PauseInput]) -> Vec<StutterEvent> {
    pauses
        .iter()
        .enumerate()
        .filter(|(_, pause)| pause.end_seconds - pause.start_seconds >= 0.75)
        .map(|(index, pause)| StutterEvent {
            kind: StutterKind::Block,
            start_seconds: pause.start_seconds,
            end_seconds: pause.end_seconds,
            text: pause
                .after_text
                .clone()
                .unwrap_or_else(|| "pause".to_string()),
            detail: format!(
                "{:.1}s silent pause before speech",
                pause.end_seconds - pause.start_seconds
            ),
            confidence: 0.66,
            source: Some(EventSource::Transcript),
            acoustic_evidence: None,
            evidence: Some(
                if pause.start_seconds.is_finite() && pause.end_seconds.is_finite() {
                    EventEvidence::new(
                        format!("block:{}", pause_id(index)),
                        vec![pause_id(index)],
                        "The captured pause lasts at least 0.75 s.".to_string(),
                    )
                } else {
                    // Kept as the batch detector reports it; a non-finite pause is no observation.
                    EventEvidence::new(
                        format!("block:{}", pause_id(index)),
                        Vec::new(),
                        "The captured pause has non-finite timing, so no observation supports this block.".to_string(),
                    )
                },
            ),
        })
        .collect()
}

fn speech_stats(
    total_duration_seconds: f64,
    speaking_duration_seconds: f64,
    pauses: &[PauseInput],
    word_count: usize,
    stutter_count: usize,
    chunk_count: usize,
) -> SpeechStats {
    let pause_duration_seconds = pauses
        .iter()
        .map(|pause| (pause.end_seconds - pause.start_seconds).max(0.0))
        .sum::<f64>();
    let minutes = (total_duration_seconds / 60.0).max(1.0 / 60.0);
    let speaking_minutes = (speaking_duration_seconds / 60.0).max(1.0 / 60.0);
    let event_density_per_100_words = if word_count == 0 {
        0.0
    } else {
        stutter_count as f64 / word_count as f64 * 100.0
    };
    SpeechStats {
        speaking_duration_seconds,
        pause_duration_seconds,
        words_per_minute: word_count as f64 / minutes,
        articulation_rate_wpm: word_count as f64 / speaking_minutes,
        mean_chunk_words: if chunk_count == 0 {
            0.0
        } else {
            word_count as f64 / chunk_count as f64
        },
        mean_chunk_duration_seconds: if chunk_count == 0 {
            0.0
        } else {
            speaking_duration_seconds / chunk_count as f64
        },
        event_density_per_100_words,
        fluency_percentage: if word_count == 0 {
            100.0
        } else {
            (100.0 - event_density_per_100_words).clamp(0.0, 100.0)
        },
    }
}

fn blocker_stats(events: &[StutterEvent], total_duration_seconds: f64) -> BlockerStats {
    let block_durations = events
        .iter()
        .filter(|event| event.kind == StutterKind::Block)
        .map(|event| (event.end_seconds - event.start_seconds).max(0.0))
        .collect::<Vec<_>>();
    let block_count = block_durations.len();
    let total_block_seconds = block_durations.iter().sum::<f64>();
    let minutes = (total_duration_seconds / 60.0).max(1.0 / 60.0);
    BlockerStats {
        block_count,
        total_block_seconds,
        average_block_seconds: if block_count == 0 {
            0.0
        } else {
            total_block_seconds / block_count as f64
        },
        longest_block_seconds: block_durations.into_iter().fold(0.0, f64::max),
        blocks_per_minute: block_count as f64 / minutes,
        blocked_time_percentage: if total_duration_seconds <= 0.0 {
            0.0
        } else {
            total_block_seconds / total_duration_seconds * 100.0
        },
    }
}

fn chunk_analysis(
    segments: &[TranscriptSegmentInput],
    pauses: &[PauseInput],
    events: &[StutterEvent],
) -> Vec<ChunkAnalysis> {
    segments
        .iter()
        .filter(|segment| segment.is_final)
        .enumerate()
        .map(|(index, segment)| {
            let tokens = timed_tokens(index, segment);
            let word_count = tokens
                .iter()
                .filter(|token| !is_filler(&token.normalized))
                .count();
            let duration_seconds = (segment.end_seconds - segment.start_seconds).max(0.0);
            let chunk_events = events
                .iter()
                .filter(|event| event_applies_to_segment(event, segment))
                .collect::<Vec<_>>();
            let silent_pause_seconds = pauses
                .iter()
                .map(|pause| {
                    overlap_seconds(
                        pause.start_seconds,
                        pause.end_seconds,
                        segment.start_seconds,
                        segment.end_seconds,
                    )
                })
                .sum::<f64>();
            ChunkAnalysis {
                index,
                start_seconds: segment.start_seconds,
                end_seconds: segment.end_seconds,
                duration_seconds,
                text: segment.text.clone(),
                word_count,
                stutter_count: chunk_events.len(),
                block_count: chunk_events
                    .iter()
                    .filter(|event| event.kind == StutterKind::Block)
                    .count(),
                filler_count: chunk_events
                    .iter()
                    .filter(|event| event.kind == StutterKind::Filler)
                    .count(),
                words_per_minute: word_count as f64 / (duration_seconds / 60.0).max(1.0 / 60.0),
                silent_pause_seconds,
                average_confidence: segment_average_confidence(segment),
            }
        })
        .collect()
}

fn segment_average_confidence(segment: &TranscriptSegmentInput) -> Option<f32> {
    let values = [segment.confidence, segment.speaker_score]
        .into_iter()
        .flatten()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f32>() / values.len() as f32)
    }
}

fn overlaps(left_start: f64, left_end: f64, right_start: f64, right_end: f64) -> bool {
    left_start < right_end && right_start < left_end
}

fn event_applies_to_segment(event: &StutterEvent, segment: &TranscriptSegmentInput) -> bool {
    overlaps(
        event.start_seconds,
        event.end_seconds,
        segment.start_seconds,
        segment.end_seconds,
    ) || (event.kind == StutterKind::Block
        && event.end_seconds <= segment.start_seconds
        && segment.start_seconds - event.end_seconds <= 1.0)
}

fn overlap_seconds(left_start: f64, left_end: f64, right_start: f64, right_end: f64) -> f64 {
    (left_end.min(right_end) - left_start.max(right_start)).max(0.0)
}

pub(crate) fn sound_repetition(left: &TimedToken, right: &TimedToken) -> bool {
    if left.normalized.len() > 2 || right.normalized.len() < 3 {
        return false;
    }
    right.normalized.starts_with(&left.normalized)
}

fn normalize_token(token: &str) -> String {
    token
        .trim_matches(|char: char| !char.is_alphanumeric() && char != '-')
        .to_lowercase()
}

fn longest_character_run(value: &str) -> usize {
    let mut previous = '\0';
    let mut current = 0;
    let mut longest = 0;
    for character in value.chars() {
        if character == previous {
            current += 1;
        } else {
            previous = character;
            current = 1;
        }
        longest = longest.max(current);
    }
    longest
}

pub(crate) fn is_filler(token: &str) -> bool {
    matches!(
        token,
        "um" | "uh" | "erm" | "hm" | "hmm" | "like" | "äh" | "ähm" | "eh"
    )
}

fn validate_samples(samples: &[f32], sample_rate: u32) -> Result<()> {
    if sample_rate == 0 {
        return Err(SpeechAnalysisError::Invalid(
            "sampleRate must be greater than zero".to_string(),
        ));
    }
    if samples.len() < (sample_rate as usize / 4).max(1024) {
        return Err(SpeechAnalysisError::Invalid(
            "at least 250ms of audio samples are required".to_string(),
        ));
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err(SpeechAnalysisError::Invalid(
            "audio samples must be finite".to_string(),
        ));
    }
    Ok(())
}

fn speaker_library(speakers: Vec<SpeakerProfileResult>) -> Result<AudioReferenceLibrary> {
    let mut library = AudioReferenceLibrary::new();
    for speaker in speakers {
        let mut reference = AudioReference::new(speaker.id, speaker.label);
        for values in speaker.embeddings {
            reference.add_embedding(AudioEmbedding::new(values)?)?;
        }
        library.add_reference(reference)?;
    }
    Ok(library)
}

fn speaker_id_from_label(label: &str) -> String {
    let mut id = label
        .chars()
        .filter_map(|character| {
            if character.is_ascii_alphanumeric() {
                Some(character.to_ascii_lowercase())
            } else if character.is_whitespace() || character == '-' || character == '_' {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>();
    while id.contains("--") {
        id = id.replace("--", "-");
    }
    let id = id.trim_matches('-');
    if id.is_empty() {
        "speaker".to_string()
    } else {
        id.to_string()
    }
}

fn classify_severity(rate: f64, word_count: usize, stutter_count: usize) -> Severity {
    if stutter_count == 0 {
        return Severity::None;
    }
    let density = if word_count == 0 {
        0.0
    } else {
        stutter_count as f64 / word_count as f64
    };
    if rate >= 12.0 || density >= 0.18 {
        Severity::High
    } else if rate >= 6.0 || density >= 0.10 {
        Severity::Moderate
    } else {
        Severity::Mild
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_word_repetition_and_prolongation() {
        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: vec![TranscriptSegmentInput {
                text: "I I want to sssstart now".to_string(),
                start_seconds: 0.0,
                end_seconds: 3.0,
                confidence: None,
                speaker_score: None,
                is_final: true,
            }],
            pauses: Vec::new(),
            session_started_at: None,
            samples: None,
            sample_rate: None,
        })
        .unwrap();

        assert_eq!(report.word_count, 6);
        assert!(report
            .events
            .iter()
            .any(|event| event.kind == StutterKind::WordRepetition));
        assert!(report
            .events
            .iter()
            .any(|event| event.kind == StutterKind::Prolongation));
        assert_eq!(report.chunks.len(), 1);
        assert_eq!(report.chunks[0].word_count, 6);
        assert!(report.speech_stats.words_per_minute > 0.0);
    }

    #[test]
    fn detects_blocks_from_pauses() {
        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: Vec::new(),
            pauses: vec![PauseInput {
                start_seconds: 1.0,
                end_seconds: 2.0,
                after_text: Some("then".to_string()),
            }],
            session_started_at: None,
            samples: None,
            sample_rate: None,
        })
        .unwrap();

        assert_eq!(report.stutter_count, 1);
        assert_eq!(report.events[0].kind, StutterKind::Block);
        assert_eq!(report.blocker_stats.block_count, 1);
        assert_eq!(report.blocker_stats.total_block_seconds, 1.0);
        assert_eq!(report.blocker_stats.longest_block_seconds, 1.0);
    }

    #[test]
    fn detects_silent_block_from_audio() {
        let sample_rate = 16_000;
        let samples = joined(vec![
            sine_wave(220.0, sample_rate, 0.6),
            vec![0.0; (sample_rate as f32 * 0.7) as usize],
            sine_wave(220.0, sample_rate, 0.6),
        ]);

        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: vec![TranscriptSegmentInput {
                text: "then".to_string(),
                start_seconds: 1.3,
                end_seconds: 1.9,
                confidence: None,
                speaker_score: None,
                is_final: true,
            }],
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(samples),
            sample_rate: Some(sample_rate),
        })
        .unwrap();

        assert!(report.acoustic_stats.is_some());
        assert!(report.events.iter().any(|event| {
            event.kind == StutterKind::Block && event.source == Some(EventSource::Acoustic)
        }));
    }

    #[test]
    fn standalone_capture_metrics_match_the_analysis_report() {
        let sample_rate = 16_000;
        let mut samples = joined(vec![
            sine_wave(220.0, sample_rate, 1.0),
            vec![0.0; sample_rate as usize],
        ]);
        samples[100] = 1.5;
        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: Vec::new(),
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(samples.clone()),
            sample_rate: Some(sample_rate),
        })
        .unwrap();
        let standalone = capture_metrics_impl(CaptureMetricsRequest {
            samples,
            sample_rate,
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(standalone).unwrap(),
            serde_json::to_value(report.capture_metrics.unwrap()).unwrap()
        );
        assert!(capture_metrics_impl(CaptureMetricsRequest {
            samples: vec![0.0; 10],
            sample_rate: 0,
        })
        .is_err());
    }

    #[test]
    fn reports_capture_metrics_of_the_unclamped_analyzed_window() {
        let sample_rate = 16_000;
        let mut samples = joined(vec![
            sine_wave(220.0, sample_rate, 1.0),
            vec![0.0; sample_rate as usize],
        ]);
        samples[100] = 1.5;
        let without_audio = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: Vec::new(),
            pauses: Vec::new(),
            session_started_at: None,
            samples: None,
            sample_rate: None,
        })
        .unwrap();
        assert!(without_audio.capture_metrics.is_none());

        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: Vec::new(),
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(samples),
            sample_rate: Some(sample_rate),
        })
        .unwrap();
        let metrics = report.capture_metrics.expect("capture metrics");
        assert_eq!(metrics.sample_rate, sample_rate);
        assert_eq!(metrics.channels, 1);
        assert!((metrics.duration_seconds - 2.0).abs() < 1e-9);
        assert_eq!(metrics.clipped_sample_count, 1);
        assert!((metrics.no_input_seconds - 1.0).abs() < 0.021);
        assert!((metrics.activity_seconds - 1.0).abs() < 0.021);

        let short = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: Vec::new(),
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(vec![0.1; 800]),
            sample_rate: Some(sample_rate),
        })
        .unwrap();
        assert!(short.acoustic_stats.is_none());
        let metrics = short.capture_metrics.expect("short capture metrics");
        assert!((metrics.duration_seconds - 0.05).abs() < 1e-9);

        let long = vec![0.0; sample_rate as usize * (ANALYZED_AUDIO_SECONDS + 5)];
        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: Vec::new(),
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(long),
            sample_rate: Some(sample_rate),
        })
        .unwrap();
        let metrics = report.capture_metrics.expect("capture metrics");
        assert!((metrics.duration_seconds - ANALYZED_AUDIO_SECONDS as f64).abs() < 1e-9);
    }

    #[test]
    fn detects_audio_prolongation() {
        let sample_rate = 16_000;
        let samples = sine_wave(180.0, sample_rate, 0.9);

        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: vec![TranscriptSegmentInput {
                text: "start".to_string(),
                start_seconds: 0.0,
                end_seconds: 0.9,
                confidence: None,
                speaker_score: None,
                is_final: true,
            }],
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(samples),
            sample_rate: Some(sample_rate),
        })
        .unwrap();

        assert!(report.events.iter().any(|event| {
            event.kind == StutterKind::Prolongation && event.source == Some(EventSource::Acoustic)
        }));
    }

    fn repeated_bursts_request() -> AnalyzeSpeechRequest {
        let sample_rate = 16_000;
        let mut samples = Vec::new();
        for _ in 0..3 {
            samples.extend(sine_wave(440.0, sample_rate, 0.08));
            samples.extend(vec![0.0; (sample_rate as f32 * 0.12) as usize]);
        }
        AnalyzeSpeechRequest {
            segments: vec![TranscriptSegmentInput {
                text: "start".to_string(),
                start_seconds: 0.0,
                end_seconds: 0.6,
                confidence: None,
                speaker_score: None,
                is_final: true,
            }],
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(samples),
            sample_rate: Some(sample_rate),
        }
    }

    fn audio_only_sound_repetition(event: &StutterEvent) -> bool {
        event.kind == StutterKind::SoundRepetition && event.source == Some(EventSource::Acoustic)
    }

    #[test]
    fn detects_repeated_acoustic_bursts() {
        let (report, _) =
            analyze_with_evidence(repeated_bursts_request(), EvidencePolicy::ReportAll).unwrap();
        assert!(report.events.iter().any(audio_only_sound_repetition));
    }

    #[test]
    fn audio_only_sound_repetitions_are_withheld_and_left_out_of_counts() {
        let (all, _) =
            analyze_with_evidence(repeated_bursts_request(), EvidencePolicy::ReportAll).unwrap();
        let report = analyze_speech_session_impl(repeated_bursts_request()).unwrap();

        assert!(!report.events.iter().any(audio_only_sound_repetition));
        assert!(!report.insufficient_evidence.is_empty());
        for possible in &report.insufficient_evidence {
            assert_eq!(possible.reason, InsufficientEvidenceReason::AudioOnly);
            assert!(audio_only_sound_repetition(&possible.candidate));
            assert!(possible.candidate.evidence.is_some());
        }
        // Withholding only partitions the events; counts cover the reported ones alone.
        let key = |event: &StutterEvent| (event.kind, event.start_seconds.to_bits());
        let mut partitioned = report
            .events
            .iter()
            .chain(
                report
                    .insufficient_evidence
                    .iter()
                    .map(|possible| &possible.candidate),
            )
            .map(key)
            .collect::<Vec<_>>();
        let mut reported_all = all.events.iter().map(key).collect::<Vec<_>>();
        partitioned.sort_by_key(|(kind, start)| (*start, format!("{kind:?}")));
        reported_all.sort_by_key(|(kind, start)| (*start, format!("{kind:?}")));
        assert_eq!(partitioned, reported_all);
        assert_eq!(report.stutter_count, report.events.len());
        assert!(report.stutter_count < all.stutter_count);
        assert_eq!(report.by_kind.get(&StutterKind::SoundRepetition), None);
    }

    #[test]
    fn fuses_transcript_and_acoustic_prolongation() {
        let sample_rate = 16_000;
        let samples = sine_wave(180.0, sample_rate, 0.9);

        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: vec![TranscriptSegmentInput {
                text: "ssssstart".to_string(),
                start_seconds: 0.0,
                end_seconds: 0.9,
                confidence: None,
                speaker_score: None,
                is_final: true,
            }],
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(samples),
            sample_rate: Some(sample_rate),
        })
        .unwrap();

        let prolongations = report
            .events
            .iter()
            .filter(|event| event.kind == StutterKind::Prolongation)
            .collect::<Vec<_>>();
        assert_eq!(prolongations.len(), 1);
        assert_eq!(prolongations[0].source, Some(EventSource::Fused));
        assert!(prolongations[0].acoustic_evidence.is_some());
    }

    #[test]
    fn rejects_invalid_analysis_audio() {
        let error = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: Vec::new(),
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(vec![0.0, f32::NAN]),
            sample_rate: Some(0),
        })
        .unwrap_err();

        assert!(error.to_string().contains("sampleRate"));
    }

    #[test]
    fn identifies_enrolled_speaker_profile() {
        let sample_rate = 8_000;
        let samples = sine_wave(440.0, sample_rate, 0.6);
        let profile = create_speaker_profile_impl(SpeakerProfileRequest {
            id: Some("speaker-a".to_string()),
            label: "Speaker A".to_string(),
            samples: samples.clone(),
            sample_rate,
        })
        .unwrap();

        let result = identify_speaker_impl(SpeakerIdentificationRequest {
            samples,
            sample_rate,
            speakers: vec![profile],
            threshold: Some(0.8),
            max_results: Some(1),
        })
        .unwrap();

        assert_eq!(
            result
                .best_match
                .as_ref()
                .map(|item| item.speaker_id.as_str()),
            Some("speaker-a")
        );
        assert!(result.is_match);
    }

    fn sine_wave(frequency: f32, sample_rate: u32, seconds: f32) -> Vec<f32> {
        let count = (sample_rate as f32 * seconds) as usize;
        (0..count)
            .map(|index| {
                let phase = index as f32 * frequency * std::f32::consts::TAU / sample_rate as f32;
                phase.sin() * 0.4
            })
            .collect()
    }

    fn joined(chunks: Vec<Vec<f32>>) -> Vec<f32> {
        chunks.into_iter().flatten().collect()
    }
}
