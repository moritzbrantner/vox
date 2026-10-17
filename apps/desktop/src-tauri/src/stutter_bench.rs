use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::speech_analysis::{AnalyzeSpeechRequest, SpeechAnalysisError, StutterKind};

const BENCHMARK_KINDS: [StutterKind; 5] = [
    StutterKind::WordRepetition,
    StutterKind::SoundRepetition,
    StutterKind::Prolongation,
    StutterKind::Block,
    StutterKind::Filler,
];

#[derive(Debug, thiserror::Error)]
pub(crate) enum BenchmarkError {
    #[error("vote threshold must be between 1 and 3")]
    InvalidVoteThreshold,
    #[error("evaluation fraction must be between 0 and 1")]
    InvalidEvaluationFraction,
    #[error("benchmark clip `{0}` has an invalid duration")]
    InvalidDuration(String),
    #[error("speaker-safe splitting requires explicit speaker metadata for every clip")]
    MissingSpeaker,
    #[error("clip `{clip_id}` is missing a complete probability vector")]
    IncompleteProbabilityVector { clip_id: String },
    #[error("probability for {kind:?} in clip `{clip_id}` must be between 0 and 1")]
    InvalidProbability { clip_id: String, kind: StutterKind },
    #[error("existing detector baseline failed: {0}")]
    Detector(String),
    #[error("cannot read {path}: {message}")]
    Io { path: String, message: String },
    #[error("{path}:{line}: {message}")]
    Csv {
        path: String,
        line: usize,
        message: String,
    },
    #[error("corpus manifest lists clip `{0}` more than once")]
    DuplicateClip(String),
    #[error("speaker mapping lists clip `{0}` more than once")]
    DuplicateSpeakerMapping(String),
    #[error("labels contain no clip rows")]
    EmptyManifest,
    #[error("the row limit must be at least 1")]
    ZeroLimit,
    #[error("clips directory {0} does not exist or is not a directory")]
    ClipsDirectory(String),
    #[error("a label row has an empty {0}")]
    EmptyIdentity(&'static str),
    #[error("clip `{0}` needs numeric Start/Stop sample offsets with Stop > Start")]
    InvalidBounds(String),
    #[error("labels are missing required SEP-28k column `{0}`")]
    MissingColumn(&'static str),
    #[error("clip `{clip_id}` has invalid {column} value `{value}` (expected 0-3)")]
    InvalidVote {
        clip_id: String,
        column: &'static str,
        value: String,
    },
}

#[derive(Debug, Clone)]
struct BenchmarkClip {
    id: String,
    speaker_id: Option<String>,
    duration_seconds: f64,
    reference_kinds: Vec<StutterKind>,
    predicted_kinds: Vec<StutterKind>,
    predicted_probabilities: Option<HashMap<StutterKind, f64>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct KindMetrics {
    true_positive: usize,
    false_positive: usize,
    false_negative: usize,
    true_negative: usize,
    precision: f64,
    recall: f64,
    f1: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    clip_count: usize,
    speaker_count: usize,
    micro_precision: f64,
    micro_recall: f64,
    micro_f1: f64,
    macro_f1: f64,
    false_positive_clip_rate: f64,
    brier_score: Option<f64>,
    #[serde(serialize_with = "serialize_by_kind")]
    by_kind: HashMap<StutterKind, KindMetrics>,
}

type Sep28kRow = HashMap<String, String>;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Sep28kFlags {
    no_stutter: bool,
    unsure: bool,
    poor_audio_quality: bool,
    difficult_to_understand: bool,
    natural_pause: bool,
    music: bool,
    no_speech: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Sep28kManifestEntry {
    id: String,
    show: String,
    episode_id: String,
    clip_id: String,
    start_sample: Option<u64>,
    stop_sample: Option<u64>,
    speaker_id: Option<String>,
    reference_kinds: Vec<StutterKind>,
    annotation_votes: HashMap<StutterKind, u8>,
    flags: Sep28kFlags,
}

#[derive(Debug, Clone)]
struct BaselineCase {
    id: String,
    speaker_id: Option<String>,
    reference_kinds: Vec<StutterKind>,
    request: AnalyzeSpeechRequest,
}

fn normalize_sep28k_row(
    row: &Sep28kRow,
    vote_threshold: u8,
    speaker_id: Option<&str>,
) -> Result<Sep28kManifestEntry, BenchmarkError> {
    if !(1..=3).contains(&vote_threshold) {
        return Err(BenchmarkError::InvalidVoteThreshold);
    }

    let show = first(row, &["Show", "show"]).unwrap_or("unknown-show");
    let episode_id = first(row, &["EpId", "episodeId", "episode_id"]).unwrap_or("unknown-episode");
    let clip_id = first(row, &["ClipId", "clipId", "clip_id"]).unwrap_or("unknown-clip");
    let speaker_id = speaker_id.map(str::to_owned).or_else(|| {
        first(row, &["speaker", "Speaker", "speakerId", "speaker_id"]).map(str::to_owned)
    });

    let annotation_votes = BENCHMARK_KINDS
        .into_iter()
        .map(|kind| (kind, sep28k_votes(row, kind)))
        .collect::<HashMap<_, _>>();
    let reference_kinds = BENCHMARK_KINDS
        .into_iter()
        .filter(|kind| annotation_votes.get(kind).copied().unwrap_or_default() >= vote_threshold)
        .collect();

    Ok(Sep28kManifestEntry {
        id: format!("{show}:{episode_id}:{clip_id}"),
        show: show.to_owned(),
        episode_id: episode_id.to_owned(),
        clip_id: clip_id.to_owned(),
        start_sample: unsigned(row, &["Start", "start"]),
        stop_sample: unsigned(row, &["Stop", "stop"]),
        speaker_id,
        reference_kinds,
        annotation_votes,
        flags: Sep28kFlags {
            no_stutter: selected(
                row,
                &["NoStutteredWords", "NoStutter", "No Stuttered Words"],
                vote_threshold,
            ),
            unsure: selected(row, &["Unsure"], vote_threshold),
            poor_audio_quality: selected(
                row,
                &["PoorAudioQuality", "Poor Audio Quality"],
                vote_threshold,
            ),
            difficult_to_understand: selected(
                row,
                &["DifficultToUnderstand", "Difficult To Understand"],
                vote_threshold,
            ),
            natural_pause: selected(row, &["NaturalPause", "Natural Pause"], vote_threshold),
            music: selected(row, &["Music"], vote_threshold),
            no_speech: selected(row, &["NoSpeech", "No Speech"], vote_threshold),
        },
    })
}

fn should_evaluate_sep28k(entry: &Sep28kManifestEntry) -> bool {
    !(entry.flags.unsure
        || entry.flags.poor_audio_quality
        || entry.flags.difficult_to_understand
        || entry.flags.music
        || entry.flags.no_speech)
}

fn evaluate_clips(clips: &[BenchmarkClip]) -> Result<BenchmarkReport, BenchmarkError> {
    evaluate_clip_refs(&clips.iter().collect::<Vec<_>>())
}

/// Same as `evaluate_clips`, over borrowed clips (bootstrap resamples repeat clips).
fn evaluate_clip_refs(clips: &[&BenchmarkClip]) -> Result<BenchmarkReport, BenchmarkError> {
    let mut by_kind = BENCHMARK_KINDS
        .into_iter()
        .map(|kind| (kind, KindMetrics::default()))
        .collect::<HashMap<_, _>>();
    let score_calibration = clips
        .iter()
        .any(|clip| clip.predicted_probabilities.is_some());
    let mut false_positive_fluent_clips = 0_usize;
    let mut fluent_clip_count = 0_usize;
    let mut brier_sum = 0.0_f64;

    for clip in clips {
        if !clip.duration_seconds.is_finite() || clip.duration_seconds <= 0.0 {
            return Err(BenchmarkError::InvalidDuration(clip.id.clone()));
        }

        let references = clip.reference_kinds.iter().copied().collect::<HashSet<_>>();
        let predictions = clip.predicted_kinds.iter().copied().collect::<HashSet<_>>();
        if references.is_empty() {
            fluent_clip_count += 1;
            if !predictions.is_empty() {
                false_positive_fluent_clips += 1;
            }
        }

        let probabilities = if score_calibration {
            Some(clip.predicted_probabilities.as_ref().ok_or_else(|| {
                BenchmarkError::IncompleteProbabilityVector {
                    clip_id: clip.id.clone(),
                }
            })?)
        } else {
            None
        };

        for kind in BENCHMARK_KINDS {
            let expected = references.contains(&kind);
            let predicted = predictions.contains(&kind);
            let metrics = by_kind
                .get_mut(&kind)
                .expect("all benchmark kinds are initialized");
            match (expected, predicted) {
                (true, true) => metrics.true_positive += 1,
                (false, true) => metrics.false_positive += 1,
                (true, false) => metrics.false_negative += 1,
                (false, false) => metrics.true_negative += 1,
            }

            if let Some(probabilities) = probabilities {
                let probability = probabilities.get(&kind).copied().ok_or_else(|| {
                    BenchmarkError::IncompleteProbabilityVector {
                        clip_id: clip.id.clone(),
                    }
                })?;
                if !probability.is_finite() || !(0.0..=1.0).contains(&probability) {
                    return Err(BenchmarkError::InvalidProbability {
                        clip_id: clip.id.clone(),
                        kind,
                    });
                }
                brier_sum += (probability - if expected { 1.0 } else { 0.0 }).powi(2);
            }
        }
    }

    let mut true_positive = 0_usize;
    let mut false_positive = 0_usize;
    let mut false_negative = 0_usize;
    for kind in BENCHMARK_KINDS {
        let metrics = by_kind
            .get_mut(&kind)
            .expect("all benchmark kinds are initialized");
        metrics.precision = ratio(
            metrics.true_positive,
            metrics.true_positive + metrics.false_positive,
        );
        metrics.recall = ratio(
            metrics.true_positive,
            metrics.true_positive + metrics.false_negative,
        );
        metrics.f1 = f1(metrics.precision, metrics.recall);
        true_positive += metrics.true_positive;
        false_positive += metrics.false_positive;
        false_negative += metrics.false_negative;
    }

    let micro_precision = ratio(true_positive, true_positive + false_positive);
    let micro_recall = ratio(true_positive, true_positive + false_negative);
    let speaker_count = clips
        .iter()
        .filter_map(|clip| clip.speaker_id.as_deref())
        .collect::<HashSet<_>>()
        .len();

    Ok(BenchmarkReport {
        clip_count: clips.len(),
        speaker_count,
        micro_precision,
        micro_recall,
        micro_f1: f1(micro_precision, micro_recall),
        macro_f1: BENCHMARK_KINDS
            .into_iter()
            .map(|kind| by_kind.get(&kind).expect("benchmark kind exists").f1)
            .sum::<f64>()
            / BENCHMARK_KINDS.len() as f64,
        false_positive_clip_rate: ratio(false_positive_fluent_clips, fluent_clip_count),
        brier_score: score_calibration
            .then(|| ratio_f64(brier_sum, clips.len().saturating_mul(BENCHMARK_KINDS.len()))),
        by_kind,
    })
}

fn speaker_safe_split(
    clips: &[BenchmarkClip],
    evaluation_fraction: f64,
    seed: &str,
) -> Result<(Vec<BenchmarkClip>, Vec<BenchmarkClip>), BenchmarkError> {
    if !evaluation_fraction.is_finite()
        || !(0.0..1.0).contains(&evaluation_fraction)
        || evaluation_fraction == 0.0
    {
        return Err(BenchmarkError::InvalidEvaluationFraction);
    }

    let mut train = Vec::new();
    let mut evaluation = Vec::new();
    for clip in clips {
        let speaker_id = clip
            .speaker_id
            .as_deref()
            .map(str::trim)
            .filter(|speaker| !speaker.is_empty())
            .ok_or(BenchmarkError::MissingSpeaker)?;
        let bucket = stable_hash(&format!("{seed}:{speaker_id}")) as f64 / 4_294_967_296.0;
        if bucket < evaluation_fraction {
            evaluation.push(clip.clone());
        } else {
            train.push(clip.clone());
        }
    }
    Ok((train, evaluation))
}

fn evaluate_existing_detector(cases: &[BaselineCase]) -> Result<BenchmarkReport, BenchmarkError> {
    let mut clips = Vec::with_capacity(cases.len());
    for case in cases {
        let report = crate::speech_pipeline::analyze_speech_session(case.request.clone())
            .map_err(|error| BenchmarkError::Detector(error.to_string()))?;
        let observed = report
            .events
            .iter()
            .map(|event| event.kind)
            .collect::<HashSet<_>>();
        let predicted_kinds = BENCHMARK_KINDS
            .into_iter()
            .filter(|kind| observed.contains(kind))
            .collect();
        clips.push(BenchmarkClip {
            id: case.id.clone(),
            speaker_id: case.speaker_id.clone(),
            duration_seconds: report.total_duration_seconds.max(0.001),
            reference_kinds: case.reference_kinds.clone(),
            predicted_kinds,
            predicted_probabilities: None,
        });
    }
    evaluate_clips(&clips)
}

fn sep28k_votes(row: &Sep28kRow, kind: StutterKind) -> u8 {
    let columns: &[&str] = match kind {
        StutterKind::WordRepetition => &["WordRep", "WordRepetition"],
        StutterKind::SoundRepetition => &["SoundRep", "SoundRepetition"],
        StutterKind::Prolongation => &["Prolongation"],
        StutterKind::Block => &["Block"],
        StutterKind::Filler => &["Interjection", "Filler"],
    };
    vote(row, columns)
}

fn selected(row: &Sep28kRow, columns: &[&str], threshold: u8) -> bool {
    vote(row, columns) >= threshold
}

fn vote(row: &Sep28kRow, columns: &[&str]) -> u8 {
    first(row, columns)
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or_default()
}

fn unsigned(row: &Sep28kRow, columns: &[&str]) -> Option<u64> {
    first(row, columns).and_then(|value| value.parse::<u64>().ok())
}

fn first<'a>(row: &'a Sep28kRow, columns: &[&str]) -> Option<&'a str> {
    columns.iter().find_map(|column| {
        row.get(*column)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    })
}

fn stable_hash(value: &str) -> u32 {
    let mut hash = 0x811c9dc5_u32;
    for byte in value.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn ratio_f64(numerator: f64, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator / denominator as f64
    }
}

fn f1(precision: f64, recall: f64) -> f64 {
    if precision + recall == 0.0 {
        0.0
    } else {
        2.0 * precision * recall / (precision + recall)
    }
}

// ---------------------------------------------------------------------------------------------
// Filesystem corpus runner. Reads a SEP-28k label CSV and locally provided clip audio, runs the
// existing detector and emits a scored report. It never downloads corpus media.
// ---------------------------------------------------------------------------------------------

const DEFAULT_EVALUATION_FRACTION: f64 = 0.2;
const BOOTSTRAP_RESAMPLES: usize = 1_000;
const BOOTSTRAP_SEED: &str = "sep28k-bootstrap-v1";
const ERROR_SAMPLE_SEED: &str = "sep28k-error-review-v1";
const ERROR_SAMPLE_PER_KIND: usize = 10;
const CHALLENGE_REASONS: [&str; 3] = ["poorAudioQuality", "difficultToUnderstand", "music"];
/// SEP-28k `Start`/`Stop` are sample offsets into the 16 kHz episode audio.
const SEP28K_SAMPLE_RATE: u32 = 16_000;
/// Allowed relative difference between decoded and labelled clip duration.
const DURATION_TOLERANCE: f64 = 0.05;
const PARTITION_SEED: &str = "sep28k-partition-v1";
const LISTED_ID_LIMIT: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetectorRevision {
    /// `git rev-parse HEAD` of this repository.
    pub(crate) commit: String,
    /// Uncommitted changes were present, so `commit` alone does not identify the code.
    pub(crate) dirty: bool,
    /// SHA-256 of `.coding-tooling.source-deps.json` (exact capability-source revisions).
    pub(crate) source_pins_sha256: Option<String>,
    /// Whether exact local sources were active (`.cargo/config.toml` present).
    pub(crate) source_mode: bool,
    /// SHA-256 of the effective `Cargo.lock` the detector was built with.
    pub(crate) lockfile_sha256: Option<String>,
    /// The sibling checkouts actually compiled in source mode, with their HEAD and local changes.
    pub(crate) capability_sources: Vec<SourceCheckout>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceCheckout {
    pub(crate) name: String,
    pub(crate) commit: String,
    pub(crate) dirty: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct CorpusRunOptions {
    pub(crate) labels_csv: PathBuf,
    pub(crate) clips_dir: PathBuf,
    /// Verified clip → speaker mapping (`clipId,speakerId`, clip ids as `Show:EpId:ClipId`).
    pub(crate) speakers_csv: Option<PathBuf>,
    pub(crate) vote_threshold: u8,
    pub(crate) limit: Option<usize>,
    pub(crate) detector_revision: Option<DetectorRevision>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CorpusRunReport {
    schema_version: u32,
    corpus: CorpusIdentity,
    configuration: RunConfiguration,
    counts: CorpusCounts,
    /// Reference positives and detector predictions per kind over the scored clips.
    prevalence: BTreeMap<String, KindPrevalence>,
    partition: PartitionSummary,
    /// Metrics over every scored clip. The detector is not trained on this corpus.
    all_scored: Option<BenchmarkReport>,
    /// Metrics over the speaker-exclusive held-out partition, when a verified mapping exists.
    held_out: Option<BenchmarkReport>,
    /// Bootstrap 95% intervals for `all_scored` and `held_out`.
    all_scored_intervals: Option<MetricIntervals>,
    held_out_intervals: Option<MetricIntervals>,
    /// Robustness challenge set: clips excluded only for poor audio, difficult speech or music.
    /// Reported apart from the main results and never used to choose between candidates.
    challenge: Option<BenchmarkReport>,
    /// Which clips `error_review` samples: "train" when a held-out partition exists, otherwise
    /// "allScored" (and then no result is a protected held-out estimate).
    error_review_scope: &'static str,
    /// Deterministic sample of misclassified clip ids per kind, for manual review (no media).
    error_review: BTreeMap<String, ErrorSample>,
    missing_clip_ids: Vec<String>,
    unreadable_clip_ids: Vec<String>,
    limitations: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricIntervals {
    /// "speaker" when every clip has a verified speaker (cluster bootstrap), otherwise "clip".
    resampling_unit: &'static str,
    resamples: usize,
    seed: &'static str,
    micro_f1: Interval,
    macro_f1: Interval,
    /// Over draws that contain at least one fluent clip; null if none did.
    false_positive_clip_rate: Option<Interval>,
    /// Per kind, over draws with at least one reference positive; null if none had one.
    f1_by_kind: BTreeMap<String, Option<Interval>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
struct Interval {
    lower: f64,
    upper: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorSample {
    false_positives: Vec<String>,
    false_negatives: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusIdentity {
    name: &'static str,
    labels_sha256: String,
    label_rows: usize,
    speaker_mapping_sha256: Option<String>,
    /// SHA-256 over the sorted (clip id, WAV file SHA-256) pairs of every scored clip.
    scored_audio_sha256: Option<String>,
    /// The same over the scored robustness challenge clips.
    challenge_audio_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunConfiguration {
    detector: &'static str,
    /// Code that produced the predictions; supplied by the caller (git and source-pin state).
    detector_revision: Option<DetectorRevision>,
    detector_input: &'static str,
    vote_threshold: u8,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusCounts {
    /// Rows in the label file.
    rows: usize,
    /// Rows read in this run (fewer than `rows` under `--limit`); the counts below add up to it.
    processed_rows: usize,
    /// Rows excluded by at least one flag or for lacking an affirmative label.
    excluded_rows: usize,
    /// Per reason; a row with several flags counts under each, so these may exceed excluded_rows.
    excluded: BTreeMap<&'static str, usize>,
    missing_audio: usize,
    unreadable_audio: usize,
    scored: usize,
    fluent_scored: usize,
    /// Excluded rows flagged only for audio or understandability (the robustness challenge set).
    challenge_rows: usize,
    /// Challenge rows whose audio was missing or unreadable.
    challenge_unavailable: usize,
    challenge_scored: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct KindPrevalence {
    reference: usize,
    predicted: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
enum PartitionSummary {
    /// No verified mapping: results are not speaker-exclusive and say so.
    NotSpeakerExclusive { reason: String },
    SpeakerExclusive {
        seed: &'static str,
        evaluation_fraction: f64,
        train_clips: usize,
        evaluation_clips: usize,
        train_speakers: usize,
        evaluation_speakers: usize,
    },
}

pub(crate) fn run_sep28k_corpus(
    options: &CorpusRunOptions,
) -> Result<CorpusRunReport, BenchmarkError> {
    if options.limit == Some(0) {
        return Err(BenchmarkError::ZeroLimit);
    }
    if !options.clips_dir.is_dir() {
        return Err(BenchmarkError::ClipsDirectory(
            options.clips_dir.display().to_string(),
        ));
    }
    let labels = read_file(&options.labels_csv)?;
    let rows = parse_csv(&labels, &options.labels_csv)?;
    let speaker_file = options
        .speakers_csv
        .as_ref()
        .map(|path| read_file(path).map(|text| (path, text)))
        .transpose()?;
    let speakers = speaker_file
        .as_ref()
        .map(|(path, text)| parse_speaker_mapping(text, path))
        .transpose()?;

    let mut counts = CorpusCounts {
        rows: rows.len(),
        ..CorpusCounts::default()
    };
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    let mut unreadable = Vec::new();
    let mut clips = Vec::new();
    let mut audio_digests = Vec::new();
    let mut challenge_clips = Vec::new();
    let mut challenge_digests = Vec::new();
    // The header is checked on its own so an empty or header-only manifest cannot pass.
    let header = labels
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.split(',').map(str::trim).collect::<HashSet<_>>())
        .unwrap_or_default();
    for column in SEP28K_REQUIRED_COLUMNS.into_iter().chain(["Start", "Stop"]) {
        if !header.contains(column) {
            return Err(BenchmarkError::MissingColumn(column));
        }
    }
    if rows.is_empty() {
        return Err(BenchmarkError::EmptyManifest);
    }
    for row in rows.iter().take(options.limit.unwrap_or(usize::MAX)) {
        counts.processed_rows += 1;
        validate_sep28k_votes(row)?;
        let mut entry = normalize_sep28k_row(row, options.vote_threshold, None)?;
        // Every row is validated, including rows excluded or missing audio below.
        let (Some(start), Some(stop)) = (entry.start_sample, entry.stop_sample) else {
            return Err(BenchmarkError::InvalidBounds(entry.id));
        };
        if stop <= start {
            return Err(BenchmarkError::InvalidBounds(entry.id));
        }
        if !seen.insert(entry.id.clone()) {
            return Err(BenchmarkError::DuplicateClip(entry.id));
        }
        entry.speaker_id = speakers
            .as_ref()
            .and_then(|mapping| mapping.get(&entry.id).cloned());
        let reasons = exclusion_reasons(&entry);
        if !reasons.is_empty() {
            counts.excluded_rows += 1;
            for reason in &reasons {
                *counts.excluded.entry(reason).or_default() += 1;
            }
            // Clips excluded only for audio/understandability flags form the robustness
            // challenge set, scored apart from the main results.
            if reasons
                .iter()
                .all(|reason| CHALLENGE_REASONS.contains(reason))
            {
                counts.challenge_rows += 1;
                match score_clip(&options.clips_dir, entry, stop - start)? {
                    ClipOutcome::Scored(clip, digest) => {
                        challenge_digests.push(digest);
                        challenge_clips.push(*clip);
                    }
                    ClipOutcome::Missing(_) | ClipOutcome::Unreadable(_) => {
                        counts.challenge_unavailable += 1
                    }
                }
            }
            continue;
        }
        match score_clip(&options.clips_dir, entry, stop - start)? {
            ClipOutcome::Scored(clip, digest) => {
                audio_digests.push(digest);
                clips.push(*clip);
            }
            ClipOutcome::Missing(id) => {
                counts.missing_audio += 1;
                missing.push(id);
            }
            ClipOutcome::Unreadable(id) => {
                counts.unreadable_audio += 1;
                unreadable.push(id);
            }
        }
    }

    counts.scored = clips.len();
    counts.fluent_scored = clips
        .iter()
        .filter(|clip| clip.reference_kinds.is_empty())
        .count();
    let prevalence = BENCHMARK_KINDS
        .into_iter()
        .map(|kind| {
            (
                kind_name(kind).to_owned(),
                KindPrevalence {
                    reference: clips
                        .iter()
                        .filter(|clip| clip.reference_kinds.contains(&kind))
                        .count(),
                    predicted: clips
                        .iter()
                        .filter(|clip| clip.predicted_kinds.contains(&kind))
                        .count(),
                },
            )
        })
        .collect();

    let (partition, held_out) = match &speakers {
        None => (
            PartitionSummary::NotSpeakerExclusive {
                reason: "no verified speaker mapping was supplied".to_owned(),
            },
            None,
        ),
        Some(_) if clips.iter().any(|clip| clip.speaker_id.is_none()) => (
            PartitionSummary::NotSpeakerExclusive {
                reason: format!(
                    "{} scored clips have no verified speaker",
                    clips
                        .iter()
                        .filter(|clip| clip.speaker_id.is_none())
                        .count()
                ),
            },
            None,
        ),
        Some(_) if speaker_count(&clips) < 2 => (
            PartitionSummary::NotSpeakerExclusive {
                reason: "fewer than two verified speakers among the scored clips".to_owned(),
            },
            None,
        ),
        Some(_) => {
            let (train, evaluation) =
                held_out_speaker_split(&clips, DEFAULT_EVALUATION_FRACTION, PARTITION_SEED);
            let summary = PartitionSummary::SpeakerExclusive {
                seed: PARTITION_SEED,
                evaluation_fraction: DEFAULT_EVALUATION_FRACTION,
                train_clips: train.len(),
                evaluation_clips: evaluation.len(),
                train_speakers: speaker_count(&train),
                evaluation_speakers: speaker_count(&evaluation),
            };
            let held_out = (!evaluation.is_empty())
                .then(|| evaluate_clips(&evaluation))
                .transpose()?;
            (summary, held_out)
        }
    };

    counts.challenge_scored = challenge_clips.len();
    let (train_clips, held_out_clips) = match &partition {
        PartitionSummary::SpeakerExclusive { .. } => {
            held_out_speaker_split(&clips, DEFAULT_EVALUATION_FRACTION, PARTITION_SEED)
        }
        PartitionSummary::NotSpeakerExclusive { .. } => (Vec::new(), Vec::new()),
    };
    let all_scored_intervals = bootstrap_intervals(&clips)?;
    let held_out_intervals = bootstrap_intervals(&held_out_clips)?;
    // With a protected held-out partition, review only training errors: listening to held-out
    // errors during development would leak the test set.
    let (error_review_scope, error_review) = if held_out_clips.is_empty() {
        ("allScored", error_review_sample(&clips))
    } else {
        ("train", error_review_sample(&train_clips))
    };

    missing.sort();
    unreadable.sort();
    Ok(CorpusRunReport {
        schema_version: 1,
        corpus: CorpusIdentity {
            name: "SEP-28k",
            labels_sha256: sha256_hex(labels.as_bytes()),
            label_rows: rows.len(),
            speaker_mapping_sha256: speaker_file
                .as_ref()
                .map(|(_, text)| sha256_hex(text.as_bytes())),
            scored_audio_sha256: digest_of(&mut audio_digests),
            challenge_audio_sha256: digest_of(&mut challenge_digests),
        },
        configuration: RunConfiguration {
            detector: "existing-detector",
            detector_revision: options.detector_revision.clone(),
            detector_input: "clip audio only; no transcript",
            vote_threshold: options.vote_threshold,
            limit: options.limit,
        },
        counts,
        prevalence,
        partition,
        all_scored: (!clips.is_empty())
            .then(|| evaluate_clips(&clips))
            .transpose()?,
        held_out,
        all_scored_intervals,
        held_out_intervals,
        challenge: (!challenge_clips.is_empty())
            .then(|| evaluate_clips(&challenge_clips))
            .transpose()?,
        error_review_scope,
        error_review,
        missing_clip_ids: missing.into_iter().take(LISTED_ID_LIMIT).collect(),
        unreadable_clip_ids: unreadable.into_iter().take(LISTED_ID_LIMIT).collect(),
        limitations: vec![
            "SEP-28k labels are clip-level votes by non-clinician annotators, not a clinical reference.",
            "Clip classification only; no event timing is evaluated.",
            "The detector receives clip audio without a transcript, so transcript-based detections cannot fire.",
            "Precision, recall and F1 are 0 when their denominator is 0; check prevalence before reading them.",
            "Intervals are percentile bootstrap intervals over speakers (or clips without a complete verified mapping); they do not cover label noise.",
        ],
    })
}

/// Percentile bootstrap (95%) of the main metrics. Resamples speakers with replacement when
/// every clip has a verified speaker (clips of one speaker are not independent), otherwise clips.
fn bootstrap_intervals(clips: &[BenchmarkClip]) -> Result<Option<MetricIntervals>, BenchmarkError> {
    if clips.is_empty() {
        return Ok(None);
    }
    let by_speaker = clips.iter().all(|clip| clip.speaker_id.is_some());
    let mut groups: BTreeMap<&str, Vec<&BenchmarkClip>> = BTreeMap::new();
    for clip in clips {
        let key = if by_speaker {
            clip.speaker_id.as_deref().unwrap_or_default()
        } else {
            clip.id.as_str()
        };
        groups.entry(key).or_default().push(clip);
    }
    let groups = groups.into_values().collect::<Vec<_>>();
    // One resampling unit gives a zero-width interval that only looks certain.
    if groups.len() < 2 {
        return Ok(None);
    }
    let mut rng = SplitMix64::new(u64::from(stable_hash(BOOTSTRAP_SEED)));
    let mut micro = Vec::with_capacity(BOOTSTRAP_RESAMPLES);
    let mut macro_f1 = Vec::with_capacity(BOOTSTRAP_RESAMPLES);
    let mut fluent = Vec::with_capacity(BOOTSTRAP_RESAMPLES);
    let mut per_kind: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut sample = Vec::with_capacity(clips.len());
    for _ in 0..BOOTSTRAP_RESAMPLES {
        sample.clear();
        for _ in 0..groups.len() {
            sample.extend(groups[rng.below(groups.len())].iter().copied());
        }
        let report = evaluate_clip_refs(&sample)?;
        micro.push(report.micro_f1);
        macro_f1.push(report.macro_f1);
        // A rate or F1 with a zero denominator is undefined, not perfect or zero: skip the draw.
        if sample.iter().any(|clip| clip.reference_kinds.is_empty()) {
            fluent.push(report.false_positive_clip_rate);
        }
        for kind in BENCHMARK_KINDS {
            let values = per_kind.entry(kind_name(kind).to_owned()).or_default();
            if sample
                .iter()
                .any(|clip| clip.reference_kinds.contains(&kind))
            {
                values.push(report.by_kind[&kind].f1);
            }
        }
    }
    Ok(Some(MetricIntervals {
        resampling_unit: if by_speaker { "speaker" } else { "clip" },
        resamples: BOOTSTRAP_RESAMPLES,
        seed: BOOTSTRAP_SEED,
        micro_f1: percentile_interval(micro),
        macro_f1: percentile_interval(macro_f1),
        false_positive_clip_rate: (!fluent.is_empty()).then(|| percentile_interval(fluent)),
        f1_by_kind: per_kind
            .into_iter()
            .map(|(kind, values)| {
                (
                    kind,
                    (!values.is_empty()).then(|| percentile_interval(values)),
                )
            })
            .collect(),
    }))
}

fn percentile_interval(mut values: Vec<f64>) -> Interval {
    values.sort_by(f64::total_cmp);
    let at = |quantile: f64| values[((values.len() - 1) as f64 * quantile).round() as usize];
    Interval {
        lower: at(0.025),
        upper: at(0.975),
    }
}

/// Up to `ERROR_SAMPLE_PER_KIND` false-positive and false-negative clip ids per kind, chosen by a
/// seeded hash so the sample is stable and not biased towards file order.
fn error_review_sample(clips: &[BenchmarkClip]) -> BTreeMap<String, ErrorSample> {
    BENCHMARK_KINDS
        .into_iter()
        .map(|kind| {
            let pick = |predicate: &dyn Fn(&BenchmarkClip) -> bool| {
                let mut ids = clips
                    .iter()
                    .filter(|clip| predicate(clip))
                    .map(|clip| clip.id.clone())
                    .collect::<Vec<_>>();
                ids.sort_by_key(|id| {
                    (
                        stable_hash(&format!("{ERROR_SAMPLE_SEED}:{id}")),
                        id.clone(),
                    )
                });
                ids.truncate(ERROR_SAMPLE_PER_KIND);
                ids
            };
            (
                kind_name(kind).to_owned(),
                ErrorSample {
                    false_positives: pick(&|clip| {
                        clip.predicted_kinds.contains(&kind)
                            && !clip.reference_kinds.contains(&kind)
                    }),
                    false_negatives: pick(&|clip| {
                        clip.reference_kinds.contains(&kind)
                            && !clip.predicted_kinds.contains(&kind)
                    }),
                },
            )
        })
        .collect()
}

/// Small deterministic PRNG for resampling (no external dependency).
struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut value = self.0;
        value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        value ^ (value >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}

enum ClipOutcome {
    /// The scored clip and its `clipId\tsha256(wav)` digest line.
    Scored(Box<BenchmarkClip>, String),
    Missing(String),
    Unreadable(String),
}

/// Reads one clip, checks it covers its labelled interval and runs the detector on it.
fn score_clip(
    clips_dir: &Path,
    entry: Sep28kManifestEntry,
    labelled_samples: u64,
) -> Result<ClipOutcome, BenchmarkError> {
    let path = sep28k_clip_path(clips_dir, &entry);
    if !path.is_file() {
        return Ok(ClipOutcome::Missing(entry.id));
    }
    // Clips must cover the labelled interval; a truncated extraction would be scored against
    // labels for audio it does not contain.
    let expected_seconds = labelled_samples as f64 / f64::from(SEP28K_SAMPLE_RATE);
    let Ok((samples, sample_rate)) = read_mono_wav(&path) else {
        return Ok(ClipOutcome::Unreadable(entry.id));
    };
    if samples.is_empty() {
        return Ok(ClipOutcome::Unreadable(entry.id));
    }
    let duration_seconds = samples.len() as f64 / f64::from(sample_rate);
    if (duration_seconds - expected_seconds).abs() > expected_seconds * DURATION_TOLERANCE {
        return Ok(ClipOutcome::Unreadable(entry.id));
    }
    let report = match crate::speech_pipeline::analyze_speech_session(AnalyzeSpeechRequest {
        segments: Vec::new(),
        pauses: Vec::new(),
        session_started_at: None,
        samples: Some(samples),
        sample_rate: Some(sample_rate),
    }) {
        Ok(report) => report,
        // Input validation (too short, non-finite samples): this clip is unusable, not the run.
        Err(SpeechAnalysisError::Invalid(_)) => return Ok(ClipOutcome::Unreadable(entry.id)),
        Err(error) => return Err(BenchmarkError::Detector(error.to_string())),
    };
    let observed = report
        .events
        .iter()
        .map(|event| event.kind)
        .collect::<HashSet<_>>();
    let digest = format!(
        "{}\t{}",
        entry.id,
        sha256_hex(&std::fs::read(&path).map_err(|error| BenchmarkError::Io {
            path: path.display().to_string(),
            message: error.to_string(),
        })?)
    );
    Ok(ClipOutcome::Scored(
        Box::new(BenchmarkClip {
            id: entry.id,
            speaker_id: entry.speaker_id,
            duration_seconds,
            reference_kinds: entry.reference_kinds,
            predicted_kinds: BENCHMARK_KINDS
                .into_iter()
                .filter(|kind| observed.contains(kind))
                .collect(),
            predicted_probabilities: None,
        }),
        digest,
    ))
}

/// Every applicable reason. Quality flags are multi-label; a clip with no stuttering kind at the
/// threshold also needs an affirmative `NoStutteredWords` vote to count as fluent.
/// Speaker-exclusive split with a deterministic, non-empty held-out side: speakers are ranked by
/// a seeded hash and the lowest `ceil(fraction * speakers)` (at least one, never all) are held
/// out. Unlike independent hash bucketing, small corpora cannot end up with no held-out speaker.
fn held_out_speaker_split(
    clips: &[BenchmarkClip],
    evaluation_fraction: f64,
    seed: &str,
) -> (Vec<BenchmarkClip>, Vec<BenchmarkClip>) {
    let mut speakers = clips
        .iter()
        .filter_map(|clip| clip.speaker_id.as_deref())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    speakers.sort_by_key(|speaker| (stable_hash(&format!("{seed}:{speaker}")), *speaker));
    let held_out_count = ((speakers.len() as f64 * evaluation_fraction).ceil() as usize)
        .clamp(1, speakers.len().saturating_sub(1).max(1));
    let held_out = speakers[..held_out_count]
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    clips.iter().cloned().partition(|clip| {
        !clip
            .speaker_id
            .as_deref()
            .is_some_and(|speaker| held_out.contains(speaker))
    })
}

fn exclusion_reasons(entry: &Sep28kManifestEntry) -> Vec<&'static str> {
    let flags = &entry.flags;
    let mut reasons = [
        (flags.unsure, "unsure"),
        (flags.poor_audio_quality, "poorAudioQuality"),
        (flags.difficult_to_understand, "difficultToUnderstand"),
        (flags.music, "music"),
        (flags.no_speech, "noSpeech"),
    ]
    .into_iter()
    .filter_map(|(flagged, reason)| flagged.then_some(reason))
    .collect::<Vec<_>>();
    if entry.reference_kinds.is_empty() && !flags.no_stutter {
        reasons.push("noAffirmativeLabel");
    }
    reasons
}

const SEP28K_REQUIRED_COLUMNS: [&str; 15] = [
    "Show",
    "EpId",
    "ClipId",
    "Unsure",
    "PoorAudioQuality",
    "Prolongation",
    "Block",
    "SoundRep",
    "WordRep",
    "DifficultToUnderstand",
    "Interjection",
    "NoStutteredWords",
    "NaturalPause",
    "Music",
    "NoSpeech",
];

/// Vote cells must be integers 0-3; a damaged cell must not silently become a negative.
fn validate_sep28k_votes(row: &Sep28kRow) -> Result<(), BenchmarkError> {
    for column in &SEP28K_REQUIRED_COLUMNS[..3] {
        if row.get(*column).is_none_or(|value| value.trim().is_empty()) {
            return Err(BenchmarkError::EmptyIdentity(column));
        }
    }
    for column in &SEP28K_REQUIRED_COLUMNS[3..] {
        let value = row.get(*column).map(String::as_str).unwrap_or_default();
        if !matches!(value.parse::<u8>(), Ok(0..=3)) {
            return Err(BenchmarkError::InvalidVote {
                clip_id: format!(
                    "{}:{}:{}",
                    first(row, &["Show"]).unwrap_or("?"),
                    first(row, &["EpId"]).unwrap_or("?"),
                    first(row, &["ClipId"]).unwrap_or("?")
                ),
                column,
                value: value.to_owned(),
            });
        }
    }
    Ok(())
}

/// Layout written by the dataset's own download script: `clips/<Show>/<EpId>/<Show>_<EpId>_<ClipId>.wav`.
fn sep28k_clip_path(clips_dir: &Path, entry: &Sep28kManifestEntry) -> PathBuf {
    clips_dir
        .join(&entry.show)
        .join(&entry.episode_id)
        .join(format!(
            "{}_{}_{}.wav",
            entry.show, entry.episode_id, entry.clip_id
        ))
}

fn read_mono_wav(path: &Path) -> Result<(Vec<f32>, u32), hound::Error> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let interleaved = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 2_f32.powi(i32::from(spec.bits_per_sample) - 1);
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    Ok((mono, spec.sample_rate))
}

/// Minimal CSV reader for the dataset's plain comma-separated files; quoted fields are rejected
/// rather than misparsed.
fn parse_csv(text: &str, path: &Path) -> Result<Vec<Sep28kRow>, BenchmarkError> {
    let mut lines = text
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty());
    let Some((_, header)) = lines.next() else {
        return Ok(Vec::new());
    };
    let columns = header
        .split(',')
        .map(|column| column.trim().to_owned())
        .collect::<Vec<_>>();
    // A repeated header would let one cell silently overwrite another in the row map.
    let mut seen_columns = HashSet::new();
    if let Some(duplicate) = columns
        .iter()
        .find(|column| !seen_columns.insert(column.as_str()))
    {
        return Err(BenchmarkError::Csv {
            path: path.display().to_string(),
            line: 1,
            message: format!("duplicate column `{duplicate}`"),
        });
    }
    lines
        .map(|(index, line)| {
            let error = |message: &str| BenchmarkError::Csv {
                path: path.display().to_string(),
                line: index + 1,
                message: message.to_owned(),
            };
            if line.contains('"') {
                return Err(error("quoted fields are not supported"));
            }
            let values = line.split(',').map(str::trim).collect::<Vec<_>>();
            if values.len() != columns.len() {
                return Err(error("field count does not match the header"));
            }
            Ok(columns
                .iter()
                .cloned()
                .zip(values.into_iter().map(str::to_owned))
                .collect())
        })
        .collect()
}

fn parse_speaker_mapping(
    text: &str,
    path: &Path,
) -> Result<HashMap<String, String>, BenchmarkError> {
    let mut mapping = HashMap::new();
    for row in parse_csv(text, path)? {
        let clip = first(&row, &["clipId", "clip_id"]);
        let speaker = first(&row, &["speakerId", "speaker_id"]);
        let (Some(clip), Some(speaker)) = (clip, speaker) else {
            continue;
        };
        if mapping
            .insert(clip.to_owned(), speaker.to_owned())
            .is_some()
        {
            return Err(BenchmarkError::DuplicateSpeakerMapping(clip.to_owned()));
        }
    }
    Ok(mapping)
}

fn read_file(path: &Path) -> Result<String, BenchmarkError> {
    std::fs::read_to_string(path).map_err(|error| BenchmarkError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

fn speaker_count(clips: &[BenchmarkClip]) -> usize {
    clips
        .iter()
        .filter_map(|clip| clip.speaker_id.as_deref())
        .collect::<HashSet<_>>()
        .len()
}

fn kind_name(kind: StutterKind) -> &'static str {
    match kind {
        StutterKind::WordRepetition => "wordRepetition",
        StutterKind::SoundRepetition => "soundRepetition",
        StutterKind::Prolongation => "prolongation",
        StutterKind::Block => "block",
        StutterKind::Filler => "filler",
    }
}

fn digest_of(lines: &mut [String]) -> Option<String> {
    (!lines.is_empty()).then(|| {
        lines.sort();
        sha256_hex(lines.join("\n").as_bytes())
    })
}

/// Kind order is fixed so identical runs serialize identically.
fn serialize_by_kind<S: serde::Serializer>(
    by_kind: &HashMap<StutterKind, KindMetrics>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(
        BENCHMARK_KINDS
            .into_iter()
            .filter_map(|kind| by_kind.get(&kind).map(|metrics| (kind_name(kind), metrics))),
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_analysis::TranscriptSegmentInput;

    fn row(entries: &[(&str, &str)]) -> Sep28kRow {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn clip(
        id: &str,
        speaker_id: Option<&str>,
        reference_kinds: Vec<StutterKind>,
        predicted_kinds: Vec<StutterKind>,
    ) -> BenchmarkClip {
        BenchmarkClip {
            id: id.to_owned(),
            speaker_id: speaker_id.map(str::to_owned),
            duration_seconds: 3.0,
            reference_kinds,
            predicted_kinds,
            predicted_probabilities: None,
        }
    }

    fn complete_probabilities(default: f64) -> HashMap<StutterKind, f64> {
        BENCHMARK_KINDS
            .into_iter()
            .map(|kind| (kind, default))
            .collect()
    }

    #[test]
    fn sep28k_normalization_uses_the_product_taxonomy_and_real_no_stutter_column() {
        let input = row(&[
            ("Show", "HeStutters"),
            ("EpId", "7"),
            ("ClipId", "12"),
            ("Start", "48000"),
            ("Stop", "192000"),
            ("WordRep", "2"),
            ("SoundRep", "1"),
            ("Prolongation", "3"),
            ("Block", "0"),
            ("Interjection", "2"),
            ("NoStutteredWords", "2"),
        ]);

        let entry = normalize_sep28k_row(&input, 2, Some("speaker-17")).unwrap();
        assert_eq!(entry.id, "HeStutters:7:12");
        assert_eq!(entry.show, "HeStutters");
        assert_eq!(entry.episode_id, "7");
        assert_eq!(entry.clip_id, "12");
        assert_eq!(entry.start_sample, Some(48_000));
        assert_eq!(entry.stop_sample, Some(192_000));
        assert_eq!(entry.speaker_id.as_deref(), Some("speaker-17"));
        assert_eq!(
            entry.reference_kinds,
            vec![
                StutterKind::WordRepetition,
                StutterKind::Prolongation,
                StutterKind::Filler,
            ]
        );
        assert_eq!(entry.annotation_votes[&StutterKind::SoundRepetition], 1);
        assert!(entry.flags.no_stutter);
        assert!(!entry.flags.unsure);
        assert!(!entry.flags.poor_audio_quality);
        assert!(!entry.flags.difficult_to_understand);
        assert!(!entry.flags.natural_pause);
        assert!(!entry.flags.music);
        assert!(!entry.flags.no_speech);
        assert!(should_evaluate_sep28k(&entry));
    }

    #[test]
    fn sep28k_quality_flags_fail_closed_for_evaluation() {
        let input = row(&[
            ("Show", "show"),
            ("EpId", "1"),
            ("ClipId", "2"),
            ("PoorAudioQuality", "2"),
        ]);
        let entry = normalize_sep28k_row(&input, 2, None).unwrap();
        assert!(!should_evaluate_sep28k(&entry));
    }

    #[test]
    fn fluent_false_positive_rate_uses_only_fluent_clips_as_the_denominator() {
        let report = evaluate_clips(&[
            clip(
                "a",
                Some("speaker-a"),
                vec![StutterKind::WordRepetition],
                vec![StutterKind::WordRepetition],
            ),
            clip(
                "b",
                Some("speaker-b"),
                vec![StutterKind::Block],
                vec![StutterKind::Filler],
            ),
            clip("c", Some("speaker-c"), vec![], vec![StutterKind::Filler]),
        ])
        .unwrap();

        assert_eq!(report.clip_count, 3);
        assert_eq!(report.speaker_count, 3);
        assert_eq!(report.false_positive_clip_rate, 1.0);
        assert_eq!(report.by_kind[&StutterKind::WordRepetition].f1, 1.0);
        assert_eq!(report.by_kind[&StutterKind::Block].false_negative, 1);
        assert_eq!(report.by_kind[&StutterKind::Filler].false_positive, 2);
        assert!(report.micro_precision < 1.0);
        assert!(report.micro_recall < 1.0);
        assert!(report.micro_f1 < 1.0);
        assert!(report.macro_f1 < 1.0);
        assert_eq!(report.brier_score, None);
    }

    #[test]
    fn calibration_requires_a_complete_vector_for_every_scored_clip() {
        let mut incomplete = HashMap::new();
        incomplete.insert(StutterKind::WordRepetition, 0.9);
        let mut first = clip(
            "a",
            Some("speaker-a"),
            vec![StutterKind::WordRepetition],
            vec![StutterKind::WordRepetition],
        );
        first.predicted_probabilities = Some(incomplete);
        let second = clip("b", Some("speaker-b"), vec![], vec![]);

        assert!(matches!(
            evaluate_clips(&[first, second]),
            Err(BenchmarkError::IncompleteProbabilityVector { .. })
        ));
    }

    #[test]
    fn calibration_scores_all_five_product_classes() {
        let mut probabilities = complete_probabilities(0.1);
        probabilities.insert(StutterKind::WordRepetition, 0.9);
        let mut item = clip(
            "a",
            Some("speaker-a"),
            vec![StutterKind::WordRepetition],
            vec![StutterKind::WordRepetition],
        );
        item.predicted_probabilities = Some(probabilities);

        let report = evaluate_clips(&[item]).unwrap();
        assert!(report
            .brier_score
            .is_some_and(|score| score > 0.0 && score < 0.1));
    }

    #[test]
    fn speaker_safe_split_rejects_missing_identity_and_never_leaks_a_speaker() {
        assert!(matches!(
            speaker_safe_split(&[clip("missing", None, vec![], vec![])], 0.2, "fixture"),
            Err(BenchmarkError::MissingSpeaker)
        ));

        let clips = (0..20)
            .map(|index| {
                clip(
                    &format!("clip-{index}"),
                    Some(&format!("speaker-{}", index / 2)),
                    vec![],
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        let (train, evaluation) = speaker_safe_split(&clips, 0.35, "fixture").unwrap();
        let train_speakers = train
            .iter()
            .filter_map(|item| item.speaker_id.as_deref())
            .collect::<HashSet<_>>();
        let evaluation_speakers = evaluation
            .iter()
            .filter_map(|item| item.speaker_id.as_deref())
            .collect::<HashSet<_>>();
        assert!(train_speakers.is_disjoint(&evaluation_speakers));
        assert_eq!(train.len() + evaluation.len(), clips.len());
    }

    #[test]
    fn existing_detector_is_the_initial_benchmark_baseline() {
        let report = evaluate_existing_detector(&[BaselineCase {
            id: "baseline".to_owned(),
            speaker_id: Some("speaker-a".to_owned()),
            reference_kinds: vec![StutterKind::WordRepetition],
            request: AnalyzeSpeechRequest {
                segments: vec![TranscriptSegmentInput {
                    text: "I I want to explain this clearly".to_owned(),
                    start_seconds: 0.0,
                    end_seconds: 2.0,
                    confidence: Some(0.95),
                    speaker_score: Some(0.98),
                    is_final: true,
                }],
                pauses: vec![],
                session_started_at: None,
                samples: None,
                sample_rate: None,
            },
        }])
        .unwrap();

        assert_eq!(report.clip_count, 1);
        assert_eq!(report.speaker_count, 1);
        assert_eq!(report.by_kind.len(), BENCHMARK_KINDS.len());
    }

    // Synthetic corpus fixture: labels, a clip directory in the SEP-28k layout and generated
    // audio. No real corpus media is used.
    struct FixtureCorpus {
        root: PathBuf,
    }

    impl FixtureCorpus {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "stutter-bench-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(root.join("clips")).unwrap();
            Self { root }
        }

        fn labels(&self, rows: &[&str]) -> PathBuf {
            let header = "Show,EpId,ClipId,Start,Stop,Unsure,PoorAudioQuality,Prolongation,Block,SoundRep,WordRep,DifficultToUnderstand,Interjection,NoStutteredWords,NaturalPause,Music,NoSpeech";
            let path = self.root.join("labels.csv");
            std::fs::write(&path, format!("{header}\n{}\n", rows.join("\n"))).unwrap();
            path
        }

        fn speakers(&self, rows: &[(&str, &str)]) -> PathBuf {
            let path = self.root.join("speakers.csv");
            let body = rows
                .iter()
                .map(|(clip, speaker)| format!("{clip},{speaker}"))
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(&path, format!("clipId,speakerId\n{body}\n")).unwrap();
            path
        }

        fn clip_path(&self, show: &str, episode: &str, clip: &str) -> PathBuf {
            let dir = self.root.join("clips").join(show).join(episode);
            std::fs::create_dir_all(&dir).unwrap();
            dir.join(format!("{show}_{episode}_{clip}.wav"))
        }

        fn wav(&self, show: &str, episode: &str, clip: &str, tone_hz: Option<f32>) {
            self.wav_samples(show, episode, clip, tone_hz, 48_000);
        }

        fn wav_samples(
            &self,
            show: &str,
            episode: &str,
            clip: &str,
            tone_hz: Option<f32>,
            samples: usize,
        ) {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer =
                hound::WavWriter::create(self.clip_path(show, episode, clip), spec).unwrap();
            for index in 0..samples {
                let value = tone_hz.map_or(0.0, |hz| {
                    0.3 * (2.0 * std::f32::consts::PI * hz * index as f32 / 16_000.0).sin()
                });
                writer.write_sample((value * 32_767.0) as i16).unwrap();
            }
            writer.finalize().unwrap();
        }

        fn options(&self, labels: PathBuf, speakers: Option<PathBuf>) -> CorpusRunOptions {
            CorpusRunOptions {
                labels_csv: labels,
                clips_dir: self.root.join("clips"),
                speakers_csv: speakers,
                vote_threshold: 2,
                limit: None,
                detector_revision: None,
            }
        }
    }

    impl Drop for FixtureCorpus {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    const FLUENT: &str = "show,1,1,0,48000,0,0,0,0,0,0,0,0,3,0,0,0";
    const PROLONGATION: &str = "show,1,2,0,48000,0,0,3,0,0,0,0,0,0,0,0,0";
    const POOR_AUDIO: &str = "show,1,3,0,48000,0,2,0,0,0,0,0,0,0,0,0,0";
    const MISSING: &str = "show,2,4,0,48000,0,0,0,2,0,0,0,0,0,0,0,0";
    const CORRUPT: &str = "show,2,5,0,48000,0,0,0,0,0,0,0,0,3,0,0,0";

    fn standard_fixture(name: &str) -> (FixtureCorpus, PathBuf) {
        let corpus = FixtureCorpus::new(name);
        corpus.wav("show", "1", "1", None);
        corpus.wav("show", "1", "2", Some(220.0));
        std::fs::write(corpus.clip_path("show", "2", "5"), b"not a wav file").unwrap();
        let labels = corpus.labels(&[FLUENT, PROLONGATION, POOR_AUDIO, MISSING, CORRUPT]);
        (corpus, labels)
    }

    #[test]
    fn corpus_runner_scores_local_clips_and_accounts_for_every_row() {
        let (corpus, labels) = standard_fixture("accounting");
        let report = run_sep28k_corpus(&corpus.options(labels, None)).unwrap();

        assert_eq!(report.counts.rows, 5);
        assert_eq!(report.counts.processed_rows, 5);
        assert_eq!(report.counts.excluded_rows, 1);
        assert_eq!(report.counts.excluded.get("poorAudioQuality"), Some(&1));
        assert_eq!(report.counts.missing_audio, 1);
        assert_eq!(report.counts.unreadable_audio, 1);
        assert_eq!(report.counts.scored, 2);
        assert_eq!(report.counts.fluent_scored, 1);
        assert_eq!(report.missing_clip_ids, vec!["show:2:4".to_owned()]);
        assert_eq!(report.unreadable_clip_ids, vec!["show:2:5".to_owned()]);
        assert_eq!(report.prevalence["prolongation"].reference, 1);
        assert_eq!(report.prevalence["block"].reference, 0);
        let all = report.all_scored.as_ref().unwrap();
        assert_eq!(all.clip_count, 2);
        assert_eq!(all.by_kind.len(), BENCHMARK_KINDS.len());
        assert_eq!(report.corpus.labels_sha256.len(), 64);
        assert!(matches!(
            report.partition,
            PartitionSummary::NotSpeakerExclusive { .. }
        ));
        assert!(report.held_out.is_none());
    }

    #[test]
    fn corpus_runner_output_is_deterministic() {
        let (corpus, labels) = standard_fixture("deterministic");
        let options = corpus.options(labels, None);
        let first = serde_json::to_string(&run_sep28k_corpus(&options).unwrap()).unwrap();
        let second = serde_json::to_string(&run_sep28k_corpus(&options).unwrap()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn corpus_runner_partitions_only_with_a_complete_verified_speaker_mapping() {
        let corpus = FixtureCorpus::new("speakers");
        let mut rows = Vec::new();
        let mut mapping = Vec::new();
        for clip in 0..12 {
            corpus.wav("show", "1", &clip.to_string(), None);
            rows.push(format!("show,1,{clip},0,48000,0,0,0,0,0,0,0,0,3,0,0,0"));
            mapping.push((format!("show:1:{clip}"), format!("speaker-{}", clip / 2)));
        }
        let rows = rows.iter().map(String::as_str).collect::<Vec<_>>();
        let labels = corpus.labels(&rows);
        let pairs = mapping
            .iter()
            .map(|(clip, speaker)| (clip.as_str(), speaker.as_str()))
            .collect::<Vec<_>>();

        let complete =
            run_sep28k_corpus(&corpus.options(labels.clone(), Some(corpus.speakers(&pairs))))
                .unwrap();
        let PartitionSummary::SpeakerExclusive {
            train_clips,
            evaluation_clips,
            train_speakers,
            evaluation_speakers,
            ..
        } = complete.partition
        else {
            panic!("expected a speaker-exclusive partition");
        };
        assert_eq!(train_clips + evaluation_clips, 12);
        assert_eq!(train_speakers + evaluation_speakers, 6);
        assert!(complete.corpus.speaker_mapping_sha256.is_some());

        let partial =
            run_sep28k_corpus(&corpus.options(labels, Some(corpus.speakers(&pairs[1..])))).unwrap();
        assert!(matches!(
            partial.partition,
            PartitionSummary::NotSpeakerExclusive { ref reason } if reason.contains("1 scored clips")
        ));
        assert!(partial.held_out.is_none());
    }

    #[test]
    fn corpus_runner_rejects_duplicate_clips_and_mappings() {
        let corpus = FixtureCorpus::new("duplicates");
        let labels = corpus.labels(&[FLUENT, FLUENT]);
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(labels, None)),
            Err(BenchmarkError::DuplicateClip(id)) if id == "show:1:1"
        ));

        let labels = corpus.labels(&[FLUENT]);
        let speakers = corpus.speakers(&[("show:1:1", "a"), ("show:1:1", "b")]);
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(labels, Some(speakers))),
            Err(BenchmarkError::DuplicateSpeakerMapping(_))
        ));
    }

    #[test]
    fn corpus_runner_rejects_csv_it_cannot_parse_faithfully() {
        let corpus = FixtureCorpus::new("csv");
        let quoted = corpus.labels(&["\"show, with comma\",1,1,0,48000,0,0,0,0,0,0,0,0,3,0,0,0"]);
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(quoted, None)),
            Err(BenchmarkError::Csv { .. })
        ));
        let short = corpus.labels(&["show,1,1"]);
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(short, None)),
            Err(BenchmarkError::Csv { .. })
        ));
    }

    #[test]
    fn corpus_runner_rejects_empty_and_header_only_manifests() {
        let corpus = FixtureCorpus::new("empty-manifest");
        let empty = corpus.root.join("empty.csv");
        std::fs::write(&empty, "").unwrap();
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(empty, None)),
            Err(BenchmarkError::MissingColumn("Show"))
        ));
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(corpus.labels(&[]), None)),
            Err(BenchmarkError::EmptyManifest)
        ));
    }

    #[test]
    fn corpus_runner_reports_an_empty_scored_set_without_metrics() {
        let corpus = FixtureCorpus::new("empty");
        let labels = corpus.labels(&[MISSING]);
        let report = run_sep28k_corpus(&corpus.options(labels, None)).unwrap();
        assert_eq!(report.counts.scored, 0);
        assert!(report.all_scored.is_none());
    }

    #[test]
    fn corpus_runner_reports_processed_rows_under_a_limit() {
        let (corpus, labels) = standard_fixture("limit");
        let mut options = corpus.options(labels, None);
        options.limit = Some(2);
        let report = run_sep28k_corpus(&options).unwrap();
        assert_eq!(report.counts.rows, 5);
        assert_eq!(report.counts.processed_rows, 2);
        assert_eq!(report.counts.scored, 2);
        options.limit = Some(0);
        assert!(matches!(
            run_sep28k_corpus(&options),
            Err(BenchmarkError::ZeroLimit)
        ));
    }

    #[test]
    fn corpus_runner_counts_every_exclusion_flag_and_requires_an_affirmative_fluent_label() {
        let corpus = FixtureCorpus::new("flags");
        corpus.wav("show", "1", "7", None);
        let labels = corpus.labels(&[
            // Music and no speech together.
            "show,1,6,0,48000,0,0,0,0,0,0,0,0,0,0,2,3",
            // No stuttering kind at the threshold, but no affirmative fluent vote either.
            "show,1,7,0,48000,0,0,1,0,0,0,0,0,1,0,0,0",
        ]);
        let report = run_sep28k_corpus(&corpus.options(labels, None)).unwrap();

        assert_eq!(report.counts.excluded_rows, 2);
        assert_eq!(report.counts.excluded.get("music"), Some(&1));
        assert_eq!(report.counts.excluded.get("noSpeech"), Some(&1));
        assert_eq!(report.counts.excluded.get("noAffirmativeLabel"), Some(&2));
        assert_eq!(report.counts.fluent_scored, 0);
    }

    #[test]
    fn corpus_runner_rejects_malformed_votes_and_missing_columns() {
        let corpus = FixtureCorpus::new("votes");
        for bad in ["x", "4", "-1", ""] {
            let labels = corpus.labels(&[&format!("show,1,1,0,48000,0,0,{bad},0,0,0,0,0,3,0,0,0")]);
            assert!(matches!(
                run_sep28k_corpus(&corpus.options(labels, None)),
                Err(BenchmarkError::InvalidVote {
                    column: "Prolongation",
                    ..
                })
            ));
        }

        let path = corpus.root.join("short-header.csv");
        std::fs::write(&path, "Show,EpId,ClipId,WordRep\nshow,1,1,0\n").unwrap();
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(path, None)),
            Err(BenchmarkError::MissingColumn("Unsure"))
        ));
    }

    #[test]
    fn corpus_runner_counts_detector_invalid_audio_without_aborting() {
        let corpus = FixtureCorpus::new("short");
        corpus.wav_samples("show", "1", "1", None, 1_000);
        corpus.wav("show", "1", "2", Some(220.0));
        let labels = corpus.labels(&[FLUENT, PROLONGATION]);
        let report = run_sep28k_corpus(&corpus.options(labels, None)).unwrap();

        assert_eq!(report.counts.unreadable_audio, 1);
        assert_eq!(report.unreadable_clip_ids, vec!["show:1:1".to_owned()]);
        assert_eq!(report.counts.scored, 1);
    }

    #[test]
    fn corpus_runner_rejects_truncated_clips_and_records_an_audio_fingerprint() {
        let corpus = FixtureCorpus::new("truncated");
        corpus.wav_samples("show", "1", "1", None, 32_000);
        corpus.wav("show", "1", "2", Some(220.0));
        let labels = corpus.labels(&[FLUENT, PROLONGATION]);
        let options = corpus.options(labels, None);
        let report = run_sep28k_corpus(&options).unwrap();

        assert_eq!(report.unreadable_clip_ids, vec!["show:1:1".to_owned()]);
        assert_eq!(report.counts.scored, 1);
        let fingerprint = report.corpus.scored_audio_sha256.clone().unwrap();
        assert_eq!(fingerprint.len(), 64);

        corpus.wav("show", "1", "2", Some(440.0));
        let changed = run_sep28k_corpus(&options).unwrap();
        assert_ne!(changed.corpus.scored_audio_sha256.unwrap(), fingerprint);
    }

    #[test]
    fn corpus_runner_rejects_empty_identities_and_a_missing_clips_directory() {
        let corpus = FixtureCorpus::new("identity");
        let labels = corpus.labels(&["show,,1,0,48000,0,0,0,0,0,0,0,0,3,0,0,0"]);
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(labels, None)),
            Err(BenchmarkError::EmptyIdentity("EpId"))
        ));

        let mut options = corpus.options(corpus.labels(&[FLUENT]), None);
        options.clips_dir = corpus.root.join("no-such-dir");
        assert!(matches!(
            run_sep28k_corpus(&options),
            Err(BenchmarkError::ClipsDirectory(_))
        ));
    }

    #[test]
    fn corpus_report_uses_camel_case_keys_throughout() {
        let corpus = FixtureCorpus::new("camel");
        let mut rows = Vec::new();
        let mut mapping = Vec::new();
        for clip in 0..6 {
            corpus.wav("show", "1", &clip.to_string(), None);
            rows.push(format!("show,1,{clip},0,48000,0,0,0,0,0,0,0,0,3,0,0,0"));
            mapping.push((format!("show:1:{clip}"), format!("speaker-{clip}")));
        }
        let rows = rows.iter().map(String::as_str).collect::<Vec<_>>();
        let pairs = mapping
            .iter()
            .map(|(clip, speaker)| (clip.as_str(), speaker.as_str()))
            .collect::<Vec<_>>();
        let report =
            run_sep28k_corpus(&corpus.options(corpus.labels(&rows), Some(corpus.speakers(&pairs))))
                .unwrap();
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"trainClips\""));
        assert!(report.held_out.is_some());
        assert!(!json.contains('_'), "snake_case key in {json}");
    }

    #[test]
    fn corpus_runner_rejects_missing_or_unordered_clip_bounds() {
        let corpus = FixtureCorpus::new("bounds");
        corpus.wav("show", "1", "1", None);
        for row in [
            "show,1,1,,48000,0,0,0,0,0,0,0,0,3,0,0,0",
            "show,1,1,x,48000,0,0,0,0,0,0,0,0,3,0,0,0",
            "show,1,1,48000,48000,0,0,0,0,0,0,0,0,3,0,0,0",
        ] {
            assert!(matches!(
                run_sep28k_corpus(&corpus.options(corpus.labels(&[row]), None)),
                Err(BenchmarkError::InvalidBounds(_))
            ));
        }
    }

    #[test]
    fn held_out_split_is_never_empty_and_never_everything() {
        for speakers in 2..12 {
            let clips = (0..speakers * 2)
                .map(|index| {
                    clip(
                        &format!("clip-{index}"),
                        Some(&format!("speaker-{}", index / 2)),
                        vec![],
                        vec![],
                    )
                })
                .collect::<Vec<_>>();
            let (train, evaluation) = held_out_speaker_split(&clips, 0.2, PARTITION_SEED);
            assert!(
                !train.is_empty() && !evaluation.is_empty(),
                "{speakers} speakers"
            );
            assert!(speaker_count(&train) > 0 && speaker_count(&evaluation) > 0);
            let train_speakers = train
                .iter()
                .filter_map(|item| item.speaker_id.as_deref())
                .collect::<HashSet<_>>();
            assert!(evaluation
                .iter()
                .all(|item| !train_speakers.contains(item.speaker_id.as_deref().unwrap())));
        }
    }

    #[test]
    fn corpus_report_records_the_supplied_detector_revision() {
        let (corpus, labels) = standard_fixture("revision");
        let mut options = corpus.options(labels, None);
        options.detector_revision = Some(DetectorRevision {
            commit: "abc123".to_owned(),
            dirty: true,
            source_pins_sha256: Some("pins".to_owned()),
            source_mode: true,
            lockfile_sha256: Some("lock".to_owned()),
            capability_sources: vec![SourceCheckout {
                name: "audio-analysis".to_owned(),
                commit: "def456".to_owned(),
                dirty: false,
            }],
        });
        let json = serde_json::to_string(&run_sep28k_corpus(&options).unwrap()).unwrap();
        assert!(json.contains("\"detectorRevision\":{\"commit\":\"abc123\",\"dirty\":true"));
        assert!(json.contains("\"capabilitySources\":[{\"name\":\"audio-analysis\""));
    }

    #[test]
    fn corpus_runner_validates_bounds_on_excluded_and_missing_rows_too() {
        let corpus = FixtureCorpus::new("bounds-skipped");
        // Excluded by a quality flag, and missing audio: both still need valid bounds.
        for row in [
            "show,1,3,x,48000,0,2,0,0,0,0,0,0,0,0,0,0",
            "show,2,4,48000,0,0,0,0,2,0,0,0,0,0,0,0,0",
        ] {
            assert!(matches!(
                run_sep28k_corpus(&corpus.options(corpus.labels(&[row]), None)),
                Err(BenchmarkError::InvalidBounds(_))
            ));
        }
    }

    #[test]
    fn corpus_runner_rejects_duplicate_and_missing_bound_headers() {
        let corpus = FixtureCorpus::new("headers");
        let duplicate = corpus.root.join("duplicate.csv");
        std::fs::write(
            &duplicate,
            "Show,EpId,ClipId,Start,Stop,Unsure,PoorAudioQuality,Prolongation,Block,SoundRep,WordRep,WordRep,DifficultToUnderstand,Interjection,NoStutteredWords,NaturalPause,Music,NoSpeech\nshow,1,1,0,48000,0,0,0,0,0,2,0,0,0,3,0,0,0\n",
        )
        .unwrap();
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(duplicate, None)),
            Err(BenchmarkError::Csv { ref message, .. }) if message.contains("WordRep")
        ));

        let no_bounds = corpus.root.join("no-bounds.csv");
        std::fs::write(
            &no_bounds,
            "Show,EpId,ClipId,Unsure,PoorAudioQuality,Prolongation,Block,SoundRep,WordRep,DifficultToUnderstand,Interjection,NoStutteredWords,NaturalPause,Music,NoSpeech\nshow,1,1,0,0,0,0,0,0,0,0,3,0,0,0\n",
        )
        .unwrap();
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(no_bounds, None)),
            Err(BenchmarkError::MissingColumn("Start"))
        ));
    }

    #[test]
    fn corpus_runner_reports_deterministic_bootstrap_intervals() {
        let (corpus, labels) = standard_fixture("bootstrap");
        let options = corpus.options(labels, None);
        let first = run_sep28k_corpus(&options).unwrap();
        let second = run_sep28k_corpus(&options).unwrap();

        let intervals = first.all_scored_intervals.clone().unwrap();
        assert_eq!(intervals.resampling_unit, "clip");
        assert_eq!(intervals.resamples, BOOTSTRAP_RESAMPLES);
        assert!(intervals.macro_f1.lower <= intervals.macro_f1.upper);
        assert_eq!(intervals.f1_by_kind.len(), BENCHMARK_KINDS.len());
        assert_eq!(first.all_scored_intervals, second.all_scored_intervals);
        assert!(first.held_out_intervals.is_none());
    }

    #[test]
    fn bootstrap_resamples_speakers_when_every_clip_has_one() {
        let clips = (0..12)
            .map(|index| {
                clip(
                    &format!("clip-{index}"),
                    Some(&format!("speaker-{}", index / 3)),
                    if index % 2 == 0 {
                        vec![StutterKind::Block]
                    } else {
                        vec![]
                    },
                    vec![StutterKind::Block],
                )
            })
            .collect::<Vec<_>>();
        let intervals = bootstrap_intervals(&clips).unwrap().unwrap();
        assert_eq!(intervals.resampling_unit, "speaker");
        let fluent = intervals.false_positive_clip_rate.unwrap();
        assert!(fluent.lower <= fluent.upper);
        // No clip has a filler reference, so its F1 interval is undefined rather than zero.
        assert_eq!(intervals.f1_by_kind["filler"], None);
        assert!(bootstrap_intervals(&[]).unwrap().is_none());
        let one_speaker = clips
            .iter()
            .filter(|clip| clip.speaker_id.as_deref() == Some("speaker-0"))
            .cloned()
            .collect::<Vec<_>>();
        assert!(bootstrap_intervals(&one_speaker).unwrap().is_none());
    }

    #[test]
    fn percentile_interval_takes_the_central_95_percent() {
        let interval = percentile_interval((0..=1000).map(f64::from).rev().collect());
        assert_eq!(interval.lower, 25.0);
        assert_eq!(interval.upper, 975.0);
    }

    #[test]
    fn error_review_sample_lists_misclassified_clip_ids_deterministically() {
        let clips = vec![
            clip("fp", None, vec![], vec![StutterKind::Filler]),
            clip("fn", None, vec![StutterKind::Filler], vec![]),
            clip(
                "tp",
                None,
                vec![StutterKind::Filler],
                vec![StutterKind::Filler],
            ),
        ];
        let sample = error_review_sample(&clips);
        assert_eq!(sample["filler"].false_positives, vec!["fp".to_owned()]);
        assert_eq!(sample["filler"].false_negatives, vec!["fn".to_owned()]);
        assert!(sample["block"].false_positives.is_empty());
        assert_eq!(error_review_sample(&clips), sample);
    }

    #[test]
    fn corpus_runner_scores_the_challenge_set_apart_from_main_results() {
        let corpus = FixtureCorpus::new("challenge");
        corpus.wav("show", "1", "1", None);
        corpus.wav("show", "1", "8", Some(220.0));
        let labels = corpus.labels(&[
            FLUENT,
            // Music-flagged but otherwise labelled: a challenge clip.
            "show,1,8,0,48000,0,0,3,0,0,0,0,0,0,0,2,0",
            // Unsure is not a robustness flag: excluded, not a challenge clip.
            "show,1,9,0,48000,2,0,3,0,0,0,0,0,0,0,0,0",
            // Music-flagged with missing audio.
            "show,1,10,0,48000,0,0,3,0,0,0,0,0,0,0,2,0",
        ]);
        let report = run_sep28k_corpus(&corpus.options(labels, None)).unwrap();

        assert_eq!(report.counts.scored, 1);
        assert_eq!(report.counts.challenge_rows, 2);
        assert_eq!(report.counts.challenge_scored, 1);
        assert_eq!(report.counts.challenge_unavailable, 1);
        assert_eq!(report.challenge.as_ref().unwrap().clip_count, 1);
        assert!(report.missing_clip_ids.is_empty());
    }

    #[test]
    fn corpus_runner_hashes_challenge_audio_and_reviews_only_training_errors() {
        let corpus = FixtureCorpus::new("review-scope");
        let mut rows = Vec::new();
        let mut mapping = Vec::new();
        for clip in 0..10 {
            corpus.wav("show", "1", &clip.to_string(), Some(220.0));
            rows.push(format!("show,1,{clip},0,48000,0,0,0,0,0,0,0,0,3,0,0,0"));
            mapping.push((format!("show:1:{clip}"), format!("speaker-{clip}")));
        }
        corpus.wav("show", "1", "20", Some(220.0));
        rows.push("show,1,20,0,48000,0,0,3,0,0,0,0,0,0,0,2,0".to_owned());
        mapping.push(("show:1:20".to_owned(), "speaker-20".to_owned()));
        let rows = rows.iter().map(String::as_str).collect::<Vec<_>>();
        let pairs = mapping
            .iter()
            .map(|(clip, speaker)| (clip.as_str(), speaker.as_str()))
            .collect::<Vec<_>>();
        let options = corpus.options(corpus.labels(&rows), Some(corpus.speakers(&pairs)));
        let report = run_sep28k_corpus(&options).unwrap();

        assert!(report.corpus.challenge_audio_sha256.is_some());
        assert_eq!(report.error_review_scope, "train");
        let (_, held_out) = held_out_speaker_split(
            &(0..10)
                .map(|clip| {
                    clip_with_speaker(&format!("show:1:{clip}"), &format!("speaker-{clip}"))
                })
                .collect::<Vec<_>>(),
            DEFAULT_EVALUATION_FRACTION,
            PARTITION_SEED,
        );
        let held_out_ids = held_out
            .iter()
            .map(|clip| clip.id.clone())
            .collect::<HashSet<_>>();
        for sample in report.error_review.values() {
            assert!(sample
                .false_positives
                .iter()
                .chain(&sample.false_negatives)
                .all(|id| !held_out_ids.contains(id)));
        }

        corpus.wav("show", "1", "20", Some(440.0));
        let changed = run_sep28k_corpus(&options).unwrap();
        assert_ne!(
            changed.corpus.challenge_audio_sha256,
            report.corpus.challenge_audio_sha256
        );
        assert_eq!(
            changed.corpus.scored_audio_sha256,
            report.corpus.scored_audio_sha256
        );
    }

    fn clip_with_speaker(id: &str, speaker: &str) -> BenchmarkClip {
        clip(id, Some(speaker), vec![], vec![])
    }

    #[test]
    fn bootstrap_skips_draws_without_fluent_clips_for_the_fluent_rate() {
        // Fluent clips only for one of many speakers: many draws contain none of them.
        let mut clips = vec![clip(
            "fluent",
            Some("speaker-0"),
            vec![],
            vec![StutterKind::Filler],
        )];
        for index in 1..12 {
            clips.push(clip(
                &format!("clip-{index}"),
                Some(&format!("speaker-{index}")),
                vec![StutterKind::Block],
                vec![StutterKind::Block],
            ));
        }
        let fluent = bootstrap_intervals(&clips)
            .unwrap()
            .unwrap()
            .false_positive_clip_rate
            .unwrap();
        // The only fluent clip is a false positive, so every defined draw has rate 1.
        assert_eq!(fluent.lower, 1.0);
        assert_eq!(fluent.upper, 1.0);
    }
}
