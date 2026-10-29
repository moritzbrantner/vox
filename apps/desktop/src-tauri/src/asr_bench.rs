//! Held-out ASR challenge set for disfluency preservation (vox#26).
//!
//! A manifest lists subsets of locally held audio with verbatim references. Each transcription
//! run (one model, one chunk length) writes a hypotheses file; scoring compares a baseline and a
//! candidate run on the same manifest and reports, per subset:
//!
//! - preservation of each disfluency class (word repetitions, part words, prolongations, other
//!   coded disfluent words, fillers) and the repeated-word deletion rate,
//! - fluent-word errors and inserted words per 100 reference words,
//! - hallucinated words inside annotated long pauses and segment-boundary error, where the
//!   reference is time-annotated,
//! - resource cost (real-time factor, peak memory, model size),
//! - error examples.
//!
//! Subsets without data stay in the manifest as explicit gaps and are reported as such. Model
//! size or sophistication is never a promotion criterion: only the measured preservation,
//! insertion and hallucination numbers are.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------------------------
// Manifest

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeManifest {
    pub schema_version: u32,
    pub name: String,
    /// How the item audio was derived from the source recordings.
    #[serde(default)]
    pub preprocessing: Option<String>,
    /// Where the audio and references come from and under which terms they are used.
    pub sources: Vec<ManifestSource>,
    pub subsets: Vec<ChallengeSubset>,
    /// Source recordings with a reference but no downloadable audio.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_recordings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSource {
    pub id: String,
    pub description: String,
    pub url: Option<String>,
    pub terms: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum SubsetKind {
    RepetitionsPartialWords,
    LongPauses,
    Noise,
    QuietSpeech,
    CodeSwitching,
    SpeakerChanges,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeSubset {
    pub id: String,
    pub kind: SubsetKind,
    pub description: String,
    /// Why this subset has no items; a gap is reported, never silently skipped.
    #[serde(default)]
    pub gap: Option<String>,
    /// Audio derived from each item: seeded white noise at this signal-to-noise ratio.
    #[serde(default)]
    pub noise: Option<NoiseMix>,
    #[serde(default)]
    pub items: Vec<ChallengeItem>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoiseMix {
    pub snr_db: f64,
    pub seed: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeItem {
    pub id: String,
    pub source: String,
    /// 16 kHz mono WAV, relative to the corpus root.
    pub audio: String,
    pub audio_sha256: String,
    /// SHA-256 of the source recording the 16 kHz audio was converted from.
    #[serde(default)]
    pub original_audio_sha256: Option<String>,
    pub duration_seconds: f64,
    /// Verbatim reference, relative to the corpus root.
    pub reference: String,
    pub reference_sha256: String,
    pub reference_format: ReferenceFormat,
    pub language: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceFormat {
    /// Plain verbatim text; UCLASS orthographic convention (disfluencies in upper case,
    /// `{...}` annotations).
    VerbatimText,
    /// Praat short TextTier of word onsets (UCLASS release 1 time-aligned word grids): every
    /// point starts an interval that runs to the next point; `x` marks silence.
    UclassWordGrid,
}

// ---------------------------------------------------------------------------------------------
// Hypotheses (one transcription run)

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisRun {
    pub engine: String,
    pub model: String,
    pub model_bytes: Option<u64>,
    pub language: String,
    /// Seconds per chunk sent to the model, as the product does (8 s live, 30 s reference).
    pub chunk_seconds: f64,
    pub threads: Option<usize>,
    /// Peak resident memory of the run's process, in bytes (Linux VmHWM).
    pub peak_rss_bytes: Option<u64>,
    pub items: Vec<HypothesisItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisItem {
    pub subset: String,
    pub item: String,
    pub audio_sha256: String,
    pub audio_seconds: f64,
    pub wall_seconds: f64,
    pub segments: Vec<HypothesisSegment>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisSegment {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

// ---------------------------------------------------------------------------------------------
// Reference tokens

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenClass {
    Fluent,
    /// An earlier copy of a whole word that is repeated next (`and and`).
    WordRepetition,
    /// An upper-case fragment the next word starts with (`L LOOKS`, `BLO BLOW`).
    PartWord,
    /// A sound held over three or more letters (`THISSSS`).
    Prolongation,
    /// Another word coded as disfluent (upper case: block, revision, tension).
    CodedWord,
    Filler,
}

const DISFLUENT_CLASSES: [TokenClass; 5] = [
    TokenClass::WordRepetition,
    TokenClass::PartWord,
    TokenClass::Prolongation,
    TokenClass::CodedWord,
    TokenClass::Filler,
];

#[derive(Debug, Clone, PartialEq)]
pub struct RefToken {
    pub text: String,
    pub key: String,
    pub class: TokenClass,
    /// Tokens of one whole-word repetition run share an id (the run includes its final copy).
    pub repetition_run: Option<usize>,
}

const FILLERS: [&str; 10] = [
    "um", "umm", "uh", "er", "erm", "em", "ah", "eh", "mm", "hmm",
];
const FILLER_KEY: &str = "<filler>";

/// Matching key of a word: lower case, letters/digits/apostrophes only, sounds held over three
/// or more letters collapsed, every filler the same.
pub fn word_key(word: &str) -> String {
    let lower: String = word
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric() || *c == '\'')
        .collect();
    let lower = lower.trim_matches('\'').to_string();
    let mut collapsed = String::new();
    let chars: Vec<char> = lower.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let mut run = 1;
        while index + run < chars.len() && chars[index + run] == chars[index] {
            run += 1;
        }
        let keep = if run >= 3 { 1 } else { run };
        collapsed.extend(std::iter::repeat_n(chars[index], keep));
        index += run;
    }
    if FILLERS.contains(&collapsed.as_str()) {
        FILLER_KEY.to_string()
    } else {
        collapsed
    }
}

/// Splits text into words: whitespace, plus hyphens inside a word (`w-want` → `w`, `want`), so
/// a recognizer that writes a part word joined to its target still gets credit for it.
fn split_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .flat_map(|word| word.split(['-', '\u{2014}', '\u{2013}']))
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .map(str::to_string)
        .collect()
}

fn is_all_caps(word: &str) -> bool {
    let letters: Vec<char> = word.chars().filter(|c| c.is_alphabetic()).collect();
    !letters.is_empty() && letters.iter().all(|c| c.is_uppercase())
}

fn has_held_sound(word: &str) -> bool {
    let chars: Vec<char> = word
        .chars()
        .filter(|c| c.is_alphabetic())
        .flat_map(char::to_lowercase)
        .collect();
    chars.windows(3).any(|w| w[0] == w[1] && w[1] == w[2])
}

/// Removes `{...}` and `(...)` annotations (blocks, prompts, speaker marks) from verbatim text.
fn strip_annotations(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth_brace = 0_u32;
    let mut depth_paren = 0_u32;
    for c in text.chars() {
        match c {
            '{' => depth_brace += 1,
            '}' => {
                depth_brace = depth_brace.saturating_sub(1);
                if depth_brace == 0 && depth_paren == 0 {
                    // `CONS{x9}OLE` stays one word.
                    continue;
                }
            }
            '(' => depth_paren += 1,
            ')' => {
                depth_paren = depth_paren.saturating_sub(1);
                out.push(' ');
            }
            _ if depth_brace == 0 && depth_paren == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// Words of a verbatim reference, each classified. Upper case marks a disfluency (UCLASS
/// convention) except the pronoun `I` and a sentence-initial `A`; a whole-word repetition is
/// recognized in any case.
pub fn reference_tokens(text: &str) -> Vec<RefToken> {
    let cleaned = strip_annotations(text);
    let mut raw: Vec<(String, bool)> = Vec::new();
    let mut sentence_start = true;
    for word in cleaned.split_whitespace() {
        let ends_sentence = word.ends_with(['.', '!', '?']);
        for part in split_words(word) {
            raw.push((part, sentence_start));
            sentence_start = false;
        }
        if ends_sentence {
            sentence_start = true;
        }
    }
    let keys: Vec<String> = raw.iter().map(|(word, _)| word_key(word)).collect();
    let next_non_filler = |index: usize| {
        (index + 1..keys.len()).find(|&next| keys[next] != FILLER_KEY && !keys[next].is_empty())
    };
    let mut tokens: Vec<RefToken> = Vec::with_capacity(raw.len());
    let mut run_of: Vec<Option<usize>> = vec![None; raw.len()];
    let mut runs = 0;
    for index in 0..raw.len() {
        if keys[index] == FILLER_KEY {
            continue;
        }
        if let Some(next) = next_non_filler(index) {
            if keys[next] == keys[index] {
                let run = *run_of[index].get_or_insert_with(|| {
                    runs += 1;
                    runs - 1
                });
                run_of[next] = Some(run);
            }
        }
    }
    for (index, (word, sentence_initial)) in raw.iter().enumerate() {
        let key = &keys[index];
        let pronoun_i = matches!(key.as_str(), "i" | "i'm" | "i've" | "i'll" | "i'd");
        let caps = is_all_caps(word) && !pronoun_i && !(*sentence_initial && key == "a");
        let next = next_non_filler(index);
        let class = if key == FILLER_KEY {
            TokenClass::Filler
        } else if next.is_some_and(|next| keys[next] == *key) {
            TokenClass::WordRepetition
        } else if has_held_sound(word) {
            TokenClass::Prolongation
        } else if caps
            && next.is_some_and(|next| {
                let target = &keys[next];
                target.len() > key.len()
                    && (target.starts_with(key.as_str())
                        || (key.chars().count() <= 2
                            && target.chars().next() == key.chars().next()))
            })
        {
            TokenClass::PartWord
        } else if caps {
            TokenClass::CodedWord
        } else {
            TokenClass::Fluent
        };
        tokens.push(RefToken {
            text: word.clone(),
            key: key.clone(),
            class,
            repetition_run: run_of[index],
        });
    }
    tokens.retain(|token| !token.key.is_empty());
    tokens
}

// ---------------------------------------------------------------------------------------------
// Time-aligned word grids

#[derive(Debug, Clone, PartialEq)]
pub struct GridInterval {
    pub start: f64,
    pub end: f64,
    pub label: String,
}

impl GridInterval {
    pub fn is_silence(&self) -> bool {
        self.label == "x"
    }
    pub fn is_word(&self) -> bool {
        !self.label.starts_with('x') && !self.label.is_empty()
    }
}

/// Parses a Praat short-format TextTier (`time "label"` per point) into intervals that run from
/// each point to the next; the last one ends at the tier's end time.
pub fn parse_word_grid(text: &str) -> Result<Vec<GridInterval>, String> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let tier = lines
        .iter()
        .position(|line| *line == "\"TextTier\"")
        .ok_or("word grid has no TextTier")?;
    let range = lines.get(tier + 2).ok_or("word grid has no tier range")?;
    let end: f64 = range
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .ok_or("word grid tier range is not numeric")?;
    let count: usize = lines
        .get(tier + 3)
        .and_then(|value| value.parse().ok())
        .ok_or("word grid point count is not numeric")?;
    let mut points = Vec::with_capacity(count);
    for line in lines.iter().skip(tier + 4).take(count) {
        let (time, label) = line
            .split_once(' ')
            .ok_or_else(|| format!("bad word grid point `{line}`"))?;
        let time: f64 = time
            .parse()
            .map_err(|_| format!("bad word grid time `{line}`"))?;
        let label = label.trim();
        let label = label
            .strip_prefix('"')
            .and_then(|label| label.strip_suffix('"'))
            .unwrap_or(label)
            .replace("\"\"", "\"");
        points.push((time, label));
    }
    if points.len() != count {
        return Err(format!(
            "word grid declares {count} points, has {}",
            points.len()
        ));
    }
    Ok(points
        .iter()
        .enumerate()
        .map(|(index, (start, label))| GridInterval {
            start: *start,
            end: points.get(index + 1).map_or(end, |next| next.0),
            label: label.clone(),
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Alignment

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Match,
    Substitute,
    Delete,
}

/// Levenshtein alignment of reference and hypothesis keys. Returns, per reference token, the
/// hypothesis index it was matched or substituted with, and the number of inserted words.
fn align(reference: &[String], hypothesis: &[String]) -> (Vec<(Op, Option<usize>)>, usize) {
    let (n, m) = (reference.len(), hypothesis.len());
    let width = m + 1;
    let mut cost = vec![0_u32; (n + 1) * width];
    for i in 0..=n {
        cost[i * width] = i as u32;
    }
    for (j, cell) in cost.iter_mut().take(width).enumerate() {
        *cell = j as u32;
    }
    for i in 1..=n {
        for j in 1..=m {
            let diagonal =
                cost[(i - 1) * width + j - 1] + u32::from(reference[i - 1] != hypothesis[j - 1]);
            let delete = cost[(i - 1) * width + j] + 1;
            let insert = cost[i * width + j - 1] + 1;
            cost[i * width + j] = diagonal.min(delete).min(insert);
        }
    }
    let mut per_reference = vec![(Op::Delete, None); n];
    let mut inserted = 0;
    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        let here = cost[i * width + j];
        if i > 0 && j > 0 {
            let same = reference[i - 1] == hypothesis[j - 1];
            if here == cost[(i - 1) * width + j - 1] + u32::from(!same) {
                per_reference[i - 1] = (if same { Op::Match } else { Op::Substitute }, Some(j - 1));
                i -= 1;
                j -= 1;
                continue;
            }
        }
        if i > 0 && here == cost[(i - 1) * width + j] + 1 {
            per_reference[i - 1] = (Op::Delete, None);
            i -= 1;
        } else {
            inserted += 1;
            j -= 1;
        }
    }
    (per_reference, inserted)
}

// ---------------------------------------------------------------------------------------------
// Scoring

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassCount {
    pub reference: usize,
    pub preserved: usize,
    pub rate: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemScore {
    pub reference_words: usize,
    pub hypothesis_words: usize,
    pub fluent_words: usize,
    pub fluent_errors: usize,
    pub inserted_words: usize,
    pub classes: BTreeMap<String, ClassCount>,
    pub long_pause_seconds: f64,
    pub words_in_long_pauses: usize,
    pub boundary_errors: Vec<f64>,
    pub examples: Vec<ErrorExample>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorExample {
    pub item: String,
    pub class: TokenClass,
    pub reference: String,
    pub hypothesis: String,
}

fn class_name(class: TokenClass) -> &'static str {
    match class {
        TokenClass::Fluent => "fluent",
        TokenClass::WordRepetition => "wordRepetition",
        TokenClass::PartWord => "partWord",
        TokenClass::Prolongation => "prolongation",
        TokenClass::CodedWord => "codedWord",
        TokenClass::Filler => "filler",
    }
}

/// Long pauses: annotated silences of at least this length.
pub const LONG_PAUSE_SECONDS: f64 = 1.0;
/// A hypothesis segment counts as inside a pause when it lies within it up to this tolerance.
const PAUSE_TOLERANCE_SECONDS: f64 = 0.1;

/// Scores one item: text preservation against verbatim tokens, plus pause hallucination and
/// segment-boundary error when the reference is a time-aligned grid.
pub fn score_item(
    item_id: &str,
    tokens: &[RefToken],
    grid: Option<&[GridInterval]>,
    hypothesis: &[HypothesisSegment],
    max_examples: usize,
) -> ItemScore {
    let hyp_words: Vec<String> = hypothesis
        .iter()
        .flat_map(|segment| split_words(&segment.text))
        .collect();
    let hyp_keys: Vec<String> = hyp_words
        .iter()
        .map(|word| word_key(word))
        .filter(|key| !key.is_empty())
        .collect();
    let mut score = ItemScore {
        hypothesis_words: hyp_keys.len(),
        ..ItemScore::default()
    };
    if !tokens.is_empty() {
        let ref_keys: Vec<String> = tokens.iter().map(|token| token.key.clone()).collect();
        let (ops, inserted) = align(&ref_keys, &hyp_keys);
        score.reference_words = tokens.len();
        score.inserted_words = inserted;
        for class in DISFLUENT_CLASSES {
            score
                .classes
                .insert(class_name(class).to_string(), ClassCount::default());
        }
        // Whole-word repetitions are scored per run: a run of k copies preserves
        // min(k - 1, matched - 1) repetitions, whichever copy the alignment kept.
        let mut runs: BTreeMap<usize, (usize, usize)> = BTreeMap::new();
        for (index, token) in tokens.iter().enumerate() {
            let matched = ops[index].0 == Op::Match;
            if let Some(run) = token.repetition_run {
                let entry = runs.entry(run).or_default();
                entry.0 += 1;
                entry.1 += usize::from(matched);
            }
            match token.class {
                TokenClass::Fluent => {
                    score.fluent_words += 1;
                    score.fluent_errors += usize::from(!matched);
                }
                TokenClass::WordRepetition => {}
                class => {
                    let count = score.classes.get_mut(class_name(class)).unwrap();
                    count.reference += 1;
                    count.preserved += usize::from(matched);
                }
            }
            if !matched && token.class != TokenClass::Fluent && score.examples.len() < max_examples
            {
                score
                    .examples
                    .push(example(item_id, tokens, &ops, &hyp_keys, index));
            }
        }
        let repetitions = score.classes.get_mut("wordRepetition").unwrap();
        for (copies, matched) in runs.values() {
            repetitions.reference += copies - 1;
            repetitions.preserved += matched.saturating_sub(1).min(copies - 1);
        }
        for count in score.classes.values_mut() {
            count.rate = rate(count.preserved, count.reference);
        }
    }
    if let Some(grid) = grid {
        for pause in grid.iter().filter(|interval| {
            interval.is_silence() && interval.end - interval.start >= LONG_PAUSE_SECONDS
        }) {
            score.long_pause_seconds += pause.end - pause.start;
            score.words_in_long_pauses += hypothesis
                .iter()
                .filter(|segment| {
                    segment.start_seconds >= pause.start - PAUSE_TOLERANCE_SECONDS
                        && segment.end_seconds <= pause.end + PAUSE_TOLERANCE_SECONDS
                })
                .map(|segment| split_words(&segment.text).len())
                .sum::<usize>();
        }
        let onsets: Vec<f64> = grid
            .iter()
            .filter(|interval| interval.is_word())
            .map(|interval| interval.start)
            .collect();
        if !onsets.is_empty() {
            score.boundary_errors = hypothesis
                .iter()
                .filter(|segment| !split_words(&segment.text).is_empty())
                .map(|segment| {
                    onsets
                        .iter()
                        .map(|onset| (segment.start_seconds - onset).abs())
                        .fold(f64::INFINITY, f64::min)
                })
                .collect();
        }
    }
    score
}

fn example(
    item: &str,
    tokens: &[RefToken],
    ops: &[(Op, Option<usize>)],
    hyp_keys: &[String],
    index: usize,
) -> ErrorExample {
    let from = index.saturating_sub(3);
    let to = (index + 4).min(tokens.len());
    let reference = tokens[from..to]
        .iter()
        .enumerate()
        .map(|(offset, token)| {
            if from + offset == index {
                format!("[{}]", token.text)
            } else {
                token.text.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let anchor = ops[from..to]
        .iter()
        .filter_map(|(_, hyp)| *hyp)
        .collect::<Vec<_>>();
    let hypothesis = match (anchor.first(), anchor.last()) {
        (Some(first), Some(last)) => hyp_keys[*first..=*last].join(" "),
        _ => String::new(),
    };
    ErrorExample {
        item: item.to_string(),
        class: tokens[index].class,
        reference,
        hypothesis,
    }
}

fn rate(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| round4(numerator as f64 / denominator as f64))
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

// ---------------------------------------------------------------------------------------------
// Report

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub model: String,
    pub chunk_seconds: f64,
    pub model_bytes: Option<u64>,
    pub peak_rss_bytes: Option<u64>,
    pub real_time_factor: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsetMetrics {
    pub items: usize,
    pub audio_seconds: f64,
    pub reference_words: usize,
    pub classes: BTreeMap<String, ClassCount>,
    /// Share of whole-word repetitions the transcript dropped.
    pub repeated_word_deletion_rate: Option<f64>,
    /// Word repetitions and part words pooled: the primary disfluency-preservation number.
    pub repetition_and_part_word_preservation: Option<f64>,
    pub fluent_word_error_rate: Option<f64>,
    pub inserted_words_per_100: Option<f64>,
    pub long_pause_seconds: f64,
    pub words_in_long_pauses_per_minute: Option<f64>,
    pub median_boundary_error_seconds: Option<f64>,
    pub real_time_factor: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsetReport {
    pub id: String,
    pub kind: SubsetKind,
    pub gap: Option<String>,
    pub baseline: Option<SubsetMetrics>,
    pub candidate: Option<SubsetMetrics>,
    pub baseline_examples: Vec<ErrorExample>,
    pub candidate_examples: Vec<ErrorExample>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeReport {
    pub manifest: String,
    pub baseline: RunSummary,
    pub candidate: RunSummary,
    pub subsets: Vec<SubsetReport>,
    pub verdict: Verdict,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub promoted: bool,
    pub reasons: Vec<String>,
}

/// Minimum gain in pooled repetition and part-word preservation for a candidate to be promoted.
pub const MIN_PRESERVATION_GAIN: f64 = 0.02;

/// A reference loaded for one item.
pub struct LoadedReference {
    pub tokens: Vec<RefToken>,
    pub grid: Option<Vec<GridInterval>>,
}

pub fn load_reference(format: ReferenceFormat, text: &str) -> Result<LoadedReference, String> {
    Ok(match format {
        ReferenceFormat::VerbatimText => LoadedReference {
            tokens: reference_tokens(text),
            grid: None,
        },
        ReferenceFormat::UclassWordGrid => LoadedReference {
            // Grid labels are phonetic (JSRU), so they give timing but no comparable words.
            tokens: Vec::new(),
            grid: Some(parse_word_grid(text)?),
        },
    })
}

/// Compares two runs on a manifest. `reference` returns an item's reference text.
pub fn compare_runs(
    manifest_name: &str,
    manifest: &ChallengeManifest,
    baseline: &HypothesisRun,
    candidate: &HypothesisRun,
    reference: &dyn Fn(&ChallengeItem) -> Result<String, String>,
    max_examples: usize,
) -> Result<ChallengeReport, String> {
    let mut subsets = Vec::new();
    for subset in &manifest.subsets {
        let ran = |run: &HypothesisRun| run.items.iter().any(|item| item.subset == subset.id);
        // A subset neither run transcribed is reported as not run; one run alone is an error.
        let not_run = !subset.items.is_empty() && !ran(baseline) && !ran(candidate);
        if subset.items.is_empty() || not_run {
            subsets.push(SubsetReport {
                id: subset.id.clone(),
                kind: subset.kind,
                gap: Some(if not_run {
                    "not run: neither run transcribed this subset".to_string()
                } else {
                    subset.gap.clone().unwrap_or_else(|| "no items".to_string())
                }),
                baseline: None,
                candidate: None,
                baseline_examples: Vec::new(),
                candidate_examples: Vec::new(),
            });
            continue;
        }
        let mut loaded = Vec::new();
        for item in &subset.items {
            loaded.push(load_reference(item.reference_format, &reference(item)?)?);
        }
        let (baseline_metrics, baseline_examples) =
            subset_metrics(subset, &loaded, baseline, max_examples)?;
        let (candidate_metrics, candidate_examples) =
            subset_metrics(subset, &loaded, candidate, max_examples)?;
        subsets.push(SubsetReport {
            id: subset.id.clone(),
            kind: subset.kind,
            gap: subset.gap.clone(),
            baseline: Some(baseline_metrics),
            candidate: Some(candidate_metrics),
            baseline_examples,
            candidate_examples,
        });
    }
    let verdict = verdict(&subsets);
    Ok(ChallengeReport {
        manifest: manifest_name.to_string(),
        baseline: run_summary(baseline),
        candidate: run_summary(candidate),
        subsets,
        verdict,
    })
}

fn run_summary(run: &HypothesisRun) -> RunSummary {
    let audio: f64 = run.items.iter().map(|item| item.audio_seconds).sum();
    let wall: f64 = run.items.iter().map(|item| item.wall_seconds).sum();
    RunSummary {
        model: run.model.clone(),
        chunk_seconds: run.chunk_seconds,
        model_bytes: run.model_bytes,
        peak_rss_bytes: run.peak_rss_bytes,
        real_time_factor: (audio > 0.0).then(|| round4(wall / audio)),
    }
}

fn subset_metrics(
    subset: &ChallengeSubset,
    loaded: &[LoadedReference],
    run: &HypothesisRun,
    max_examples: usize,
) -> Result<(SubsetMetrics, Vec<ErrorExample>), String> {
    let mut classes: BTreeMap<String, ClassCount> = BTreeMap::new();
    let mut total = ItemScore::default();
    let mut boundary = Vec::new();
    let mut examples = Vec::new();
    let mut audio_seconds = 0.0;
    let mut wall_seconds = 0.0;
    let mut text_items = false;
    for (item, reference) in subset.items.iter().zip(loaded) {
        let hypothesis = run
            .items
            .iter()
            .find(|candidate| candidate.subset == subset.id && candidate.item == item.id)
            .ok_or_else(|| {
                format!(
                    "{} run has no hypothesis for {}/{}",
                    run.model, subset.id, item.id
                )
            })?;
        if hypothesis.audio_sha256 != item.audio_sha256 {
            return Err(format!(
                "{} hypothesis for {}/{} was made from different audio",
                run.model, subset.id, item.id
            ));
        }
        audio_seconds += hypothesis.audio_seconds;
        wall_seconds += hypothesis.wall_seconds;
        text_items |= !reference.tokens.is_empty();
        let score = score_item(
            &item.id,
            &reference.tokens,
            reference.grid.as_deref(),
            &hypothesis.segments,
            max_examples.saturating_sub(examples.len()),
        );
        for (class, count) in &score.classes {
            let entry = classes.entry(class.clone()).or_default();
            entry.reference += count.reference;
            entry.preserved += count.preserved;
        }
        total.reference_words += score.reference_words;
        total.fluent_words += score.fluent_words;
        total.fluent_errors += score.fluent_errors;
        total.inserted_words += score.inserted_words;
        total.long_pause_seconds += score.long_pause_seconds;
        total.words_in_long_pauses += score.words_in_long_pauses;
        boundary.extend(score.boundary_errors);
        examples.extend(score.examples);
    }
    for count in classes.values_mut() {
        count.rate = rate(count.preserved, count.reference);
    }
    let repetitions = classes.get("wordRepetition").cloned().unwrap_or_default();
    let part_words = classes.get("partWord").cloned().unwrap_or_default();
    boundary.sort_by(f64::total_cmp);
    let metrics = SubsetMetrics {
        items: subset.items.len(),
        audio_seconds: round4(audio_seconds),
        reference_words: total.reference_words,
        repeated_word_deletion_rate: rate(
            repetitions.reference - repetitions.preserved,
            repetitions.reference,
        ),
        repetition_and_part_word_preservation: rate(
            repetitions.preserved + part_words.preserved,
            repetitions.reference + part_words.reference,
        ),
        classes,
        fluent_word_error_rate: rate(total.fluent_errors, total.fluent_words),
        inserted_words_per_100: (text_items && total.reference_words > 0)
            .then(|| round4(100.0 * total.inserted_words as f64 / total.reference_words as f64)),
        long_pause_seconds: round4(total.long_pause_seconds),
        words_in_long_pauses_per_minute: (total.long_pause_seconds > 0.0)
            .then(|| round4(total.words_in_long_pauses as f64 * 60.0 / total.long_pause_seconds)),
        median_boundary_error_seconds: (!boundary.is_empty())
            .then(|| round4(boundary[boundary.len() / 2])),
        real_time_factor: (audio_seconds > 0.0).then(|| round4(wall_seconds / audio_seconds)),
    };
    Ok((metrics, examples))
}

/// Promotion uses measured behavior only: the candidate must preserve more word repetitions and
/// part words on every scored text subset, insert no more words, and hallucinate no more in long
/// pauses.
fn verdict(subsets: &[SubsetReport]) -> Verdict {
    let mut reasons = Vec::new();
    let mut promoted = true;
    let mut scored = false;
    for subset in subsets {
        let (Some(baseline), Some(candidate)) = (&subset.baseline, &subset.candidate) else {
            continue;
        };
        if let (Some(b), Some(c)) = (
            baseline.repetition_and_part_word_preservation,
            candidate.repetition_and_part_word_preservation,
        ) {
            scored = true;
            if c - b < MIN_PRESERVATION_GAIN {
                promoted = false;
                reasons.push(format!(
                    "{}: repetition and part-word preservation {b:.3} → {c:.3} gains less than {MIN_PRESERVATION_GAIN}",
                    subset.id
                ));
            }
        }
        if let (Some(b), Some(c)) = (
            baseline.inserted_words_per_100,
            candidate.inserted_words_per_100,
        ) {
            if c > b {
                promoted = false;
                reasons.push(format!(
                    "{}: inserted words per 100 rise {b:.2} → {c:.2}",
                    subset.id
                ));
            }
        }
        if let (Some(b), Some(c)) = (
            baseline.words_in_long_pauses_per_minute,
            candidate.words_in_long_pauses_per_minute,
        ) {
            if c > b {
                promoted = false;
                reasons.push(format!(
                    "{}: words hallucinated in long pauses per minute rise {b:.2} → {c:.2}",
                    subset.id
                ));
            }
        }
    }
    if !scored {
        promoted = false;
        reasons.push("no subset scored disfluency preservation".to_string());
    }
    if promoted {
        reasons.push(
            "preserves more repetitions and part words on every scored subset without more insertions or pause hallucinations".to_string(),
        );
    }
    Verdict { promoted, reasons }
}

// ---------------------------------------------------------------------------------------------
// Noise

/// Adds seeded white noise at `snr_db` relative to the signal's mean power (deterministic).
pub fn add_noise(samples: &[f32], mix: NoiseMix) -> Vec<f32> {
    let power = samples
        .iter()
        .map(|sample| f64::from(*sample).powi(2))
        .sum::<f64>()
        / samples.len().max(1) as f64;
    let noise_rms = (power / 10_f64.powf(mix.snr_db / 10.0)).sqrt();
    let mut state = mix.seed ^ 0x9E37_79B9_7F4A_7C15;
    let mut uniform = move || {
        // xorshift64*
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1_u64 << 53) as f64
    };
    samples
        .iter()
        .map(|sample| {
            // Box–Muller.
            let (u1, u2) = (uniform().max(f64::MIN_POSITIVE), uniform());
            let gaussian = (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos();
            (f64::from(*sample) + gaussian * noise_rms).clamp(-1.0, 1.0) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_MANIFEST: &str = include_str!("../fixtures/asr-challenge/manifest.json");
    const FIXTURE_BASELINE: &str = include_str!("../fixtures/asr-challenge/baseline.json");
    const FIXTURE_CANDIDATE: &str = include_str!("../fixtures/asr-challenge/candidate.json");
    const FIXTURE_TEXT: &str = include_str!("../fixtures/asr-challenge/repetitions.txt");
    const FIXTURE_GRID: &str = include_str!("../fixtures/asr-challenge/pauses.word.grid");

    fn classes(text: &str) -> Vec<(String, TokenClass)> {
        reference_tokens(text)
            .into_iter()
            .map(|token| (token.text, token.class))
            .collect()
    }

    #[test]
    fn uclass_conventions_classify_disfluencies() {
        use TokenClass::*;
        assert_eq!(
            classes("Erm, I got that bear AND AND also a PLAY PLAYSTATION and THISSSS thing."),
            vec![
                ("Erm,".into(), Filler),
                ("I".into(), Fluent),
                ("got".into(), Fluent),
                ("that".into(), Fluent),
                ("bear".into(), Fluent),
                ("AND".into(), WordRepetition),
                ("AND".into(), CodedWord),
                ("also".into(), Fluent),
                ("a".into(), Fluent),
                ("PLAY".into(), PartWord),
                ("PLAYSTATION".into(), CodedWord),
                ("and".into(), Fluent),
                ("THISSSS".into(), Prolongation),
                ("thing.".into(), Fluent),
            ]
        );
        // Lower-case repetitions count, across a filler; annotations are dropped.
        assert_eq!(
            classes("then um then {block}L LOOKS (I): A cat"),
            vec![
                ("then".into(), WordRepetition),
                ("um".into(), Filler),
                ("then".into(), Fluent),
                ("L".into(), PartWord),
                ("LOOKS".into(), CodedWord),
                ("A".into(), CodedWord),
                ("cat".into(), Fluent),
            ]
        );
        assert_eq!(word_key("THISSSSSS"), "this");
        assert_eq!(word_key("Erm,"), FILLER_KEY);
        assert_eq!(word_key("they've"), "they've");
    }

    #[test]
    fn repetition_runs_count_preserved_copies_whichever_copy_is_kept() {
        let tokens = reference_tokens("I want and and and water");
        let segment = |text: &str| HypothesisSegment {
            text: text.into(),
            start_seconds: 0.0,
            end_seconds: 1.0,
        };
        let dropped = score_item("a", &tokens, None, &[segment("I want and water")], 5);
        assert_eq!(dropped.classes["wordRepetition"].reference, 2);
        assert_eq!(dropped.classes["wordRepetition"].preserved, 0);
        let kept = score_item("a", &tokens, None, &[segment("I want and and water")], 5);
        assert_eq!(kept.classes["wordRepetition"].preserved, 1);
        // A part word joined to its target by a hyphen is still preserved.
        let part = reference_tokens("a L LOOKS like");
        let joined = score_item("b", &part, None, &[segment("a l-looks like")], 5);
        assert_eq!(joined.classes["partWord"].preserved, 1);
        assert_eq!(joined.inserted_words, 0);
    }

    #[test]
    fn word_grid_intervals_and_pause_hallucination() {
        let grid = parse_word_grid(FIXTURE_GRID).unwrap();
        assert_eq!(grid.len(), 6);
        assert_eq!(grid[1].label, "x");
        assert!((grid[5].end - 6.0).abs() < 1e-9);
        let segment = |text: &str, start: f64, end: f64| HypothesisSegment {
            text: text.into(),
            start_seconds: start,
            end_seconds: end,
        };
        let score = score_item(
            "g",
            &[],
            Some(&grid),
            &[
                segment("hello there", 0.0, 1.0),
                segment("thank you", 1.6, 2.6),
                segment("friend", 3.05, 3.5),
            ],
            0,
        );
        assert!((score.long_pause_seconds - 1.6).abs() < 1e-9);
        assert_eq!(score.words_in_long_pauses, 2);
        assert_eq!(score.boundary_errors.len(), 3);
        assert!((score.boundary_errors[2] - 0.05).abs() < 1e-9);
    }

    #[test]
    fn synthetic_fixture_scores_end_to_end_and_reports_gaps() {
        let manifest: ChallengeManifest = serde_json::from_str(FIXTURE_MANIFEST).unwrap();
        let baseline: HypothesisRun = serde_json::from_str(FIXTURE_BASELINE).unwrap();
        let candidate: HypothesisRun = serde_json::from_str(FIXTURE_CANDIDATE).unwrap();
        let reference = |item: &ChallengeItem| -> Result<String, String> {
            Ok(match item.reference.as_str() {
                "repetitions.txt" => FIXTURE_TEXT.to_string(),
                "pauses.word.grid" => FIXTURE_GRID.to_string(),
                other => return Err(format!("unknown fixture {other}")),
            })
        };
        let report =
            compare_runs("fixture", &manifest, &baseline, &candidate, &reference, 3).unwrap();
        let by_id = |id: &str| report.subsets.iter().find(|s| s.id == id).unwrap();

        let text = by_id("synthetic-repetitions");
        let (b, c) = (
            text.baseline.as_ref().unwrap(),
            text.candidate.as_ref().unwrap(),
        );
        assert_eq!(b.repeated_word_deletion_rate, Some(1.0));
        assert_eq!(c.repeated_word_deletion_rate, Some(0.0));
        assert_eq!(b.repetition_and_part_word_preservation, Some(0.0));
        assert_eq!(c.repetition_and_part_word_preservation, Some(1.0));
        assert_eq!(b.classes["filler"].rate, Some(0.0));
        assert_eq!(c.classes["filler"].rate, Some(1.0));
        assert!(!text.baseline_examples.is_empty());
        assert!(text.baseline_examples[0].reference.contains('['));

        let pauses = by_id("synthetic-pauses");
        assert_eq!(
            pauses
                .baseline
                .as_ref()
                .unwrap()
                .words_in_long_pauses_per_minute,
            Some(75.0)
        );
        assert_eq!(
            pauses
                .candidate
                .as_ref()
                .unwrap()
                .words_in_long_pauses_per_minute,
            Some(0.0)
        );

        let gap = by_id("quiet-speech");
        assert!(gap.baseline.is_none());
        assert!(gap.gap.as_deref().unwrap().contains("no quiet"));

        assert_eq!(report.baseline.real_time_factor, Some(0.1));
        assert!(report.verdict.promoted, "{:?}", report.verdict.reasons);
    }

    #[test]
    fn a_subset_neither_run_transcribed_is_reported_as_not_run() {
        let manifest: ChallengeManifest = serde_json::from_str(FIXTURE_MANIFEST).unwrap();
        let mut baseline: HypothesisRun = serde_json::from_str(FIXTURE_BASELINE).unwrap();
        let mut candidate: HypothesisRun = serde_json::from_str(FIXTURE_CANDIDATE).unwrap();
        let reference = |item: &ChallengeItem| {
            Ok(
                if item.reference_format == ReferenceFormat::UclassWordGrid {
                    FIXTURE_GRID.to_string()
                } else {
                    FIXTURE_TEXT.to_string()
                },
            )
        };
        baseline
            .items
            .retain(|item| item.subset != "synthetic-pauses");
        let one_sided = compare_runs("fixture", &manifest, &baseline, &candidate, &reference, 0);
        assert!(one_sided.unwrap_err().contains("no hypothesis"));
        candidate
            .items
            .retain(|item| item.subset != "synthetic-pauses");
        let report =
            compare_runs("fixture", &manifest, &baseline, &candidate, &reference, 0).unwrap();
        let pauses = report
            .subsets
            .iter()
            .find(|subset| subset.id == "synthetic-pauses")
            .unwrap();
        assert!(pauses.baseline.is_none());
        assert!(pauses.gap.as_deref().unwrap().starts_with("not run"));
    }

    #[test]
    fn hypotheses_from_other_audio_are_rejected() {
        let manifest: ChallengeManifest = serde_json::from_str(FIXTURE_MANIFEST).unwrap();
        let mut baseline: HypothesisRun = serde_json::from_str(FIXTURE_BASELINE).unwrap();
        let candidate: HypothesisRun = serde_json::from_str(FIXTURE_CANDIDATE).unwrap();
        baseline.items[0].audio_sha256 = "different".into();
        let reference = |_: &ChallengeItem| Ok(FIXTURE_TEXT.to_string());
        let error =
            compare_runs("fixture", &manifest, &baseline, &candidate, &reference, 0).unwrap_err();
        assert!(error.contains("different audio"), "{error}");
    }

    #[test]
    fn noise_is_deterministic_at_the_requested_snr() {
        let signal: Vec<f32> = (0..16_000)
            .map(|index| (index as f32 * 0.05).sin() * 0.5)
            .collect();
        let mix = NoiseMix {
            snr_db: 10.0,
            seed: 7,
        };
        let noisy = add_noise(&signal, mix);
        assert_eq!(noisy, add_noise(&signal, mix));
        let signal_power: f64 =
            signal.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / signal.len() as f64;
        let noise_power: f64 = noisy
            .iter()
            .zip(&signal)
            .map(|(n, s)| f64::from(n - s).powi(2))
            .sum::<f64>()
            / signal.len() as f64;
        let snr = 10.0 * (signal_power / noise_power).log10();
        assert!((snr - 10.0).abs() < 0.3, "{snr}");
    }
}
