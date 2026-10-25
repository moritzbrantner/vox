//! Product-level speech analysis: typed observations, stuttering-specific interpretation that
//! cites them, and the capabilities of this analyzer.
//!
//! Every event of the detector (`speech_analysis`) carries `evidence`: a stable id, the
//! observations supporting it, observations conflicting with it and why it was decided. The
//! report lists exactly the observations its events cite, plus one explicit observation per
//! missing channel or uncovered time range. A missing channel is never evidence of absence.
//!
//! The reports equal those of the batch detector before this path existed
//! (`speech_reference`), apart from what the path adds.

use serde::Serialize;

use crate::speech_analysis::{
    analyze_with_evidence, timed_tokens, AcousticObservations, AnalysisReport,
    AnalyzeSpeechRequest, EvidencePolicy, SpeechAnalysisError, StutterEvent, StutterKind,
    TimedToken, PRODUCT_EVIDENCE_POLICY,
};

/// Appended to the explanation of every event that rests on transcript token times.
pub(crate) const INTERPOLATED_TIMING_NOTE: &str =
    "token times are interpolated within the segment.";

/// Evidence channel an observation comes from.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ObservationChannel {
    Transcript,
    Pause,
    Acoustic,
    Speaker,
}

/// How an observation's time range was obtained. Interpolated times are estimates, never
/// measurements: token times are spread evenly over their segment until alignment exists.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TimingSource {
    Observed,
    InterpolatedWithinSegment,
    /// The observation covers the whole analyzed timeline (e.g. a missing channel).
    Session,
}

/// Why a channel, or part of the timeline, has no observations.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MissingReason {
    NoAudio,
    /// Audio was supplied but is shorter than the 250 ms acoustic analysis needs.
    AudioTooShortForAnalysis,
    /// The recording continues after the window acoustic analysis reads (its first 90 s).
    BeyondAnalyzedAudioWindow,
    NoFinalTranscript,
    /// The request carries no per-interval speaker identity or overlap detection: who spoke,
    /// and whether voices overlapped, is unknown.
    NoSpeakerAttribution,
}

/// Who a speech-activity interval belongs to. Energy VAD establishes no identity.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeakerAttribution {
    Unattributed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ObservationDetail {
    #[serde(rename_all = "camelCase")]
    TranscriptToken {
        raw: String,
        normalized: String,
        /// Index of the segment among all request segments.
        segment: usize,
        /// Index of the token among the segment's tokens.
        token: usize,
    },
    #[serde(rename_all = "camelCase")]
    Pause {
        index: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        after_text: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    AudioWindow {
        sample_count: usize,
        sample_rate: u32,
    },
    /// Energy voice activity (audio-analysis) in the analyzed audio window.
    #[serde(rename_all = "camelCase")]
    SpeechActivity {
        index: usize,
        attribution: SpeakerAttribution,
        /// Mean frame RMS of the interval.
        score: f32,
    },
    #[serde(rename_all = "camelCase")]
    Onset { index: usize, strength: f32 },
    #[serde(rename_all = "camelCase")]
    Missing { reason: MissingReason },
}

/// One product-level observation with a stable id derived from its position in the input.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub channel: ObservationChannel,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub timing: TimingSource,
    /// Recognizer confidence of the source segment, when reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(flatten)]
    pub detail: ObservationDetail,
}

pub(crate) fn token_id(segment: usize, token: usize) -> String {
    format!("transcript:{segment}:{token}")
}

pub(crate) fn pause_id(index: usize) -> String {
    format!("pause:{index}")
}

pub(crate) fn speech_id(index: usize) -> String {
    format!("acoustic:speech:{index}")
}

pub(crate) fn onset_id(index: usize) -> String {
    format!("acoustic:onset:{index}")
}

/// How completely an analyzer produces one output.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Support {
    Supported,
    /// Produced by a simpler method; not comparable with a supported output. Only the shared
    /// fallback reports it; the variant keeps the wire vocabulary complete.
    #[allow(dead_code)]
    Reduced,
    Unsupported,
}

/// One row of the cross-runtime capability matrix (`STUTTER_BENCH.md`, "Evidence contract and
/// cross-runtime capabilities"). The shared fallback reports its own rows;
/// `packages/shared/fixtures/analysis-parity.json` keeps them in step.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisCapabilities {
    pub producer: &'static str,
    /// True when an analyzer lacks outputs a richer runtime produces.
    pub reduced: bool,
    pub outputs: CapabilityOutputs,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityOutputs {
    pub word_repetition: Support,
    pub sound_repetition: Support,
    pub prolongation: Support,
    pub filler: Support,
    pub pause_block: Support,
    pub acoustic_events: Support,
    pub fusion: Support,
    pub event_evidence: Support,
    pub missing_observations: Support,
    pub capture_metrics: Support,
    pub speaker_attribution: Support,
}

pub(crate) fn native_capabilities() -> AnalysisCapabilities {
    AnalysisCapabilities {
        producer: "desktopNative",
        reduced: false,
        outputs: CapabilityOutputs {
            word_repetition: Support::Supported,
            sound_repetition: Support::Supported,
            prolongation: Support::Supported,
            filler: Support::Supported,
            pause_block: Support::Supported,
            acoustic_events: Support::Supported,
            fusion: Support::Supported,
            event_evidence: Support::Supported,
            missing_observations: Support::Supported,
            capture_metrics: Support::Supported,
            speaker_attribution: Support::Unsupported,
        },
    }
}

/// Analyzes a session and attaches the observations its events cite.
pub(crate) fn analyze_speech_session(
    request: AnalyzeSpeechRequest,
) -> Result<AnalysisReport, SpeechAnalysisError> {
    analyze_speech_session_with(request, PRODUCT_EVIDENCE_POLICY)
}

/// `analyze_speech_session` under an explicit evidence policy (the benchmark compares them).
pub(crate) fn analyze_speech_session_with(
    request: AnalyzeSpeechRequest,
    policy: EvidencePolicy,
) -> Result<AnalysisReport, SpeechAnalysisError> {
    let observations = collect_transcript_and_pause_observations(&request)?;
    let audio = audio_window(&request);
    let (mut report, acoustic) = analyze_with_evidence(request, policy)?;
    let mut observations = observations;
    observations.extend(acoustic_observations(audio, acoustic.as_ref()));
    observations.extend(missing_observations(
        &observations,
        audio,
        acoustic.as_ref(),
    ));
    annotate_conflicts(&mut report.events, &observations);

    // Withheld candidates link to their evidence too.
    let cited: Vec<&str> = report
        .events
        .iter()
        .chain(
            report
                .insufficient_evidence
                .iter()
                .map(|possible| &possible.candidate),
        )
        .filter_map(|event| event.evidence.as_ref())
        .flat_map(|evidence| evidence.supporting.iter().chain(&evidence.conflicting))
        .map(String::as_str)
        .collect();
    report.observations = Some(
        observations
            .into_iter()
            .filter(|observation| {
                matches!(observation.detail, ObservationDetail::Missing { .. })
                    || cited.contains(&observation.id.as_str())
            })
            .collect(),
    );
    report.capabilities = Some(native_capabilities());
    Ok(report)
}

fn collect_transcript_and_pause_observations(
    request: &AnalyzeSpeechRequest,
) -> Result<Vec<Observation>, SpeechAnalysisError> {
    let mut observations = Vec::new();
    for (index, segment) in request.segments.iter().enumerate() {
        if !segment.is_final {
            // Partial results are provisional and are replaced by their final segment.
            continue;
        }
        if !segment.start_seconds.is_finite() || !segment.end_seconds.is_finite() {
            return Err(SpeechAnalysisError::Invalid(
                "segment times must be finite".to_string(),
            ));
        }
        for (token_index, token) in timed_tokens(index, segment).into_iter().enumerate() {
            observations.push(token_observation(
                index,
                token_index,
                token,
                segment.confidence,
            ));
        }
    }
    for (index, pause) in request.pauses.iter().enumerate() {
        if !pause.start_seconds.is_finite() || !pause.end_seconds.is_finite() {
            continue;
        }
        observations.push(Observation {
            id: pause_id(index),
            channel: ObservationChannel::Pause,
            start_seconds: pause.start_seconds,
            end_seconds: pause.end_seconds,
            timing: TimingSource::Observed,
            confidence: None,
            detail: ObservationDetail::Pause {
                index,
                after_text: pause.after_text.clone(),
            },
        });
    }
    Ok(observations)
}

/// Sample count and rate of usable request audio.
fn audio_window(request: &AnalyzeSpeechRequest) -> Option<(usize, u32)> {
    match (&request.samples, request.sample_rate) {
        (Some(samples), Some(sample_rate)) if !samples.is_empty() && sample_rate > 0 => {
            Some((samples.len(), sample_rate))
        }
        _ => None,
    }
}

fn acoustic_observations(
    audio: Option<(usize, u32)>,
    acoustic: Option<&AcousticObservations>,
) -> Vec<Observation> {
    let mut observations = Vec::new();
    if let Some((sample_count, sample_rate)) = audio {
        observations.push(Observation {
            id: "audio:0".to_string(),
            channel: ObservationChannel::Acoustic,
            start_seconds: 0.0,
            end_seconds: sample_count as f64 / f64::from(sample_rate),
            timing: TimingSource::Observed,
            confidence: None,
            detail: ObservationDetail::AudioWindow {
                sample_count,
                sample_rate,
            },
        });
    }
    let Some(acoustic) = acoustic else {
        return observations;
    };
    for (index, span) in acoustic.speech_spans.iter().enumerate() {
        observations.push(Observation {
            id: speech_id(index),
            channel: ObservationChannel::Acoustic,
            start_seconds: span.start_seconds,
            end_seconds: span.end_seconds,
            timing: TimingSource::Observed,
            confidence: None,
            detail: ObservationDetail::SpeechActivity {
                index,
                attribution: SpeakerAttribution::Unattributed,
                score: span.score,
            },
        });
    }
    for (index, onset) in acoustic.onsets.iter().enumerate() {
        observations.push(Observation {
            id: onset_id(index),
            channel: ObservationChannel::Acoustic,
            start_seconds: onset.seconds,
            end_seconds: onset.seconds,
            timing: TimingSource::Observed,
            confidence: None,
            detail: ObservationDetail::Onset {
                index,
                strength: onset.strength,
            },
        });
    }
    observations
}

/// One explicit observation per missing channel or time range the analysis did not cover.
fn missing_observations(
    observations: &[Observation],
    audio: Option<(usize, u32)>,
    acoustic: Option<&AcousticObservations>,
) -> Vec<Observation> {
    let timeline_end_seconds = observations
        .iter()
        .map(|observation| observation.end_seconds)
        .filter(|value| value.is_finite())
        .fold(0.0_f64, f64::max);
    let mut missing = Vec::new();
    match (audio, acoustic) {
        (None, _) => missing.push(missing_observation(
            "missing:acoustic",
            ObservationChannel::Acoustic,
            MissingReason::NoAudio,
            0.0,
            timeline_end_seconds,
        )),
        (Some(_), None) => missing.push(missing_observation(
            "missing:acoustic",
            ObservationChannel::Acoustic,
            MissingReason::AudioTooShortForAnalysis,
            0.0,
            timeline_end_seconds,
        )),
        (Some((sample_count, sample_rate)), Some(acoustic)) => {
            let audio_end = sample_count as f64 / f64::from(sample_rate);
            // Resampling may shift the analyzed length by a sample.
            if audio_end - acoustic.analyzed_seconds > 0.01 {
                missing.push(Observation {
                    timing: TimingSource::Observed,
                    ..missing_observation(
                        "missing:acoustic:afterWindow",
                        ObservationChannel::Acoustic,
                        MissingReason::BeyondAnalyzedAudioWindow,
                        acoustic.analyzed_seconds,
                        audio_end,
                    )
                });
            }
        }
    }
    if !observations
        .iter()
        .any(|observation| observation.channel == ObservationChannel::Transcript)
    {
        missing.push(missing_observation(
            "missing:transcript",
            ObservationChannel::Transcript,
            MissingReason::NoFinalTranscript,
            0.0,
            timeline_end_seconds,
        ));
    }
    missing.push(missing_observation(
        "missing:speaker",
        ObservationChannel::Speaker,
        MissingReason::NoSpeakerAttribution,
        0.0,
        timeline_end_seconds,
    ));
    missing
}

fn token_observation(
    segment: usize,
    token: usize,
    timed: TimedToken,
    confidence: Option<f32>,
) -> Observation {
    Observation {
        id: timed.id,
        channel: ObservationChannel::Transcript,
        start_seconds: timed.start_seconds,
        end_seconds: timed.end_seconds,
        timing: TimingSource::InterpolatedWithinSegment,
        confidence,
        detail: ObservationDetail::TranscriptToken {
            raw: timed.raw,
            normalized: timed.normalized,
            segment,
            token,
        },
    }
}

fn missing_observation(
    id: &str,
    channel: ObservationChannel,
    reason: MissingReason,
    start_seconds: f64,
    end_seconds: f64,
) -> Observation {
    Observation {
        id: id.to_string(),
        channel,
        start_seconds,
        end_seconds,
        timing: TimingSource::Session,
        confidence: None,
        detail: ObservationDetail::Missing { reason },
    }
}

/// Speech activity of at least 0.1 s inside a block conflicts with it: someone spoke during the
/// silence it reports. The block is kept, as the detector decided it; the conflict is recorded so
/// a reader can weigh it. Without analyzed audio there is nothing to conflict with, which is not
/// a confirmation either: the missing acoustic observation says so.
fn annotate_conflicts(events: &mut [StutterEvent], observations: &[Observation]) {
    for event in events
        .iter_mut()
        .filter(|event| event.kind == StutterKind::Block)
    {
        let Some(evidence) = event.evidence.as_mut() else {
            continue;
        };
        let mut overlap_seconds = 0.0;
        for observation in observations {
            if !matches!(observation.detail, ObservationDetail::SpeechActivity { .. }) {
                continue;
            }
            let overlap = event.end_seconds.min(observation.end_seconds)
                - event.start_seconds.max(observation.start_seconds);
            if overlap >= 0.1 {
                overlap_seconds += overlap;
                evidence.conflicting.push(observation.id.clone());
            }
        }
        if !evidence.conflicting.is_empty() {
            evidence.explanation = format!(
                "{} Speech activity was observed during {overlap_seconds:.2} s of it.",
                evidence.explanation
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_analysis::EventEvidence;
    use crate::speech_reference::{cases, pause, request, segment, sine};

    fn report(case: AnalyzeSpeechRequest) -> AnalysisReport {
        analyze_speech_session(case).unwrap()
    }

    fn evidence_of(report: &AnalysisReport) -> Vec<&EventEvidence> {
        report
            .events
            .iter()
            .map(|event| {
                event
                    .evidence
                    .as_ref()
                    .expect("every event carries evidence")
            })
            .collect()
    }

    #[test]
    fn every_event_cites_listed_observations_with_unique_ids() {
        for (name, case) in cases() {
            let Ok(report) = analyze_speech_session(case) else {
                continue;
            };
            let listed: Vec<&str> = report
                .observations
                .as_ref()
                .unwrap()
                .iter()
                .map(|observation| observation.id.as_str())
                .collect();
            let mut unique = listed.clone();
            unique.sort_unstable();
            unique.dedup();
            assert_eq!(
                unique.len(),
                listed.len(),
                "{name}: duplicate observation ids"
            );
            let evidence = evidence_of(&report);
            let mut ids: Vec<&str> = evidence.iter().map(|item| item.id.as_str()).collect();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), evidence.len(), "{name}: duplicate event ids");
            for item in evidence {
                for cited in item.supporting.iter().chain(&item.conflicting) {
                    assert!(
                        listed.contains(&cited.as_str()),
                        "{name}: {cited} not listed"
                    );
                }
            }
            assert_eq!(report.capabilities, Some(native_capabilities()));
        }
    }

    #[test]
    fn same_input_gives_the_same_serialized_report() {
        for (name, case) in cases() {
            let Ok(first) = analyze_speech_session(case.clone()) else {
                continue;
            };
            assert_eq!(
                serde_json::to_value(first).unwrap(),
                serde_json::to_value(report(case)).unwrap(),
                "{name}"
            );
        }
    }

    #[test]
    fn repetition_events_cite_their_token_observations_with_stable_ids() {
        let case = request(
            vec![
                segment("hello", 0.0, 0.5, true),
                segment("I I I want", 1.0, 3.0, true),
            ],
            vec![],
            None,
        );
        let report = report(case);
        assert_eq!(
            evidence_of(&report),
            vec![&EventEvidence {
                id: "wordRepetition:transcript:1:0".to_string(),
                supporting: vec![
                    "transcript:1:0".to_string(),
                    "transcript:1:1".to_string(),
                    "transcript:1:2".to_string(),
                ],
                conflicting: vec![],
                explanation: "The same word appears 3 times in a row in one final transcript segment; token times are interpolated within the segment.".to_string(),
            }]
        );
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(
            json["observations"][0],
            serde_json::json!({
                "id": "transcript:1:0",
                "channel": "transcript",
                "startSeconds": 1.0,
                "endSeconds": 1.5,
                "timing": "interpolatedWithinSegment",
                "confidence": 0.8999999761581421,
                "type": "transcriptToken",
                "raw": "I",
                "normalized": "i",
                "segment": 1,
                "token": 0,
            })
        );
        // Only cited tokens are kept; "hello" and "want" are not.
        let ids: Vec<&str> = json["observations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|observation| observation["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec![
                "transcript:1:0",
                "transcript:1:1",
                "transcript:1:2",
                "missing:acoustic",
                "missing:speaker",
            ]
        );
        assert_eq!(
            json["capabilities"]["outputs"]["speakerAttribution"],
            "unsupported"
        );
    }

    #[test]
    fn every_stage_names_its_evidence() {
        let ids = |case| {
            evidence_of(&report(case))
                .into_iter()
                .map(|evidence| (evidence.id.clone(), evidence.supporting.clone()))
                .collect::<Vec<_>>()
        };
        let strings = |values: &[&str]| values.iter().map(|value| value.to_string()).collect();
        assert_eq!(
            ids(request(
                vec![segment("w-w-what a sssssstart uh", 0.0, 2.0, true)],
                vec![pause(2.0, 3.0)],
                None
            )),
            vec![
                (
                    "hyphenatedSoundRepetition:transcript:0:0".to_string(),
                    strings(&["transcript:0:0"])
                ),
                (
                    "prolongation:transcript:0:2".to_string(),
                    strings(&["transcript:0:2"])
                ),
                (
                    "filler:transcript:0:3".to_string(),
                    strings(&["transcript:0:3"])
                ),
                ("block:pause:0".to_string(), strings(&["pause:0"])),
            ]
        );

        let rate = 16_000;
        let fused = report(request(
            vec![segment("ssssstart", 0.0, 0.9, true)],
            vec![],
            Some((sine(180.0, rate, 0.9), Some(rate))),
        ));
        let evidence = evidence_of(&fused);
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].id, "prolongation:transcript:0:0");
        assert_eq!(evidence[0].supporting[0], "transcript:0:0");
        assert_eq!(evidence[0].supporting[1], "acoustic:speech:0");
        assert!(evidence[0].explanation.contains(
            "Fused with the overlapping acoustic candidate prolongation:acoustic:speech:0"
        ));
        let speech = fused
            .observations
            .unwrap()
            .into_iter()
            .find(|observation| observation.id == "acoustic:speech:0")
            .unwrap();
        assert_eq!(
            speech.detail,
            ObservationDetail::SpeechActivity {
                index: 0,
                attribution: SpeakerAttribution::Unattributed,
                score: match speech.detail {
                    ObservationDetail::SpeechActivity { score, .. } => score,
                    _ => unreachable!(),
                },
            }
        );
    }

    #[test]
    fn speech_inside_a_reported_block_is_a_conflict() {
        let rate = 16_000;
        let report = report(request(
            vec![segment("so", 0.0, 0.4, true)],
            vec![pause(0.4, 1.6)],
            Some((sine(200.0, rate, 2.0), Some(rate))),
        ));
        let block = report
            .events
            .iter()
            .find(|event| event.kind == StutterKind::Block)
            .unwrap()
            .evidence
            .as_ref()
            .unwrap();
        assert_eq!(block.supporting, vec!["pause:0".to_string()]);
        assert_eq!(block.conflicting, vec!["acoustic:speech:0".to_string()]);
        assert!(block
            .explanation
            .ends_with("Speech activity was observed during 1.20 s of it."));

        // Without audio, the same block has no conflict, and the acoustic channel says why.
        let without_audio = analyze_speech_session(request(
            vec![segment("so", 0.0, 0.4, true)],
            vec![pause(0.4, 1.6)],
            None,
        ))
        .unwrap();
        assert!(evidence_of(&without_audio)[0].conflicting.is_empty());
        assert!(without_audio
            .observations
            .unwrap()
            .iter()
            .any(|observation| observation.detail
                == ObservationDetail::Missing {
                    reason: MissingReason::NoAudio
                }));
    }

    #[test]
    fn missing_channels_are_explicit_and_never_observed_negatives() {
        let reasons = |case: AnalyzeSpeechRequest| -> Vec<(String, MissingReason, f64, f64)> {
            report(case)
                .observations
                .unwrap()
                .into_iter()
                .filter_map(|observation| match observation.detail {
                    ObservationDetail::Missing { reason } => Some((
                        observation.id,
                        reason,
                        observation.start_seconds,
                        observation.end_seconds,
                    )),
                    _ => None,
                })
                .collect()
        };
        let missing = |id: &str, reason, start, end| (id.to_string(), reason, start, end);
        assert_eq!(
            reasons(request(
                vec![segment("partial", 0.0, 1.0, false)],
                vec![pause(1.0, 2.0)],
                None
            )),
            vec![
                missing("missing:acoustic", MissingReason::NoAudio, 0.0, 2.0),
                missing(
                    "missing:transcript",
                    MissingReason::NoFinalTranscript,
                    0.0,
                    2.0
                ),
                missing(
                    "missing:speaker",
                    MissingReason::NoSpeakerAttribution,
                    0.0,
                    2.0
                ),
            ]
        );
        assert_eq!(
            reasons(request(
                vec![segment("ok", 0.0, 1.0, true)],
                vec![],
                Some((vec![0.1; 800], Some(16_000)))
            )),
            vec![
                missing(
                    "missing:acoustic",
                    MissingReason::AudioTooShortForAnalysis,
                    0.0,
                    1.0
                ),
                missing(
                    "missing:speaker",
                    MissingReason::NoSpeakerAttribution,
                    0.0,
                    1.0
                ),
            ]
        );
        let long = reasons(request(
            vec![segment("late late words", 91.0, 92.0, true)],
            vec![],
            Some((vec![0.0; 4_000 * 92], Some(4_000))),
        ));
        assert_eq!(long[0].0, "missing:acoustic:afterWindow");
        assert_eq!(long[0].1, MissingReason::BeyondAnalyzedAudioWindow);
        assert!((long[0].2 - 90.0).abs() < 1e-6 && (long[0].3 - 92.0).abs() < 1e-9);
    }
}
