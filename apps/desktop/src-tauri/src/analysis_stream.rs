//! Incremental transcript-and-pause analysis while recording (vox#38).
//!
//! The batch analysis (`speech_pipeline::analyze_speech_session`) is the oracle. While a capture
//! runs, the desktop keeps one `AnalysisStream` per capture run and feeds it only what changed:
//! each update replaces the transcript segments from one position on and the pauses from one
//! position on (an append is a replacement of the empty tail). The stream analyzes only the new
//! positions and keeps, per position, its events, the token observations they cite and running
//! totals, so its report is the batch report of the same segments and pauses *without audio*,
//! value for value:
//!
//! - every event (kind, span, text, detail, confidence, evidence id and citations), in the batch
//!   order (stable by start time, then segment events before pause blocks, then position) and
//!   with the batch's duplicate removal;
//! - word count, speaking duration, pause duration, speaking rate, articulation rate, mean chunk
//!   words and duration, event density, fluency percentage, severity and counts per kind;
//! - pause statistics (block count, total, mean and longest block, blocks per minute, blocked
//!   time share) and every chunk row, including its events, blocks, fillers and silent time;
//! - the cited observations and the explicit missing observations.
//!
//! The tolerance is exact equality. Sums are kept as running folds in the batch's own order (a
//! revision rewinds to the fold before the first replaced position), so no number is summed in
//! a different order and nothing rounds differently. `finish` checks this against the oracle on
//! the final observation and reports a mismatch as such, never within a tolerance.
//!
//! Acoustic analysis is not part of this stream: its thresholds are medians over the whole
//! analyzed window, so an incremental version would be a different model, not a faster one.
//! It runs once after Stop in the batch report, which is the report that is saved.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::speech_analysis::{
    block_event, blocker_stats, classify_severity, event_applies_to_segment, is_filler,
    overlap_seconds, segment_average_confidence, segment_events, speech_stats_from_totals,
    timed_tokens, AnalysisReport, AnalyzeSpeechRequest, ChunkAnalysis, PauseInput, StutterEvent,
    StutterKind, TranscriptSegmentInput, SPEECH_ANALYSIS_VERSION,
};
use crate::speech_pipeline::{
    analyze_speech_session, missing_observations_from, native_capabilities, pause_observation,
    token_observation, Observation,
};

/// Retained segments beyond this are refused: the stream reports itself overloaded instead of
/// growing without bound (about ten hours of speech at one segment every two seconds).
pub const MAX_SEGMENTS: usize = 20_000;
/// Retained pauses beyond this are refused the same way.
pub const MAX_PAUSES: usize = 50_000;
/// Differences listed in a mismatch; the count covers all of them.
const LISTED_DIFFERENCES: usize = 8;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStartRequest {
    pub run_id: String,
    pub session_started_at: Option<String>,
}

/// One update: segments from `segments_from` on are replaced by `segments`, pauses from
/// `pauses_from` on by `pauses`. Updates are numbered from 0 per run.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPushRequest {
    pub run_id: String,
    pub seq: u64,
    pub segments_from: usize,
    #[serde(default)]
    pub segments: Vec<TranscriptSegmentInput>,
    pub pauses_from: usize,
    #[serde(default)]
    pub pauses: Vec<PauseInput>,
}

/// The final observation of the capture, which the oracle analyzes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamFinishRequest {
    pub run_id: String,
    pub segments: Vec<TranscriptSegmentInput>,
    pub pauses: Vec<PauseInput>,
    pub session_started_at: Option<String>,
}

/// - `live`: every update so far was applied; the report is current.
/// - `interrupted`: an update is missing or does not fit the retained input; nothing more is
///   applied until a full resynchronization (an update from position 0 of both lists).
/// - `overloaded`: the retained input would exceed its bound; the report stays at the last
///   applied update and is stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamStatus {
    Live,
    Interrupted,
    Overloaded,
}

/// Deterministic work evidence; wall-clock time is reported apart from it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkCounters {
    /// Updates that changed the input.
    pub updates: u64,
    /// Updates that changed nothing; they do no analysis and build no report.
    pub no_op_updates: u64,
    /// Repeated or older updates, ignored.
    pub duplicate_updates: u64,
    /// Updates refused while interrupted or overloaded, or that did not fit.
    pub rejected_updates: u64,
    pub segments_analyzed: u64,
    pub tokens_analyzed: u64,
    pub pauses_analyzed: u64,
    /// Positions analyzed again because a revision replaced them.
    pub segments_revisited: u64,
    pub pauses_revisited: u64,
    /// Updates that replaced all retained input from position 0 (resynchronizations).
    pub full_rebuilds: u64,
    /// Reports built; one per changing update.
    pub reports_built: u64,
    /// Events and chunks written into those reports (the report is a full snapshot).
    pub report_events: u64,
    pub report_chunks: u64,
    /// Events read to count the events of chunks (bounded by the events near each chunk).
    pub chunk_event_reads: u64,
    pub retained_segments: usize,
    pub retained_pauses: usize,
    pub retained_events: usize,
    pub retained_cited_observations: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamUpdate {
    pub run_id: String,
    pub seq: u64,
    pub status: StreamStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// False when the update changed nothing; `report` is then absent.
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<AnalysisReport>,
    pub work: WorkCounters,
    pub processing_ms: f64,
}

/// The finalized stream report compared with the batch report of the same final observation.
/// The declared tolerance is exact equality of the serialized reports.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum StreamParity {
    Match {
        events: usize,
        chunks: usize,
        observations: usize,
    },
    Mismatch {
        difference_count: usize,
        differences: Vec<String>,
    },
    NotComparable {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamFinished {
    pub run_id: String,
    pub status: StreamStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub parity: StreamParity,
    pub work: WorkCounters,
    /// Slowest single update and the batch oracle run, milliseconds.
    pub max_update_ms: f64,
    pub oracle_ms: f64,
}

/// Seconds ordered like `f64::total_cmp`, the order the batch sorts events in.
#[derive(Debug, Clone, Copy)]
struct Seconds(f64);

impl PartialEq for Seconds {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Seconds {}
impl PartialOrd for Seconds {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Seconds {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

/// Batch event order: start time, then segment events before pause blocks (the order they are
/// collected in before the stable sort), then position, then detector order within a segment.
type EventKey = (Seconds, u8, usize, usize);
const SEGMENT_EVENTS: u8 = 0;
const PAUSE_BLOCKS: u8 = 1;

/// Running totals over segment positions `0..=i`, folded in the batch's order.
#[derive(Debug, Clone, Copy)]
struct SegmentTotals {
    speaking_seconds: f64,
    end_seconds: f64,
    words: usize,
    finals: usize,
    tokens: usize,
    token_end_seconds: f64,
}

const NO_SEGMENTS: SegmentTotals = SegmentTotals {
    speaking_seconds: 0.0,
    end_seconds: 0.0,
    words: 0,
    finals: 0,
    tokens: 0,
    token_end_seconds: 0.0,
};

/// Running totals over pause positions `0..=i`.
#[derive(Debug, Clone, Copy)]
struct PauseTotals {
    pause_seconds: f64,
    end_seconds: f64,
    observed_end_seconds: f64,
}

fn no_pauses() -> PauseTotals {
    PauseTotals {
        // The batch sums with `Iterator::sum`, whose empty value is its fold seed.
        pause_seconds: std::iter::empty::<f64>().sum(),
        end_seconds: 0.0,
        observed_end_seconds: 0.0,
    }
}

#[derive(Debug)]
struct SegmentEntry {
    segment: TranscriptSegmentInput,
    event_keys: Vec<EventKey>,
    /// Token observations this segment's events cite, in token order.
    cited_tokens: Vec<Observation>,
    word_count: usize,
    totals: SegmentTotals,
}

#[derive(Debug)]
struct PauseEntry {
    pause: PauseInput,
    has_block: bool,
    /// Only a pause reported as a block can be cited.
    observation: Option<Observation>,
    totals: PauseTotals,
}

/// The incremental analysis of one capture run.
#[derive(Debug)]
pub struct AnalysisStream {
    run_id: String,
    session_started_at: Option<String>,
    next_seq: u64,
    status: StreamStatus,
    reason: Option<String>,
    segments: Vec<SegmentEntry>,
    pauses: Vec<PauseEntry>,
    events: BTreeMap<EventKey, StutterEvent>,
    /// Pauses by start, for the silent time of a chunk.
    pause_starts: BTreeSet<(Seconds, usize)>,
    /// Pauses with a NaN bound, which every chunk reads.
    unordered_pauses: BTreeSet<usize>,
    /// Upper bounds on event and pause length; they only grow, which keeps lookups correct.
    longest_event_seconds: f64,
    longest_pause_seconds: f64,
    work: WorkCounters,
    max_update_ms: f64,
}

impl AnalysisStream {
    pub fn start(request: &StreamStartRequest) -> Self {
        Self {
            run_id: request.run_id.clone(),
            session_started_at: request.session_started_at.clone(),
            next_seq: 0,
            status: StreamStatus::Live,
            reason: None,
            segments: Vec::new(),
            pauses: Vec::new(),
            events: BTreeMap::new(),
            pause_starts: BTreeSet::new(),
            unordered_pauses: BTreeSet::new(),
            longest_event_seconds: 0.0,
            longest_pause_seconds: 0.0,
            work: WorkCounters::default(),
            max_update_ms: 0.0,
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn push(&mut self, request: StreamPushRequest) -> Result<StreamUpdate, String> {
        let started = Instant::now();
        let seq = request.seq;
        let changed = self.apply(request)?;
        let report = changed.then(|| self.report());
        let processing_ms = started.elapsed().as_secs_f64() * 1_000.0;
        self.max_update_ms = self.max_update_ms.max(processing_ms);
        Ok(StreamUpdate {
            run_id: self.run_id.clone(),
            seq,
            status: self.status,
            reason: self.reason.clone(),
            changed,
            report,
            work: self.work.clone(),
            processing_ms,
        })
    }

    /// Ends the run and compares its report with the batch report of the final observation.
    pub fn finish(mut self, request: StreamFinishRequest) -> StreamFinished {
        let live = self.report();
        let started = Instant::now();
        let oracle = analyze_speech_session(AnalyzeSpeechRequest {
            segments: request.segments,
            pauses: request.pauses,
            session_started_at: request.session_started_at,
            samples: None,
            sample_rate: None,
        });
        let oracle_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let parity = match (self.status, oracle) {
            (StreamStatus::Live, Ok(oracle)) => compare_reports(&live, &oracle),
            (StreamStatus::Live, Err(error)) => StreamParity::NotComparable {
                reason: format!("the batch analysis failed: {error}"),
            },
            (status, _) => StreamParity::NotComparable {
                reason: format!(
                    "live analysis {}: {}",
                    match status {
                        StreamStatus::Interrupted => "interrupted",
                        _ => "overloaded",
                    },
                    self.reason.clone().unwrap_or_default()
                ),
            },
        };
        StreamFinished {
            run_id: self.run_id,
            status: self.status,
            reason: self.reason,
            parity,
            work: self.work,
            max_update_ms: self.max_update_ms,
            oracle_ms,
        }
    }

    /// Applies an update; true when it changed the input.
    fn apply(&mut self, request: StreamPushRequest) -> Result<bool, String> {
        if request.seq < self.next_seq {
            self.work.duplicate_updates += 1;
            return Ok(false);
        }
        let resync = request.segments_from == 0 && request.pauses_from == 0;
        if request.seq > self.next_seq && !resync {
            self.interrupt(format!(
                "update {} arrived while {} was expected",
                request.seq, self.next_seq
            ));
        }
        self.next_seq = request.seq + 1;
        if self.status != StreamStatus::Live && !resync {
            self.work.rejected_updates += 1;
            return Ok(false);
        }
        if request.segments_from > self.segments.len() || request.pauses_from > self.pauses.len() {
            self.work.rejected_updates += 1;
            self.interrupt(format!(
                "update {} replaces from segment {} and pause {}, beyond the {} segments and {} pauses held",
                request.seq,
                request.segments_from,
                request.pauses_from,
                self.segments.len(),
                self.pauses.len()
            ));
            return Ok(false);
        }
        if request.segments_from + request.segments.len() > MAX_SEGMENTS
            || request.pauses_from + request.pauses.len() > MAX_PAUSES
        {
            self.work.rejected_updates += 1;
            self.status = StreamStatus::Overloaded;
            self.reason = Some(format!(
                "more than {MAX_SEGMENTS} segments or {MAX_PAUSES} pauses"
            ));
            return Ok(false);
        }
        if request.segments.iter().any(|segment| {
            segment.is_final
                && (!segment.start_seconds.is_finite() || !segment.end_seconds.is_finite())
        }) {
            // The batch analysis refuses the same input.
            return Err("segment times must be finite".to_string());
        }
        if request.segments_from == self.segments.len()
            && request.segments.is_empty()
            && request.pauses_from == self.pauses.len()
            && request.pauses.is_empty()
        {
            self.work.no_op_updates += 1;
            return Ok(false);
        }
        if resync && (!self.segments.is_empty() || !self.pauses.is_empty()) {
            self.work.full_rebuilds += 1;
        }
        self.status = StreamStatus::Live;
        self.reason = None;
        self.work.updates += 1;
        self.truncate_segments(request.segments_from);
        self.truncate_pauses(request.pauses_from);
        for segment in request.segments {
            self.push_segment(segment);
        }
        for pause in request.pauses {
            self.push_pause(pause);
        }
        self.work.retained_segments = self.segments.len();
        self.work.retained_pauses = self.pauses.len();
        self.work.retained_events = self.events.len();
        Ok(true)
    }

    fn interrupt(&mut self, reason: String) {
        self.status = StreamStatus::Interrupted;
        self.reason = Some(reason);
    }

    fn truncate_segments(&mut self, from: usize) {
        for entry in self.segments.drain(from..) {
            self.work.segments_revisited += 1;
            self.work.retained_cited_observations -= entry.cited_tokens.len();
            for key in entry.event_keys {
                self.events.remove(&key);
            }
        }
    }

    fn truncate_pauses(&mut self, from: usize) {
        for (offset, entry) in self.pauses.drain(from..).enumerate() {
            self.work.pauses_revisited += 1;
            let position = from + offset;
            self.pause_starts
                .remove(&(Seconds(entry.pause.start_seconds), position));
            self.unordered_pauses.remove(&position);
            self.work.retained_cited_observations -= usize::from(entry.observation.is_some());
            if entry.has_block {
                self.events.remove(&(
                    Seconds(entry.pause.start_seconds),
                    PAUSE_BLOCKS,
                    position,
                    0,
                ));
            }
        }
    }

    fn push_segment(&mut self, segment: TranscriptSegmentInput) {
        let position = self.segments.len();
        let previous = self
            .segments
            .last()
            .map_or(NO_SEGMENTS, |entry| entry.totals);
        if !segment.is_final {
            // Partial results are provisional: the batch analyzes final segments only, but they
            // keep their position, which names the tokens of later segments.
            self.segments.push(SegmentEntry {
                segment,
                event_keys: Vec::new(),
                cited_tokens: Vec::new(),
                word_count: 0,
                totals: previous,
            });
            return;
        }
        self.work.segments_analyzed += 1;
        let tokens = timed_tokens(position, &segment);
        self.work.tokens_analyzed += tokens.len() as u64;
        let events = segment_events(&segment, &tokens);
        let cited: HashSet<&str> = events
            .iter()
            .filter_map(|event| event.evidence.as_ref())
            .flat_map(|evidence| evidence.supporting.iter())
            .map(String::as_str)
            .collect();
        let cited_tokens = tokens
            .iter()
            .enumerate()
            .filter(|(_, token)| cited.contains(token.id.as_str()))
            .map(|(index, token)| {
                token_observation(position, index, token.clone(), segment.confidence)
            })
            .collect::<Vec<_>>();
        self.work.retained_cited_observations += cited_tokens.len();
        let word_count = tokens
            .iter()
            .filter(|token| !is_filler(&token.normalized))
            .count();
        let totals = SegmentTotals {
            speaking_seconds: previous.speaking_seconds
                + (segment.end_seconds - segment.start_seconds).max(0.0),
            end_seconds: previous.end_seconds.max(segment.end_seconds),
            words: previous.words + word_count,
            finals: previous.finals + 1,
            tokens: previous.tokens + tokens.len(),
            token_end_seconds: tokens
                .iter()
                .map(|token| token.end_seconds)
                .filter(|value| value.is_finite())
                .fold(previous.token_end_seconds, f64::max),
        };
        let mut event_keys = Vec::with_capacity(events.len());
        for (order, event) in events.into_iter().enumerate() {
            let key = (
                Seconds(event.start_seconds),
                SEGMENT_EVENTS,
                position,
                order,
            );
            self.note_event_length(&event);
            self.events.insert(key, event);
            event_keys.push(key);
        }
        self.segments.push(SegmentEntry {
            segment,
            event_keys,
            cited_tokens,
            word_count,
            totals,
        });
    }

    fn push_pause(&mut self, pause: PauseInput) {
        let position = self.pauses.len();
        self.work.pauses_analyzed += 1;
        let previous = self
            .pauses
            .last()
            .map_or_else(no_pauses, |entry| entry.totals);
        let observation = pause_observation(position, &pause);
        let totals = PauseTotals {
            pause_seconds: previous.pause_seconds
                + (pause.end_seconds - pause.start_seconds).max(0.0),
            end_seconds: previous.end_seconds.max(pause.end_seconds),
            observed_end_seconds: match &observation {
                Some(observation) => previous.observed_end_seconds.max(observation.end_seconds),
                None => previous.observed_end_seconds,
            },
        };
        if pause.start_seconds.is_nan() || pause.end_seconds.is_nan() {
            // `f64::max`/`min` skip a NaN, so such a pause can overlap any chunk.
            self.unordered_pauses.insert(position);
        } else {
            self.longest_pause_seconds = self
                .longest_pause_seconds
                .max(pause.end_seconds - pause.start_seconds);
            self.pause_starts
                .insert((Seconds(pause.start_seconds), position));
        }
        let block = block_event(position, &pause);
        let has_block = block.is_some();
        if let Some(block) = block {
            self.note_event_length(&block);
            self.events.insert(
                (Seconds(block.start_seconds), PAUSE_BLOCKS, position, 0),
                block,
            );
        }
        let observation = if has_block { observation } else { None };
        self.work.retained_cited_observations += usize::from(observation.is_some());
        self.pauses.push(PauseEntry {
            pause,
            has_block,
            observation,
            totals,
        });
    }

    fn note_event_length(&mut self, event: &StutterEvent) {
        let length = event.end_seconds - event.start_seconds;
        if length > self.longest_event_seconds || length.is_nan() {
            // A NaN length makes every lookup scan from the start, which stays correct.
            self.longest_event_seconds = if length.is_nan() {
                f64::INFINITY
            } else {
                length
            };
        }
    }

    /// The report of the input so far, equal to the batch report of it without audio.
    fn report(&mut self) -> AnalysisReport {
        let segment_totals = self
            .segments
            .last()
            .map_or(NO_SEGMENTS, |entry| entry.totals);
        let pause_totals = self
            .pauses
            .last()
            .map_or_else(no_pauses, |entry| entry.totals);

        let mut events: Vec<StutterEvent> = Vec::with_capacity(self.events.len());
        for event in self.events.values() {
            if events.last().is_some_and(|kept| {
                kept.kind == event.kind
                    && (event.start_seconds - kept.start_seconds).abs() < 0.08
                    && event.text == kept.text
            }) {
                continue;
            }
            events.push(event.clone());
        }

        let word_count = segment_totals.words;
        let total_duration_seconds = segment_totals.end_seconds.max(pause_totals.end_seconds);
        let minutes = (total_duration_seconds / 60.0).max(1.0 / 60.0);
        let stutters_per_minute = events.len() as f64 / minutes;
        let severity = classify_severity(stutters_per_minute, word_count, events.len());
        let mut by_kind = HashMap::new();
        for event in &events {
            *by_kind.entry(event.kind).or_insert(0) += 1;
        }
        let speech_stats = speech_stats_from_totals(
            total_duration_seconds,
            segment_totals.speaking_seconds,
            pause_totals.pause_seconds,
            word_count,
            events.len(),
            segment_totals.finals,
        );
        let blocker_stats = blocker_stats(&events, total_duration_seconds);
        let chunks = self.chunks(&events);

        let cited: HashSet<&str> = events
            .iter()
            .filter_map(|event| event.evidence.as_ref())
            .flat_map(|evidence| evidence.supporting.iter().chain(&evidence.conflicting))
            .map(String::as_str)
            .collect();
        let mut observations: Vec<Observation> = self
            .segments
            .iter()
            .flat_map(|entry| &entry.cited_tokens)
            .chain(
                self.pauses
                    .iter()
                    .filter_map(|entry| entry.observation.as_ref()),
            )
            .filter(|observation| cited.contains(observation.id.as_str()))
            .cloned()
            .collect();
        observations.extend(missing_observations_from(
            segment_totals
                .token_end_seconds
                .max(pause_totals.observed_end_seconds),
            segment_totals.tokens > 0,
            None,
            None,
        ));

        self.work.reports_built += 1;
        self.work.report_events += events.len() as u64;
        self.work.report_chunks += chunks.len() as u64;
        AnalysisReport {
            analyzer_version: SPEECH_ANALYSIS_VERSION,
            session_started_at: self.session_started_at.clone(),
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
            acoustic_stats: None,
            capture_metrics: None,
            observations: Some(observations),
            capabilities: Some(native_capabilities()),
            insufficient_evidence: Vec::new(),
        }
    }

    /// One row per final segment. `events` are the reported events, sorted by start; a chunk
    /// reads only the events and pauses that can reach it.
    fn chunks(&mut self, events: &[StutterEvent]) -> Vec<ChunkAnalysis> {
        let pause_sum_seed = no_pauses().pause_seconds;
        let mut chunks = Vec::new();
        for entry in self.segments.iter().filter(|entry| entry.segment.is_final) {
            let segment = &entry.segment;
            let (start, end) = (segment.start_seconds, segment.end_seconds);
            // An event reaches a chunk by overlapping it or, as a block, ending at most 1 s
            // before it starts; either way it starts after `lower` and before `upper`.
            let lower = start.min(end) - self.longest_event_seconds - 2.0;
            let upper = start.max(end);
            let first = if lower.is_finite() {
                events.partition_point(|event| event.start_seconds.total_cmp(&lower).is_lt())
            } else {
                0
            };
            let (mut stutter_count, mut block_count, mut filler_count) = (0, 0, 0);
            for event in events[first..]
                .iter()
                .take_while(|event| event.start_seconds.total_cmp(&upper).is_lt())
            {
                self.work.chunk_event_reads += 1;
                if event_applies_to_segment(event, segment) {
                    stutter_count += 1;
                    block_count += usize::from(event.kind == StutterKind::Block);
                    filler_count += usize::from(event.kind == StutterKind::Filler);
                }
            }

            // The batch sums every pause's overlap in pause order; a pause that cannot overlap
            // adds an exact zero, so summing only the overlapping ones in order is the same sum.
            let pause_lower = start - self.longest_pause_seconds - 2.0;
            let range = if pause_lower.is_finite() {
                self.pause_starts.range((Seconds(pause_lower), 0)..)
            } else {
                self.pause_starts.range(..)
            };
            let mut overlapping: Vec<(usize, f64)> = range
                .take_while(|(pause_start, _)| pause_start.0.total_cmp(&end).is_lt())
                .map(|(_, position)| position)
                .chain(&self.unordered_pauses)
                .filter_map(|position| {
                    let pause = &self.pauses[*position].pause;
                    let overlap =
                        overlap_seconds(pause.start_seconds, pause.end_seconds, start, end);
                    (overlap != 0.0).then_some((*position, overlap))
                })
                .collect();
            overlapping.sort_unstable_by_key(|(position, _)| *position);
            let mut silent_pause_seconds = pause_sum_seed;
            if !self.pauses.is_empty() {
                silent_pause_seconds += 0.0;
            }
            for (_, overlap) in overlapping {
                silent_pause_seconds += overlap;
            }

            let duration_seconds = (end - start).max(0.0);
            chunks.push(ChunkAnalysis {
                index: chunks.len(),
                start_seconds: start,
                end_seconds: end,
                duration_seconds,
                text: segment.text.clone(),
                word_count: entry.word_count,
                stutter_count,
                block_count,
                filler_count,
                words_per_minute: entry.word_count as f64
                    / (duration_seconds / 60.0).max(1.0 / 60.0),
                silent_pause_seconds,
                average_confidence: segment_average_confidence(segment),
            });
        }
        chunks
    }
}

/// Exact comparison of the serialized reports (the stream's tolerance is zero).
pub fn compare_reports(live: &AnalysisReport, oracle: &AnalysisReport) -> StreamParity {
    let live_value = serde_json::to_value(live).expect("reports serialize");
    let oracle_value = serde_json::to_value(oracle).expect("reports serialize");
    let mut differences = Vec::new();
    exact_differences("report", &oracle_value, &live_value, &mut differences);
    if differences.is_empty() {
        StreamParity::Match {
            events: live.events.len(),
            chunks: live.chunks.len(),
            observations: live.observations.as_ref().map_or(0, Vec::len),
        }
    } else {
        StreamParity::Mismatch {
            difference_count: differences.len(),
            differences: differences.into_iter().take(LISTED_DIFFERENCES).collect(),
        }
    }
}

fn exact_differences(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Object(left), Value::Object(right)) => {
            for key in left
                .keys()
                .chain(right.keys().filter(|key| !left.contains_key(*key)))
            {
                exact_differences(
                    &format!("{path}.{key}"),
                    left.get(key).unwrap_or(&Value::Null),
                    right.get(key).unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        (Value::Array(left), Value::Array(right)) if left.len() == right.len() => {
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                exact_differences(&format!("{path}[{index}]"), left, right, out);
            }
        }
        _ if expected != actual => {
            let shown = |value: &Value| {
                let text = value.to_string();
                if text.chars().count() > 80 {
                    format!("{}…", text.chars().take(80).collect::<String>())
                } else {
                    text
                }
            };
            out.push(format!(
                "{path}: batch {}, live {}",
                shown(expected),
                shown(actual)
            ));
        }
        _ => {}
    }
}

/// The desktop's stream; starting a run replaces the previous one, so an older run's updates
/// are refused instead of changing the active run.
#[derive(Default)]
pub struct AnalysisStreamState(pub Mutex<Option<AnalysisStream>>);

pub fn start_active(
    state: &AnalysisStreamState,
    request: &StreamStartRequest,
) -> Result<(), String> {
    *state.0.lock().map_err(|err| err.to_string())? = Some(AnalysisStream::start(request));
    Ok(())
}

pub fn push_active(
    state: &AnalysisStreamState,
    request: StreamPushRequest,
) -> Result<StreamUpdate, String> {
    let mut guard = state.0.lock().map_err(|err| err.to_string())?;
    match guard.as_mut() {
        Some(stream) if stream.run_id() == request.run_id => stream.push(request),
        _ => Err(format!("no analysis stream run {}", request.run_id)),
    }
}

/// Takes the run out of the state, so the oracle runs without holding the lock.
pub fn finish_active(
    state: &AnalysisStreamState,
    request: StreamFinishRequest,
) -> Result<StreamFinished, String> {
    let stream = {
        let mut guard = state.0.lock().map_err(|err| err.to_string())?;
        match guard.take() {
            Some(stream) if stream.run_id() == request.run_id => stream,
            other => {
                *guard = other;
                return Err(format!("no analysis stream run {}", request.run_id));
            }
        }
    };
    Ok(stream.finish(request))
}

#[cfg(test)]
mod tests;
