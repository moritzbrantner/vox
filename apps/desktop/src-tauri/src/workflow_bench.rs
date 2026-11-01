//! Runtime budgets of the desktop's speaking workflows (vox#43).
//!
//! Each workflow runs the product's own code paths on real recordings, the way the app calls them:
//!
//! - **record**: the recorder's chunks through live Silero voice activity, the transcript and
//!   pauses through the incremental analysis stream as they arrive (each segment partial first,
//!   then final), then Stop (live voice activity finished, Silero over the whole capture, the
//!   stream's finish with its batch oracle, the batch analysis with audio that becomes the saved
//!   report), then Save (the session's value and the session index into protected storage, the
//!   kept audio, the session's speech corpus entry), then the corpus analysis the app asks for
//!   after Save, off its path.
//! - **review**: opening the app on the saved store (every web entry unsealed, the corpus loaded
//!   and analyzed), then opening each session's kept audio.
//! - **import**: replacing the store with a backup's sessions (session list, corpus, kept audio
//!   retained to the restored ids). Decrypting and validating the backup itself is the web view's
//!   code, measured by the browser harness.
//!
//! Two kinds of evidence come out, kept apart: deterministic work counters (`counters`), which
//! must stay proportional to the input and are compared exactly against a committed baseline, and
//! wall-clock/CPU/memory measurements (`timings`), which are advisory and only reported.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};

use crate::analysis_stream::{
    AnalysisStream, StreamFinishRequest, StreamParity, StreamPushRequest, StreamStartRequest,
    WorkCounters,
};
use crate::corpus::{CorpusFiles, CorpusSessionInput, SpeechCorpus};
use crate::protected_store::{
    Namespace, ProtectedStore, StoreDocument, StoreEntries, SPEECH_CORPUS_DOCUMENT,
};
use crate::speech_analysis::{
    timed_tokens, AnalyzeSpeechRequest, PauseInput, TranscriptSegmentInput,
};
use crate::speech_pipeline::analyze_speech_session;
use crate::voice_activity::{
    analyze_finite, FiniteRequest, LivePushRequest, LiveStartRequest, LiveVoiceActivity, VadStatus,
    VAD_SAMPLE_RATE,
};

/// The web view's session index (the saved sessions' ids, newest first); the app keeps at most
/// this many sessions. Each session is its own value under `SESSION_KEY_PREFIX` + id.
pub const SESSIONS_KEY: &str = "stutter-tracker:sessions";
pub const SESSION_KEY_PREFIX: &str = "stutter-tracker:session:";
pub const MAX_SAVED_SESSIONS: usize = 50;
/// Samples per recorder chunk (the web recorder's script-processor buffer).
pub const RECORDER_CHUNK: usize = 2_048;
/// The batch acoustic analysis reads at most this much audio.
pub const ACOUSTIC_WINDOW_SECONDS: f64 = 90.0;
/// Events read per chunk row, beyond twice the event density; more means a chunk rescans history.
pub const MAX_CHUNK_EVENT_READS: f64 = 12.0;

/// One recording: mono samples and the transcript a recognizer produced for it.
#[derive(Debug, Clone)]
pub struct Recording {
    pub id: String,
    pub sample_rate: u32,
    pub samples: Vec<f32>,
    /// `(text, start, end)` of each final segment.
    pub segments: Vec<(String, f64, f64)>,
}

#[derive(Debug, Clone)]
pub struct Options {
    /// Transcription chunk length: a segment arrives when its chunk is done.
    pub chunk_seconds: f64,
    /// Directory the benchmark's protected store is created in (emptied first).
    pub store_root: PathBuf,
}

/// Process CPU time, peak resident memory and wall time of one workflow phase.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseTimings {
    pub wall_seconds: f64,
    /// User + system CPU of the whole process (every thread); `None` where unmeasurable.
    pub cpu_seconds: Option<f64>,
    /// Resident set when the phase started (memory earlier phases left resident).
    pub start_rss_bytes: Option<u64>,
    /// Peak resident set during the phase (reset at its start); `None` where unmeasurable.
    pub peak_rss_bytes: Option<u64>,
}

struct PhaseMeter {
    started: Instant,
    cpu: Option<f64>,
    rss: Option<u64>,
}

impl PhaseMeter {
    fn start() -> Self {
        // Resets the peak resident set to the current one (Linux 4.0+), so the peak is the phase's.
        let _ = fs::write("/proc/self/clear_refs", "5");
        Self {
            started: Instant::now(),
            cpu: process_cpu_seconds(),
            rss: status_bytes("VmRSS:"),
        }
    }

    fn stop(self) -> PhaseTimings {
        PhaseTimings {
            wall_seconds: self.started.elapsed().as_secs_f64(),
            cpu_seconds: process_cpu_seconds()
                .zip(self.cpu)
                .map(|(now, then)| now - then),
            start_rss_bytes: self.rss,
            peak_rss_bytes: status_bytes("VmHWM:"),
        }
    }
}

/// utime + stime of `/proc/self/stat`, in clock ticks of 1/100 s (Linux's fixed USER_HZ).
fn process_cpu_seconds() -> Option<f64> {
    let stat = fs::read_to_string("/proc/self/stat").ok()?;
    // Fields after the parenthesized command name; utime and stime are fields 14 and 15.
    let rest = &stat[stat.rfind(')')? + 2..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    let utime: f64 = fields.get(11)?.parse().ok()?;
    let stime: f64 = fields.get(12)?.parse().ok()?;
    Some((utime + stime) / 100.0)
}

/// A `/proc/self/status` memory field (`VmRSS:`, `VmHWM:`) in bytes.
fn status_bytes(field: &str) -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with(field))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

/// Distribution of per-call latencies, milliseconds.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latency {
    pub count: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    pub total_ms: f64,
}

impl Latency {
    pub fn of(mut values: Vec<f64>) -> Self {
        if values.is_empty() {
            return Self::default();
        }
        values.sort_by(f64::total_cmp);
        let at =
            |q: f64| values[((values.len() as f64 * q).ceil() as usize).clamp(1, values.len()) - 1];
        Self {
            count: values.len(),
            p50_ms: at(0.5),
            p95_ms: at(0.95),
            max_ms: values[values.len() - 1],
            total_ms: values.iter().sum(),
        }
    }
}

/// Deterministic work of recording one session.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordCounters {
    pub sample_rate: u32,
    pub audio_samples: u64,
    pub segments: u64,
    pub tokens: u64,
    pub pauses: u64,
    /// `detected` when Silero ran; otherwise why not.
    pub voice_activity: String,
    pub vad_chunks: u64,
    pub vad_spans_live: u64,
    /// Finite Silero passes on Stop: 0 when the live run covered the capture.
    pub vad_finite_runs: u64,
    /// 16 kHz samples Silero analyzed for this capture, live and on Stop: one pass.
    pub vad_silero_samples: u64,
    pub stream: WorkCounters,
    pub stream_parity: String,
    pub report_events: u64,
    /// Audio the batch acoustic analysis read, in samples.
    pub acoustic_samples: u64,
    /// Bytes handed to the protected store on Save: the session's own value, the session index
    /// (ids only), the kept audio and the session's corpus entry. Only the index depends on the
    /// sessions saved before, by one id each (vox#157).
    pub saved_session_bytes: u64,
    pub saved_session_index_bytes: u64,
    pub saved_sessions_in_list: u64,
    pub saved_audio_bytes: u64,
    pub saved_corpus_bytes: u64,
    pub saved_corpus_sessions: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTimings {
    pub vad_push: Latency,
    pub stream_update: Latency,
    pub stop_ms: f64,
    pub stop_vad_finite_ms: f64,
    pub stop_stream_finish_ms: f64,
    pub stop_batch_ms: f64,
    pub save_ms: f64,
    pub save_corpus_ms: f64,
    /// The corpus analysis the app asks for after Save, off its path.
    pub corpus_analysis_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedSession {
    pub id: String,
    pub audio_seconds: f64,
    pub counters: RecordCounters,
    pub timings: RecordTimings,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCounters {
    pub web_entries_unsealed: u64,
    pub web_bytes_unsealed: u64,
    pub corpus_sessions_loaded: u64,
    pub audio_opened: u64,
    pub audio_bytes_unsealed: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTimings {
    pub app_open_ms: f64,
    pub corpus_load_ms: f64,
    pub audio_open: Latency,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounters {
    pub sessions: u64,
    pub session_list_bytes: u64,
    pub corpus_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTimings {
    pub session_list_ms: f64,
    pub corpus_ms: f64,
    pub retain_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema_version: u32,
    pub platform: &'static str,
    pub recordings: Vec<RecordedSession>,
    pub review: (ReviewCounters, ReviewTimings),
    pub import: (ImportCounters, ImportTimings),
    pub phases: Phases,
    /// Proportional-work violations; empty when every workflow did proportional work.
    pub violations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Phases {
    pub record: PhaseTimings,
    pub review: PhaseTimings,
    pub import: PhaseTimings,
}

/// Runs every workflow over `recordings`, in order, into a fresh store under `options.store_root`.
/// Recordings are loaded one at a time, as a capture is held, so memory is the workflow's.
pub fn run(
    recordings: impl IntoIterator<Item = Result<Recording, String>>,
    options: &Options,
) -> Result<Report, String> {
    let _ = fs::remove_dir_all(&options.store_root);
    fs::create_dir_all(&options.store_root).map_err(|error| error.to_string())?;
    let store =
        ProtectedStore::with_key(&options.store_root, &[7; 32]).map_err(|e| e.to_string())?;
    let entries = StoreEntries::Protected {
        store: &store,
        namespace: Namespace::Corpus,
    };
    let legacy = StoreDocument::Protected {
        store: &store,
        name: SPEECH_CORPUS_DOCUMENT,
    };
    let files = CorpusFiles {
        sessions: &entries,
        legacy: &legacy,
    };

    let meter = PhaseMeter::start();
    let mut sessions: Vec<Value> = Vec::new();
    let mut recorded = Vec::new();
    // The app run's corpus: read once, kept in step with each save.
    let mut corpus = SpeechCorpus::default();
    for (index, recording) in recordings.into_iter().enumerate() {
        recorded.push(record(
            &recording?,
            index,
            options,
            &store,
            (&mut corpus, &files),
            &mut sessions,
        )?);
    }
    let record_phase = meter.stop();

    // Review and import start a new app run, which reads the corpus again.
    let meter = PhaseMeter::start();
    let review = review(&store, &files, &sessions)?;
    let review_phase = meter.stop();

    let meter = PhaseMeter::start();
    let import = import(&store, &files, &sessions)?;
    let import_phase = meter.stop();

    let mut violations = Vec::new();
    for session in &recorded {
        violations.extend(record_violations(&session.id, &session.counters));
    }
    let sealed: u64 = sessions.len() as u64;
    if review.0.audio_opened != sealed {
        violations.push(format!(
            "review opened {} kept captures of {sealed}",
            review.0.audio_opened
        ));
    }
    let _ = fs::remove_dir_all(&options.store_root);
    Ok(Report {
        schema_version: 1,
        platform: "desktop",
        recordings: recorded,
        review,
        import,
        phases: Phases {
            record: record_phase,
            review: review_phase,
            import: import_phase,
        },
        violations,
    })
}

fn record(
    recording: &Recording,
    index: usize,
    options: &Options,
    store: &ProtectedStore,
    (corpus, files): (&mut SpeechCorpus, &CorpusFiles),
    sessions: &mut Vec<Value>,
) -> Result<RecordedSession, String> {
    let rate = recording.sample_rate;
    let run_id = format!("bench-{index}");
    let segments: Vec<TranscriptSegmentInput> = recording
        .segments
        .iter()
        .map(|(text, start, end)| TranscriptSegmentInput {
            text: text.clone(),
            start_seconds: *start,
            end_seconds: *end,
            confidence: None,
            speaker_score: None,
            is_final: true,
            alignment: None,
        })
        .collect();
    let pauses = recorder_pauses(&recording.samples, f64::from(rate), &segments);
    let tokens: usize = segments
        .iter()
        .enumerate()
        .map(|(position, segment)| timed_tokens(position, segment).len())
        .sum();

    // Live voice activity over the recorder's chunks.
    let (mut vad, started) = LiveVoiceActivity::start(&LiveStartRequest {
        run_id: run_id.clone(),
        sample_rate: rate,
    })?;
    let mut vad_push_ms = Vec::new();
    let mut vad_spans_live = 0u64;
    for (seq, chunk) in recording.samples.chunks(RECORDER_CHUNK).enumerate() {
        let started = Instant::now();
        let update = vad.push(&LivePushRequest {
            run_id: run_id.clone(),
            seq: seq as u64,
            samples: chunk.to_vec(),
        })?;
        vad_push_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
        vad_spans_live += update.finalized.len() as u64;
    }

    // Live analysis: a segment arrives when its transcription chunk is done (partial, then
    // final), a pause when it ends.
    let mut stream = AnalysisStream::start(&StreamStartRequest {
        run_id: run_id.clone(),
        session_started_at: None,
    });
    let mut arrivals: Vec<(f64, bool, usize)> = segments
        .iter()
        .enumerate()
        .map(|(position, segment)| {
            let done = ((segment.end_seconds / options.chunk_seconds).floor() + 1.0)
                * options.chunk_seconds;
            (done, true, position)
        })
        .chain(
            pauses
                .iter()
                .enumerate()
                .map(|(position, pause)| (pause.end_seconds, false, position)),
        )
        .collect();
    arrivals.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut client = StreamClient::default();
    let mut stream_ms = Vec::new();
    let (mut shown_segments, mut shown_pauses) = (0usize, 0usize);
    for (_, is_segment, position) in &arrivals {
        let arrived_from = shown_segments;
        if *is_segment {
            shown_segments = shown_segments.max(position + 1);
        } else {
            shown_pauses = shown_pauses.max(position + 1);
        }
        let mut partial = segments[..shown_segments].to_vec();
        for segment in &mut partial[arrived_from..] {
            segment.is_final = false;
        }
        for shown in [&partial[..], &segments[..shown_segments]] {
            if let Some(ms) = client.sync(&mut stream, &run_id, shown, &pauses[..shown_pauses])? {
                stream_ms.push(ms);
            }
        }
    }
    if let Some(ms) = client.sync(&mut stream, &run_id, &segments, &pauses)? {
        stream_ms.push(ms);
    }

    // Stop.
    let stop = Instant::now();
    let finished_vad = vad.finish();
    vad_spans_live += finished_vad.finalized.len() as u64;
    // As the app's Stop (`useVoiceActivity.finish`): a clean live run is the evidence; the
    // finite pass runs only when live detection did not analyze the whole capture.
    let finite_started = Instant::now();
    let mut silero_samples = finished_vad.silero_samples;
    let mut vad_finite_runs = 0;
    if finished_vad.status != VadStatus::Detected {
        let finite = analyze_finite(&FiniteRequest {
            samples: recording.samples.clone(),
            sample_rate: rate,
        })?;
        silero_samples += finite.silero_samples;
        vad_finite_runs = 1;
    }
    let stop_vad_finite_ms = finite_started.elapsed().as_secs_f64() * 1_000.0;
    let finish_started = Instant::now();
    let finished = stream.finish(StreamFinishRequest {
        run_id: run_id.clone(),
        segments: segments.clone(),
        pauses: pauses.clone(),
        session_started_at: None,
    });
    let stop_stream_finish_ms = finish_started.elapsed().as_secs_f64() * 1_000.0;
    let batch_started = Instant::now();
    let report = analyze_speech_session(AnalyzeSpeechRequest {
        segments: segments.clone(),
        pauses: pauses.clone(),
        session_started_at: None,
        // The web view sends the last 90 s of the capture (`analysisAudioPayload`).
        samples: Some(
            recording.samples[recording
                .samples
                .len()
                .saturating_sub((ACOUSTIC_WINDOW_SECONDS * f64::from(rate)) as usize)..]
                .to_vec(),
        ),
        sample_rate: Some(rate),
    })
    .map_err(|error| error.to_string())?;
    let stop_batch_ms = batch_started.elapsed().as_secs_f64() * 1_000.0;
    let stop_ms = stop.elapsed().as_secs_f64() * 1_000.0;
    let acoustic_samples = report
        .acoustic_stats
        .as_ref()
        .map(|stats| (stats.analyzed_duration_seconds * f64::from(rate)).round() as u64)
        .unwrap_or(0);

    // Save: the newest session first in the list, the kept audio, the corpus.
    let save_started = Instant::now();
    let report_value = serde_json::to_value(&report).map_err(|error| error.to_string())?;
    let session_id = format!("uclass-{index:03}-{}", recording.id);
    let session = json!({
        "id": session_id,
        "startedAt": started_at(index),
        "segments": segments.iter().map(segment_json).collect::<Vec<_>>(),
        "pauses": pauses.iter().map(|pause| json!({
            "startSeconds": pause.start_seconds,
            "endSeconds": pause.end_seconds,
            "afterText": pause.after_text,
        })).collect::<Vec<_>>(),
        "report": report_value,
    });
    sessions.insert(0, session.clone());
    let dropped = sessions.split_off(sessions.len().min(MAX_SAVED_SESSIONS));
    let (session_bytes, index_bytes) = write_sessions(store, &[&session], sessions, &dropped)?;
    let audio = encode_audio(&session_id, rate, &recording.samples);
    store
        .write(Namespace::Audio, &session_id, &audio)
        .map_err(|error| error.to_string())?;
    let corpus_started = Instant::now();
    let corpus_bytes = corpus
        .save(files, corpus_input(&session)?)
        .map_err(|error| error.to_string())? as u64;
    let save_corpus_ms = corpus_started.elapsed().as_secs_f64() * 1_000.0;
    let save_ms = save_started.elapsed().as_secs_f64() * 1_000.0;
    let analysis_started = Instant::now();
    let analysis = corpus.analysis(files).map_err(|error| error.to_string())?;
    let corpus_analysis_ms = analysis_started.elapsed().as_secs_f64() * 1_000.0;

    Ok(RecordedSession {
        id: recording.id.clone(),
        audio_seconds: recording.samples.len() as f64 / f64::from(rate),
        counters: RecordCounters {
            sample_rate: rate,
            audio_samples: recording.samples.len() as u64,
            segments: segments.len() as u64,
            tokens: tokens as u64,
            pauses: pauses.len() as u64,
            voice_activity: match started.status {
                VadStatus::Detected => "detected".into(),
                _ => format!("unavailable: {}", started.reason.unwrap_or_default()),
            },
            vad_chunks: recording.samples.len().div_ceil(RECORDER_CHUNK) as u64,
            vad_spans_live,
            vad_finite_runs,
            vad_silero_samples: silero_samples,
            stream: finished.work.clone(),
            stream_parity: match &finished.parity {
                StreamParity::Match { .. } => "match".into(),
                other => format!("{other:?}"),
            },
            report_events: report.events.len() as u64,
            acoustic_samples,
            saved_session_bytes: session_bytes,
            saved_session_index_bytes: index_bytes,
            saved_sessions_in_list: sessions.len() as u64,
            saved_audio_bytes: audio.len() as u64,
            saved_corpus_bytes: corpus_bytes,
            saved_corpus_sessions: analysis.stats.sessions as u64,
        },
        timings: RecordTimings {
            vad_push: Latency::of(vad_push_ms),
            stream_update: Latency::of(stream_ms),
            stop_ms,
            stop_vad_finite_ms,
            stop_stream_finish_ms,
            stop_batch_ms,
            save_ms,
            save_corpus_ms,
            corpus_analysis_ms,
        },
    })
}

/// The web view's session writes: each changed session's own value, the index of ids, and the
/// removal of dropped sessions. Returns the bytes of the session values and of the index.
fn write_sessions(
    store: &ProtectedStore,
    changed: &[&Value],
    sessions: &[Value],
    dropped: &[Value],
) -> Result<(u64, u64), String> {
    let key = |session: &Value| {
        format!(
            "{SESSION_KEY_PREFIX}{}",
            session["id"].as_str().unwrap_or_default()
        )
    };
    let mut session_bytes = 0;
    for session in changed {
        let value = serde_json::to_vec(session).map_err(|error| error.to_string())?;
        session_bytes += value.len() as u64;
        store
            .write(Namespace::Web, &key(session), &value)
            .map_err(|error| error.to_string())?;
    }
    let ids = sessions
        .iter()
        .map(|session| &session["id"])
        .collect::<Vec<_>>();
    let index = serde_json::to_vec(&ids).map_err(|error| error.to_string())?;
    store
        .write(Namespace::Web, SESSIONS_KEY, &index)
        .map_err(|error| error.to_string())?;
    for session in dropped {
        store
            .remove(Namespace::Web, &key(session))
            .map_err(|error| error.to_string())?;
    }
    Ok((session_bytes, index.len() as u64))
}

fn review(
    store: &ProtectedStore,
    files: &CorpusFiles,
    sessions: &[Value],
) -> Result<(ReviewCounters, ReviewTimings), String> {
    let mut counters = ReviewCounters::default();
    let opened = Instant::now();
    let entries = store
        .entries(Namespace::Web)
        .map_err(|error| error.to_string())?;
    counters.web_entries_unsealed = entries.len() as u64;
    counters.web_bytes_unsealed = entries.values().map(|value| value.len() as u64).sum();
    let corpus_started = Instant::now();
    let analysis = SpeechCorpus::default()
        .analysis(files)
        .map_err(|error| error.to_string())?;
    let corpus_load_ms = corpus_started.elapsed().as_secs_f64() * 1_000.0;
    counters.corpus_sessions_loaded = analysis.stats.sessions as u64;
    let app_open_ms = opened.elapsed().as_secs_f64() * 1_000.0;
    let mut audio_ms = Vec::new();
    for session in sessions {
        let id = session["id"].as_str().unwrap_or_default();
        let started = Instant::now();
        let audio = store
            .read(Namespace::Audio, id)
            .map_err(|error| error.to_string())?;
        audio_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
        if let Some(audio) = audio {
            counters.audio_opened += 1;
            counters.audio_bytes_unsealed += audio.len() as u64;
        }
    }
    Ok((
        counters,
        ReviewTimings {
            app_open_ms,
            corpus_load_ms,
            audio_open: Latency::of(audio_ms),
        },
    ))
}

fn import(
    store: &ProtectedStore,
    files: &CorpusFiles,
    sessions: &[Value],
) -> Result<(ImportCounters, ImportTimings), String> {
    let list_started = Instant::now();
    let changed = sessions.iter().collect::<Vec<_>>();
    let (session_bytes, index_bytes) = write_sessions(store, &changed, sessions, &[])?;
    let session_list_ms = list_started.elapsed().as_secs_f64() * 1_000.0;
    let corpus_started = Instant::now();
    let inputs = sessions
        .iter()
        .map(corpus_input)
        .collect::<Result<Vec<_>, _>>()?;
    SpeechCorpus::default()
        .replace(files, inputs)
        .map_err(|error| error.to_string())?;
    let corpus_ms = corpus_started.elapsed().as_secs_f64() * 1_000.0;
    let retain_started = Instant::now();
    let ids = sessions
        .iter()
        .filter_map(|session| session["id"].as_str().map(str::to_string))
        .collect();
    store
        .retain(Namespace::Audio, &ids)
        .map_err(|error| error.to_string())?;
    let retain_ms = retain_started.elapsed().as_secs_f64() * 1_000.0;
    let corpus_bytes = files
        .sessions
        .entries()
        .map_err(|error| error.to_string())?
        .values()
        .map(|entry| entry.len() as u64)
        .sum();
    Ok((
        ImportCounters {
            sessions: sessions.len() as u64,
            session_list_bytes: session_bytes + index_bytes,
            corpus_bytes,
        },
        ImportTimings {
            session_list_ms,
            corpus_ms,
            retain_ms,
        },
    ))
}

/// The work of recording one session must be proportional to that session: every token and
/// pause analyzed exactly once, each segment revisited only by its own partial-to-final
/// correction, no full rebuilds, chunk rows reading only nearby events, the acoustic batch reading
/// at most its window, and the saved session list bounded by the app's session limit.
pub fn record_violations(id: &str, counters: &RecordCounters) -> Vec<String> {
    let mut violations = Vec::new();
    let work = &counters.stream;
    let mut check = |ok: bool, message: String| {
        if !ok {
            violations.push(format!("{id}: {message}"));
        }
    };
    check(
        work.tokens_analyzed == counters.tokens,
        format!(
            "{} tokens analyzed of {}",
            work.tokens_analyzed, counters.tokens
        ),
    );
    check(
        work.segments_analyzed == counters.segments,
        format!(
            "{} final segments analyzed of {}",
            work.segments_analyzed, counters.segments
        ),
    );
    check(
        work.pauses_analyzed == counters.pauses,
        format!(
            "{} pauses analyzed of {}",
            work.pauses_analyzed, counters.pauses
        ),
    );
    check(
        work.segments_revisited == counters.segments && work.pauses_revisited == 0,
        format!(
            "{} segment and {} pause positions revisited; only each segment's partial-to-final correction may revisit",
            work.segments_revisited, work.pauses_revisited
        ),
    );
    check(
        // The first segment's partial-to-final correction before any pause arrived replaces
        // everything from position 0; anything more is a rebuild of history.
        work.full_rebuilds <= 1,
        format!("{} full rebuilds", work.full_rebuilds),
    );
    if work.report_chunks > 0 {
        // A chunk row reads the events that can reach it, so dense passages read more; reading
        // the history would grow with every event retained.
        let reads = work.chunk_event_reads as f64 / work.report_chunks as f64;
        let density = work.retained_events as f64 / work.retained_segments.max(1) as f64;
        check(
            reads < MAX_CHUNK_EVENT_READS + 2.0 * density,
            format!("{reads:.2} event reads per chunk row at {density:.2} events per segment"),
        );
    }
    check(
        // One report per changing update, plus the finalized one at Stop.
        work.reports_built == work.updates + 1,
        format!(
            "{} reports for {} changing updates and the finish",
            work.reports_built, work.updates
        ),
    );
    check(
        counters.stream_parity == "match",
        format!("live analysis parity {}", counters.stream_parity),
    );
    if counters.voice_activity == "detected" {
        // Silero sees the capture once: live, never again on Stop (vox#158).
        let one_pass = (counters.audio_samples * u64::from(VAD_SAMPLE_RATE))
            .div_ceil(u64::from(counters.sample_rate));
        check(
            counters.vad_silero_samples == one_pass,
            format!(
                "Silero analyzed {} samples for a {one_pass}-sample capture ({} finite passes)",
                counters.vad_silero_samples, counters.vad_finite_runs
            ),
        );
    }
    let window = (ACOUSTIC_WINDOW_SECONDS * f64::from(counters.sample_rate)) as u64;
    check(
        counters.acoustic_samples <= counters.audio_samples.min(window) + 1,
        format!(
            "acoustic analysis read {} samples of {} (window {window})",
            counters.acoustic_samples, counters.audio_samples
        ),
    );
    check(
        counters.saved_sessions_in_list <= MAX_SAVED_SESSIONS as u64,
        format!(
            "{} sessions in the saved list",
            counters.saved_sessions_in_list
        ),
    );
    violations
}

#[derive(Default)]
struct StreamClient {
    seq: u64,
    sent_segments: Vec<TranscriptSegmentInput>,
    sent_pauses: Vec<PauseInput>,
}

impl StreamClient {
    /// Sends what changed; returns the update's processing time when it changed the input.
    fn sync(
        &mut self,
        stream: &mut AnalysisStream,
        run_id: &str,
        segments: &[TranscriptSegmentInput],
        pauses: &[PauseInput],
    ) -> Result<Option<f64>, String> {
        let segments_from = self
            .sent_segments
            .iter()
            .zip(segments)
            .take_while(|(left, right)| same_segment(left, right))
            .count();
        let pauses_from = self
            .sent_pauses
            .iter()
            .zip(pauses)
            .take_while(|(left, right)| same_pause(left, right))
            .count();
        // The client sends nothing when nothing changed.
        if segments_from == segments.len()
            && segments_from == self.sent_segments.len()
            && pauses_from == pauses.len()
            && pauses_from == self.sent_pauses.len()
        {
            return Ok(None);
        }
        let update = stream.push(StreamPushRequest {
            run_id: run_id.to_string(),
            seq: self.seq,
            segments_from,
            segments: segments[segments_from..].to_vec(),
            pauses_from,
            pauses: pauses[pauses_from..].to_vec(),
        })?;
        self.seq += 1;
        self.sent_segments = segments.to_vec();
        self.sent_pauses = pauses.to_vec();
        Ok(update.changed.then_some(update.processing_ms))
    }
}

fn same_segment(left: &TranscriptSegmentInput, right: &TranscriptSegmentInput) -> bool {
    left.text == right.text
        && left.start_seconds.to_bits() == right.start_seconds.to_bits()
        && left.end_seconds.to_bits() == right.end_seconds.to_bits()
        && left.is_final == right.is_final
}

fn same_pause(left: &PauseInput, right: &PauseInput) -> bool {
    left.start_seconds.to_bits() == right.start_seconds.to_bits()
        && left.end_seconds.to_bits() == right.end_seconds.to_bits()
        && left.after_text == right.after_text
}

/// The recorder's pauses: RMS of each 2048-sample chunk above 0.025 is voice; more than 0.75 s
/// between voiced chunks is a pause (the same rule as the live-analysis parity harness).
pub fn recorder_pauses(
    samples: &[f32],
    rate: f64,
    segments: &[TranscriptSegmentInput],
) -> Vec<PauseInput> {
    let mut pauses = Vec::new();
    let mut last_voice = 0.0_f64;
    for (index, chunk) in samples.chunks(RECORDER_CHUNK).enumerate() {
        let energy = chunk.iter().map(|sample| sample * sample).sum::<f32>();
        let rms = (energy / chunk.len().max(1) as f32).sqrt();
        let now = (index * RECORDER_CHUNK + chunk.len()) as f64 / rate;
        if rms > 0.025 {
            if last_voice > 0.0 && now - last_voice > 0.75 {
                pauses.push(PauseInput {
                    start_seconds: last_voice,
                    end_seconds: now,
                    after_text: segments
                        .iter()
                        .rev()
                        .find(|segment| segment.end_seconds <= last_voice)
                        .map(|segment| segment.text.clone()),
                });
            }
            last_voice = now;
        }
    }
    pauses
}

fn started_at(index: usize) -> String {
    format!("2026-01-01T00:{:02}:{:02}.000Z", index / 60, index % 60)
}

fn segment_json(segment: &TranscriptSegmentInput) -> Value {
    json!({
        "text": segment.text,
        "startSeconds": segment.start_seconds,
        "endSeconds": segment.end_seconds,
        "isFinal": segment.is_final,
    })
}

fn corpus_input(session: &Value) -> Result<CorpusSessionInput, String> {
    let report = &session["report"];
    serde_json::from_value(json!({
        "id": session["id"],
        "startedAt": session["startedAt"],
        "segments": session["segments"],
        "report": {
            "totalDurationSeconds": report["totalDurationSeconds"],
            "wordCount": report["wordCount"],
            "stutterCount": report["stutterCount"],
            "stuttersPerMinute": report["stuttersPerMinute"],
        },
    }))
    .map_err(|error| error.to_string())
}

/// Kept audio as the web view encodes it: u32 header length, JSON header padded to 4 bytes,
/// little-endian f32 samples.
fn encode_audio(session_id: &str, sample_rate: u32, samples: &[f32]) -> Vec<u8> {
    let header = serde_json::to_vec(&json!({
        "sessionId": session_id,
        "sampleRate": sample_rate,
        "startOffsetSeconds": 0,
        "discontinuities": [],
        "droppedSeconds": 0,
    }))
    .expect("a JSON header serializes");
    let header_bytes = (4 + header.len()).div_ceil(4) * 4;
    let mut bytes = vec![0u8; header_bytes];
    bytes[..4].copy_from_slice(&(header.len() as u32).to_le_bytes());
    bytes[4..4 + header.len()].copy_from_slice(&header);
    bytes.reserve(samples.len() * 4);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

/// Reads a 16-bit PCM WAV file as mono f32.
pub fn read_wav(path: &Path) -> Result<(u32, Vec<f32>), String> {
    let mut reader =
        hound::WavReader::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let interleaved = reader
        .samples::<i16>()
        .map(|sample| sample.map(|value| f32::from(value) / 32_768.0))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let samples = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    Ok((spec.sample_rate, samples))
}

#[cfg(test)]
mod tests;
