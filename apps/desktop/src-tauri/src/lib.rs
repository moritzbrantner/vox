#[cfg(test)]
mod asr_bench;
mod corpus;
pub mod native_whisperx;
mod prediction;
pub mod protected_store;
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

use std::collections::BTreeMap;

use corpus::{
    backfill_speech_corpus_capture_quality_impl, delete_speech_corpus_session_impl,
    export_speech_corpus_impl, load_speech_corpus_impl, replace_speech_corpus_sessions_impl,
    save_speech_corpus_session_impl, speech_corpus_observations_impl, CorpusSessionInput,
    SpeechCorpusAnalysis,
};
use prediction::{predict_speaker_intent_impl, SpeakerIntentPrediction, SpeakerIntentRequest};
use protected_store::{
    open_local_store, Document, KeychainKeys, LocalStore, Namespace, SPEAKER_PROFILES_DOCUMENT,
    SPEECH_CORPUS_DOCUMENT,
};
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
fn load_speaker_profiles(
    storage: tauri::State<'_, AppStorage>,
) -> Result<Vec<SpeakerProfileResult>, String> {
    let document = storage.0.document(SPEAKER_PROFILES_DOCUMENT)?;
    let Some(content) = document.load().map_err(|err| err.to_string())? else {
        return Ok(Vec::new());
    };
    let speakers: Vec<SpeakerProfileResult> =
        serde_json::from_slice(&content).map_err(|err| err.to_string())?;
    Ok(normalize_speaker_profiles(speakers))
}

#[tauri::command]
fn save_speaker_profiles(
    storage: tauri::State<'_, AppStorage>,
    speakers: Vec<SpeakerProfileResult>,
) -> Result<Vec<SpeakerProfileResult>, String> {
    let document = storage.0.document(SPEAKER_PROFILES_DOCUMENT)?;
    let speakers = normalize_speaker_profiles(speakers);
    let content = serde_json::to_string_pretty(&speakers).map_err(|err| err.to_string())?;
    document
        .save(content.as_bytes())
        .map_err(|err| err.to_string())?;
    Ok(speakers)
}

/// The app's local storage, opened once at startup (see `protected_store`).
struct AppStorage(LocalStore);

/// What the web view learns about its storage when it starts.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum WebStorageOpened {
    #[serde(rename_all = "camelCase")]
    Protected {
        mechanism: &'static str,
        /// Whether the web view's local storage was already moved in.
        migrated: bool,
        entries: BTreeMap<String, String>,
    },
    Unprotected {
        reason: String,
    },
    Locked {
        reason: String,
    },
}

#[tauri::command]
fn protected_storage_open(
    storage: tauri::State<'_, AppStorage>,
) -> Result<WebStorageOpened, String> {
    Ok(match &storage.0 {
        LocalStore::Protected { store, mechanism } => {
            let entries = store
                .entries(Namespace::Web)
                .map_err(|err| err.to_string())?
                .into_iter()
                .map(|(key, value)| {
                    String::from_utf8(value)
                        .map(|value| (key, value))
                        .map_err(|err| err.to_string())
                })
                .collect::<Result<_, _>>()?;
            WebStorageOpened::Protected {
                mechanism,
                migrated: storage.0.web_migrated().map_err(|err| err.to_string())?,
                entries,
            }
        }
        LocalStore::Plain { reason, .. } => WebStorageOpened::Unprotected {
            reason: reason.clone(),
        },
        LocalStore::Locked { reason } => WebStorageOpened::Locked {
            reason: reason.clone(),
        },
    })
}

#[tauri::command]
fn protected_storage_migrate(
    storage: tauri::State<'_, AppStorage>,
    entries: BTreeMap<String, String>,
) -> Result<(), String> {
    storage.0.migrate_web(&entries)
}

#[tauri::command]
fn protected_storage_set(
    storage: tauri::State<'_, AppStorage>,
    key: String,
    value: String,
) -> Result<(), String> {
    storage
        .0
        .protected()?
        .write(Namespace::Web, &key, value.as_bytes())
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn protected_storage_remove(
    storage: tauri::State<'_, AppStorage>,
    key: String,
) -> Result<(), String> {
    storage
        .0
        .protected()?
        .remove(Namespace::Web, &key)
        .map_err(|err| err.to_string())
}

/// Kept session audio arrives as raw bytes (encoded by the web view) with the session id in a
/// header, so large captures are not inflated into JSON.
#[tauri::command]
fn protected_audio_put(
    storage: tauri::State<'_, AppStorage>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let session_id = request
        .headers()
        .get("x-vox-session")
        .and_then(|value| value.to_str().ok())
        .filter(|id| !id.is_empty())
        .ok_or("missing session id")?;
    let tauri::ipc::InvokeBody::Raw(audio) = request.body() else {
        return Err("kept audio must be sent as raw bytes".to_string());
    };
    storage
        .0
        .protected()?
        .write(Namespace::Audio, session_id, audio)
        .map_err(|err| err.to_string())
}

/// The kept audio of a session; an empty response when there is none.
#[tauri::command]
fn protected_audio_get(
    storage: tauri::State<'_, AppStorage>,
    session_id: String,
) -> Result<tauri::ipc::Response, String> {
    let audio = storage
        .0
        .protected()?
        .read(Namespace::Audio, &session_id)
        .map_err(|err| err.to_string())?;
    Ok(tauri::ipc::Response::new(audio.unwrap_or_default()))
}

#[tauri::command]
fn protected_audio_delete(
    storage: tauri::State<'_, AppStorage>,
    session_id: String,
) -> Result<(), String> {
    storage
        .0
        .protected()?
        .remove(Namespace::Audio, &session_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn protected_audio_retain(
    storage: tauri::State<'_, AppStorage>,
    session_ids: Vec<String>,
) -> Result<(), String> {
    storage
        .0
        .protected()?
        .retain(Namespace::Audio, &session_ids.into_iter().collect())
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn load_speech_corpus(
    storage: tauri::State<'_, AppStorage>,
) -> Result<SpeechCorpusAnalysis, String> {
    load_speech_corpus_impl(&storage.0.document(SPEECH_CORPUS_DOCUMENT)?)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn backfill_speech_corpus_capture_quality(
    storage: tauri::State<'_, AppStorage>,
    qualities: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<SpeechCorpusAnalysis, String> {
    backfill_speech_corpus_capture_quality_impl(
        &storage.0.document(SPEECH_CORPUS_DOCUMENT)?,
        &qualities,
    )
    .map_err(|err| err.to_string())
}

#[tauri::command]
fn speech_corpus_observations(
    storage: tauri::State<'_, AppStorage>,
) -> Result<serde_json::Value, String> {
    speech_corpus_observations_impl(&storage.0.document(SPEECH_CORPUS_DOCUMENT)?)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn export_speech_corpus(
    storage: tauri::State<'_, AppStorage>,
) -> Result<serde_json::Value, String> {
    export_speech_corpus_impl(&storage.0.document(SPEECH_CORPUS_DOCUMENT)?)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn save_speech_corpus_session(
    storage: tauri::State<'_, AppStorage>,
    session: CorpusSessionInput,
) -> Result<SpeechCorpusAnalysis, String> {
    save_speech_corpus_session_impl(&storage.0.document(SPEECH_CORPUS_DOCUMENT)?, session)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_speech_corpus_session(
    storage: tauri::State<'_, AppStorage>,
    session_id: String,
) -> Result<SpeechCorpusAnalysis, String> {
    delete_speech_corpus_session_impl(&storage.0.document(SPEECH_CORPUS_DOCUMENT)?, &session_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn replace_speech_corpus_sessions(
    storage: tauri::State<'_, AppStorage>,
    sessions: Vec<CorpusSessionInput>,
) -> Result<SpeechCorpusAnalysis, String> {
    replace_speech_corpus_sessions_impl(&storage.0.document(SPEECH_CORPUS_DOCUMENT)?, sessions)
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
            app.manage(AppStorage(open_app_storage(app)));
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
            download_transcription_model,
            protected_storage_open,
            protected_storage_migrate,
            protected_storage_set,
            protected_storage_remove,
            protected_audio_put,
            protected_audio_get,
            protected_audio_delete,
            protected_audio_retain
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

fn open_app_storage(app: &tauri::App) -> LocalStore {
    match app.path().app_data_dir() {
        Ok(data_dir) => open_local_store(&data_dir, &KeychainKeys),
        Err(err) => LocalStore::Locked {
            reason: format!("the app data directory is unknown: {err}"),
        },
    }
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
