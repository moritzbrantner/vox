#[cfg(test)]
mod asr_bench;
mod corpus;
mod prediction;
mod speech_analysis;
mod speech_pipeline;
#[cfg(test)]
mod speech_reference;
#[cfg(test)]
mod stutter_bench;
mod text_analysis_transcription;
pub mod transcription;

// Local compatibility names keep product code stable while the historical
// monolith package surfaces are mapped to their extracted capability owners.
mod text_analysis_features {
    pub use text_analysis_corpus::*;
}

mod video_analysis_core {
    pub use media_core::DetectError;
}

/// Capture-quality measurement of analysis audio and uploaded files, shared with the compute
/// worker.
pub mod capture {
    pub use crate::speech_analysis::{capture_metrics_impl, CaptureMetricsRequest};
    pub use crate::transcription::audio_file_capture_metrics;
}

use std::fs;
use std::path::PathBuf;

use corpus::{
    backfill_speech_corpus_capture_quality_impl, delete_speech_corpus_session_impl,
    export_speech_corpus_impl, load_speech_corpus_impl, replace_speech_corpus_sessions_impl,
    save_speech_corpus_session_impl, speech_corpus_observations_impl, CorpusSessionInput,
    SpeechCorpusAnalysis,
};
use prediction::{predict_speaker_intent_impl, SpeakerIntentPrediction, SpeakerIntentRequest};
use speech_analysis::{
    compare_voiceprint_impl, create_voiceprint_impl, AnalysisReport, AnalyzeSpeechRequest,
    SpeakerIdentificationRequest, SpeakerIdentificationResult, SpeakerProfileRequest,
    SpeakerProfileResult, VoiceMatchRequest, VoiceMatchResult, VoiceprintRequest, VoiceprintResult,
};
use tauri::{Emitter, Manager};
use transcription::{
    download_transcription_model_impl, transcribe_audio_impl, transcription_models_impl,
    DownloadTranscriptionModelRequest, TranscribeAudioRequest, TranscribeAudioResult,
    TranscriptionModelStatus, TranscriptionModelsRequest, TranscriptionModelsResult,
    TranscriptionProgressEvent,
};

#[tauri::command]
fn analyze_speech_session(request: AnalyzeSpeechRequest) -> Result<AnalysisReport, String> {
    speech_pipeline::analyze_speech_session(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_voiceprint(request: VoiceprintRequest) -> Result<VoiceprintResult, String> {
    create_voiceprint_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn compare_voiceprint(request: VoiceMatchRequest) -> Result<VoiceMatchResult, String> {
    compare_voiceprint_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_speaker_profile(request: SpeakerProfileRequest) -> Result<SpeakerProfileResult, String> {
    speech_analysis::create_speaker_profile_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn identify_speaker(
    request: SpeakerIdentificationRequest,
) -> Result<SpeakerIdentificationResult, String> {
    speech_analysis::identify_speaker_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn load_speaker_profiles(app: tauri::AppHandle) -> Result<Vec<SpeakerProfileResult>, String> {
    let path = speaker_profiles_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let speakers: Vec<SpeakerProfileResult> =
        serde_json::from_str(&content).map_err(|err| err.to_string())?;
    Ok(normalize_speaker_profiles(speakers))
}

#[tauri::command]
fn save_speaker_profiles(
    app: tauri::AppHandle,
    speakers: Vec<SpeakerProfileResult>,
) -> Result<Vec<SpeakerProfileResult>, String> {
    let path = speaker_profiles_path(&app)?;
    let speakers = normalize_speaker_profiles(speakers);
    let content = serde_json::to_string_pretty(&speakers).map_err(|err| err.to_string())?;
    fs::write(path, content).map_err(|err| err.to_string())?;
    Ok(speakers)
}

#[tauri::command]
fn load_speech_corpus(app: tauri::AppHandle) -> Result<SpeechCorpusAnalysis, String> {
    load_speech_corpus_impl(&speech_corpus_path(&app)?).map_err(|err| err.to_string())
}

#[tauri::command]
fn backfill_speech_corpus_capture_quality(
    app: tauri::AppHandle,
    qualities: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<SpeechCorpusAnalysis, String> {
    backfill_speech_corpus_capture_quality_impl(&speech_corpus_path(&app)?, &qualities)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn speech_corpus_observations(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    speech_corpus_observations_impl(&speech_corpus_path(&app)?).map_err(|err| err.to_string())
}

#[tauri::command]
fn export_speech_corpus(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    export_speech_corpus_impl(&speech_corpus_path(&app)?).map_err(|err| err.to_string())
}

#[tauri::command]
fn save_speech_corpus_session(
    app: tauri::AppHandle,
    session: CorpusSessionInput,
) -> Result<SpeechCorpusAnalysis, String> {
    save_speech_corpus_session_impl(&speech_corpus_path(&app)?, session)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_speech_corpus_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<SpeechCorpusAnalysis, String> {
    delete_speech_corpus_session_impl(&speech_corpus_path(&app)?, &session_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn replace_speech_corpus_sessions(
    app: tauri::AppHandle,
    sessions: Vec<CorpusSessionInput>,
) -> Result<SpeechCorpusAnalysis, String> {
    replace_speech_corpus_sessions_impl(&speech_corpus_path(&app)?, sessions)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn predict_speaker_intent(
    request: SpeakerIntentRequest,
) -> Result<Vec<SpeakerIntentPrediction>, String> {
    predict_speaker_intent_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn transcribe_audio(request: TranscribeAudioRequest) -> Result<TranscribeAudioResult, String> {
    transcribe_audio_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn transcription_models(
    request: TranscriptionModelsRequest,
) -> Result<TranscriptionModelsResult, String> {
    transcription_models_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn download_transcription_model(
    app: tauri::AppHandle,
    request: DownloadTranscriptionModelRequest,
) -> Result<TranscriptionModelStatus, String> {
    download_transcription_model_impl(request, |event: TranscriptionProgressEvent| {
        let _ = app.emit("transcription-progress", event);
    })
    .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            configure_media_permissions(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            analyze_speech_session,
            create_voiceprint,
            compare_voiceprint,
            create_speaker_profile,
            identify_speaker,
            load_speaker_profiles,
            save_speaker_profiles,
            load_speech_corpus,
            export_speech_corpus,
            speech_corpus_observations,
            backfill_speech_corpus_capture_quality,
            save_speech_corpus_session,
            delete_speech_corpus_session,
            replace_speech_corpus_sessions,
            predict_speaker_intent,
            transcribe_audio,
            transcription_models,
            download_transcription_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stutter Tracker");
}

#[cfg(target_os = "linux")]
fn configure_media_permissions(app: &tauri::App) {
    if let Some(webview) = app.get_webview_window("main") {
        let _ = webview.with_webview(|webview| {
            use webkit2gtk::{
                glib::object::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
                UserMediaPermissionRequestExt, WebViewExt,
            };

            let webview = webview.inner();
            if let Some(settings) = webview.settings() {
                settings.set_enable_media_stream(true);
                settings.set_enable_media(true);
            }

            webview.connect_permission_request(|_, request| {
                let Some(user_media_request) = request.downcast_ref::<UserMediaPermissionRequest>()
                else {
                    return false;
                };

                if user_media_request.is_for_audio_device() {
                    request.allow();
                    return true;
                }

                false
            });
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_media_permissions(_app: &tauri::App) {}

fn speaker_profiles_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    Ok(data_dir.join("known-speakers.json"))
}

fn speech_corpus_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    Ok(data_dir.join("speech-corpus.json"))
}

fn normalize_speaker_profiles(speakers: Vec<SpeakerProfileResult>) -> Vec<SpeakerProfileResult> {
    speakers
        .into_iter()
        .filter(|speaker| {
            !speaker.id.trim().is_empty()
                && !speaker.label.trim().is_empty()
                && !speaker.embeddings.is_empty()
        })
        .collect()
}
