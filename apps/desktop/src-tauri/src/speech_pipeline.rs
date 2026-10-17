use serde::Serialize;

use crate::speech_analysis::{
    analyze_with_repetitions, is_filler, sound_repetition, timed_tokens, AnalysisReport,
    AnalyzeSpeechRequest, EventEvidence, EventSource, SpeechAnalysisError, StutterEvent,
    StutterKind, TimedToken,
};

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

/// Why a channel has no observations. A missing channel is never evidence of absence.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
// The shared "No" prefix is the wire meaning: each variant names what is absent.
#[allow(clippy::enum_variant_names)]
pub enum MissingReason {
    NoAudio,
    NoFinalTranscript,
    /// The request carries no per-interval speaker identity.
    NoSpeakerAttribution,
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

#[derive(Debug, Clone, PartialEq)]
struct ObservationSet {
    observations: Vec<Observation>,
}

impl ObservationSet {
    fn tokens_of(&self, segment: usize) -> impl Iterator<Item = &Observation> {
        self.observations.iter().filter(move |observation| {
            matches!(observation.detail, ObservationDetail::TranscriptToken { segment: s, .. } if s == segment)
        })
    }
}

/// Product-level speech analysis: typed observations, then stuttering-specific interpretation.
///
/// Transcript repetitions are interpreted here from token observations and keep links to them;
/// the remaining stages still run in the batch detector (`speech_analysis`) and move onto this
/// path one at a time, each checked against that batch reference.
pub(crate) fn analyze_speech_session(
    request: AnalyzeSpeechRequest,
) -> Result<AnalysisReport, SpeechAnalysisError> {
    let observations = collect_observations(&request)?;
    let mut report = analyze_with_repetitions(request, |segment, _| {
        interpret_repetitions(&observations, segment)
    })?;
    let cited: Vec<&str> = report
        .events
        .iter()
        .filter_map(|event| event.evidence.as_ref())
        .flat_map(|evidence| evidence.supporting.iter().map(String::as_str))
        .collect();
    report.observations = Some(
        observations
            .observations
            .into_iter()
            .filter(|observation| {
                matches!(observation.detail, ObservationDetail::Missing { .. })
                    || cited.contains(&observation.id.as_str())
            })
            .collect(),
    );
    Ok(report)
}

fn collect_observations(
    request: &AnalyzeSpeechRequest,
) -> Result<ObservationSet, SpeechAnalysisError> {
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
        for (token_index, token) in timed_tokens(segment).into_iter().enumerate() {
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
            id: format!("pause:{index}"),
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

    let timeline_end_seconds = request
        .segments
        .iter()
        .filter(|segment| segment.is_final)
        .map(|segment| segment.end_seconds)
        .chain(request.pauses.iter().map(|pause| pause.end_seconds))
        .filter(|value| value.is_finite())
        .fold(0.0_f64, f64::max);

    match (&request.samples, request.sample_rate) {
        (Some(samples), Some(sample_rate)) if !samples.is_empty() && sample_rate > 0 => {
            observations.push(Observation {
                id: "audio:0".to_string(),
                channel: ObservationChannel::Acoustic,
                start_seconds: 0.0,
                end_seconds: samples.len() as f64 / f64::from(sample_rate),
                timing: TimingSource::Observed,
                confidence: None,
                detail: ObservationDetail::AudioWindow {
                    sample_count: samples.len(),
                    sample_rate,
                },
            });
        }
        _ => observations.push(missing(
            ObservationChannel::Acoustic,
            MissingReason::NoAudio,
            timeline_end_seconds,
        )),
    }
    if !observations
        .iter()
        .any(|observation| observation.channel == ObservationChannel::Transcript)
    {
        observations.push(missing(
            ObservationChannel::Transcript,
            MissingReason::NoFinalTranscript,
            timeline_end_seconds,
        ));
    }
    observations.push(missing(
        ObservationChannel::Speaker,
        MissingReason::NoSpeakerAttribution,
        timeline_end_seconds,
    ));
    Ok(ObservationSet { observations })
}

fn token_observation(
    segment: usize,
    token: usize,
    timed: TimedToken,
    confidence: Option<f32>,
) -> Observation {
    Observation {
        id: format!("transcript:{segment}:{token}"),
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

fn missing(channel: ObservationChannel, reason: MissingReason, end_seconds: f64) -> Observation {
    let name = match channel {
        ObservationChannel::Transcript => "transcript",
        ObservationChannel::Pause => "pause",
        ObservationChannel::Acoustic => "acoustic",
        ObservationChannel::Speaker => "speaker",
    };
    Observation {
        id: format!("missing:{name}"),
        channel,
        start_seconds: 0.0,
        end_seconds,
        timing: TimingSource::Session,
        confidence: None,
        detail: ObservationDetail::Missing { reason },
    }
}

/// Word and initial-sound repetitions within one final segment, each citing the token
/// observations it rests on. Mirrors the batch reference's transcript repetition stage.
fn interpret_repetitions(observations: &ObservationSet, segment: usize) -> Vec<StutterEvent> {
    let tokens: Vec<(&str, TimedToken)> = observations
        .tokens_of(segment)
        .map(|observation| match &observation.detail {
            ObservationDetail::TranscriptToken {
                raw, normalized, ..
            } => (
                observation.id.as_str(),
                TimedToken {
                    raw: raw.clone(),
                    normalized: normalized.clone(),
                    start_seconds: observation.start_seconds,
                    end_seconds: observation.end_seconds,
                },
            ),
            _ => unreachable!("tokens_of yields transcript tokens"),
        })
        .collect();
    let mut events = Vec::new();
    let mut index = 0;
    while index + 1 < tokens.len() {
        let token = &tokens[index].1;
        if token.normalized.is_empty() || is_filler(&token.normalized) {
            index += 1;
            continue;
        }
        let mut run_end = index + 1;
        while run_end < tokens.len() && tokens[run_end].1.normalized == token.normalized {
            run_end += 1;
        }
        if run_end - index >= 2 {
            events.push(repetition_event(
                StutterKind::WordRepetition,
                &tokens[index..run_end],
                "Repeated word sequence",
                0.86,
                format!(
                    "The same word appears {} times in a row in one final transcript segment; token times are interpolated within the segment.",
                    run_end - index
                ),
            ));
            index = run_end;
            continue;
        }
        if index + 2 < tokens.len() && sound_repetition(token, &tokens[index + 1].1) {
            events.push(repetition_event(
                StutterKind::SoundRepetition,
                &tokens[index..index + 2],
                "Repeated initial sound",
                0.74,
                "A short fragment is followed by a word starting with it in one final transcript segment; token times are interpolated within the segment.".to_string(),
            ));
            index += 2;
            continue;
        }
        index += 1;
    }
    events
}

fn repetition_event(
    kind: StutterKind,
    tokens: &[(&str, TimedToken)],
    detail: &str,
    confidence: f32,
    explanation: String,
) -> StutterEvent {
    let first = &tokens[0];
    let last = &tokens[tokens.len() - 1];
    let prefix = match kind {
        StutterKind::WordRepetition => "wordRepetition",
        _ => "soundRepetition",
    };
    StutterEvent {
        kind,
        start_seconds: first.1.start_seconds,
        end_seconds: last.1.end_seconds,
        text: tokens
            .iter()
            .map(|(_, token)| token.raw.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        detail: detail.to_string(),
        confidence,
        source: Some(EventSource::Transcript),
        acoustic_evidence: None,
        evidence: Some(EventEvidence {
            id: format!("{prefix}:{}", first.0),
            supporting: tokens.iter().map(|(id, _)| (*id).to_string()).collect(),
            explanation,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_analysis::{analyze_speech_session_impl, PauseInput, TranscriptSegmentInput};

    fn segment(text: &str, start: f64, end: f64, is_final: bool) -> TranscriptSegmentInput {
        TranscriptSegmentInput {
            text: text.to_string(),
            start_seconds: start,
            end_seconds: end,
            confidence: Some(0.9),
            speaker_score: None,
            is_final,
        }
    }

    fn request(
        segments: Vec<TranscriptSegmentInput>,
        pauses: Vec<PauseInput>,
        audio: Option<(Vec<f32>, Option<u32>)>,
    ) -> AnalyzeSpeechRequest {
        let (samples, sample_rate) = match audio {
            Some((samples, rate)) => (Some(samples), rate),
            None => (None, None),
        };
        AnalyzeSpeechRequest {
            segments,
            pauses,
            session_started_at: Some("fixture".to_string()),
            samples,
            sample_rate,
        }
    }

    fn pause(start: f64, end: f64) -> PauseInput {
        PauseInput {
            start_seconds: start,
            end_seconds: end,
            after_text: None,
        }
    }

    /// The report without what only the evidence path adds.
    fn without_evidence(report: &AnalysisReport) -> serde_json::Value {
        let mut value = serde_json::to_value(report).unwrap();
        value.as_object_mut().unwrap().remove("observations");
        for event in value["events"].as_array_mut().unwrap() {
            event.as_object_mut().unwrap().remove("evidence");
        }
        value
    }

    fn tone(seconds: f64, sample_rate: u32) -> Vec<f32> {
        (0..(seconds * f64::from(sample_rate)) as usize)
            .map(|index| {
                ((index as f32) * 0.05).sin() * if (index / 4_000) % 2 == 0 { 0.4 } else { 0.0 }
            })
            .collect()
    }

    #[test]
    fn evidence_path_matches_the_batch_reference() {
        let cases = vec![
            ("silence", request(vec![], vec![pause(0.0, 3.0)], None)),
            (
                "repetitions",
                request(
                    vec![
                        segment("I I I want to go", 0.0, 2.0, true),
                        segment("b- but the the train", 2.5, 4.0, true),
                        segment("um um so so", 4.5, 5.5, true),
                    ],
                    vec![pause(2.0, 2.5), pause(4.0, 4.5)],
                    None,
                ),
            ),
            (
                "partial and final",
                request(
                    vec![
                        segment("we we", 0.0, 1.0, false),
                        segment("we we need", 0.0, 1.5, true),
                        segment("need need", 1.5, 9.0, false),
                    ],
                    vec![],
                    None,
                ),
            ),
            (
                "transcript and audio",
                request(
                    vec![segment("go go now", 0.0, 2.0, true)],
                    vec![pause(2.0, 3.0)],
                    Some((tone(3.0, 16_000), Some(16_000))),
                ),
            ),
        ];
        for (name, case) in cases {
            let reference = analyze_speech_session_impl(case.clone()).unwrap();
            let pipeline = analyze_speech_session(case).unwrap();
            assert_eq!(
                without_evidence(&pipeline),
                without_evidence(&reference),
                "{name}"
            );
        }
    }

    #[test]
    fn invalid_timing_fails_like_the_batch_reference() {
        let case = request(vec![segment("I I", f64::NAN, 1.0, true)], vec![], None);
        assert!(analyze_speech_session_impl(case.clone()).is_err());
        assert!(analyze_speech_session(case).is_err());
        for audio in [(vec![0.1; 800], None), (vec![0.1; 800], Some(0))] {
            let case = request(vec![segment("no no", 0.0, 1.0, true)], vec![], Some(audio));
            assert!(analyze_speech_session_impl(case.clone()).is_err());
            assert!(analyze_speech_session(case).is_err());
        }
        // A non-finite partial segment is ignored by both.
        let partial = request(
            vec![
                segment("x", f64::NAN, 1.0, false),
                segment("so so", 0.0, 1.0, true),
            ],
            vec![],
            None,
        );
        assert!(analyze_speech_session(partial).is_ok());
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
        let report = analyze_speech_session(case.clone()).unwrap();
        let repetition = report
            .events
            .iter()
            .find(|event| event.kind == StutterKind::WordRepetition)
            .unwrap();
        assert_eq!(
            repetition.evidence,
            Some(EventEvidence {
                id: "wordRepetition:transcript:1:0".to_string(),
                supporting: vec![
                    "transcript:1:0".to_string(),
                    "transcript:1:1".to_string(),
                    "transcript:1:2".to_string(),
                ],
                explanation: "The same word appears 3 times in a row in one final transcript segment; token times are interpolated within the segment.".to_string(),
            })
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
        // Same input, same ids and order.
        assert_eq!(
            serde_json::to_value(analyze_speech_session(case).unwrap()).unwrap(),
            json
        );
    }

    #[test]
    fn missing_channels_are_explicit_and_never_observed_negatives() {
        let reasons = |case: AnalyzeSpeechRequest| -> Vec<(ObservationChannel, MissingReason)> {
            analyze_speech_session(case)
                .unwrap()
                .observations
                .unwrap()
                .into_iter()
                .filter_map(|observation| match observation.detail {
                    ObservationDetail::Missing { reason } => Some((observation.channel, reason)),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(
            reasons(request(
                vec![segment("partial", 0.0, 1.0, false)],
                vec![pause(1.0, 2.0)],
                None
            )),
            vec![
                (ObservationChannel::Acoustic, MissingReason::NoAudio),
                (
                    ObservationChannel::Transcript,
                    MissingReason::NoFinalTranscript
                ),
                (
                    ObservationChannel::Speaker,
                    MissingReason::NoSpeakerAttribution
                ),
            ]
        );
        assert_eq!(
            reasons(request(
                vec![segment("ok", 0.0, 1.0, true)],
                vec![],
                Some((vec![0.1; 1_600], Some(16_000)))
            )),
            vec![(
                ObservationChannel::Speaker,
                MissingReason::NoSpeakerAttribution
            )]
        );
    }
}
