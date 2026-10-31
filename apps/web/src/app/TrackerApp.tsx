import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AnalyzedSpeech,
  createComputeClient,
  ON_DEVICE_ANALYZER,
  processingPolicyForServerUrl,
} from "@stutter-tracker/compute-client";
import {
  type AnalysisRunIdentity,
  type AnalyzerIdentity,
  canonicalSpokenLanguage,
  createSessionRecord,
  isAnalysisVerified,
  isReplayable,
  adjudicationRevision,
  type AnnotationRater,
  annotateSession,
  currentRevisionBy,
  type AnnotationExchange,
  decodeSamples,
  declareValidation,
  readableTranscript,
  verbatimTranscript,
  tagSessionContext,
  mergeAnnotationExchange,
  parseAnnotationExchange,
  reviewCopyFromExchange,
  reanalyzeSession,
  fallbackAnalyze as sharedFallbackAnalyze,
  type ModelPreparationFailure,
  modelPreparationFailure,
  type TranscriptionModelIdentity,
  uncheckedModelStatuses,
  observationFingerprint,
  UNKNOWN_INPUT_ID,
  audioFingerprint,
  type RecordingDescriptor,
  resampleSamples as sharedResampleSamples,
  applyLiveTranscriptUpdate,
  isUnitFinal,
  type LiveTranscript,
  type LiveTranscriptUpdate,
  liveTranscriptPartialText,
  liveTranscriptSegments,
  markUnalignedTiming,
  REFERENCE_TRANSCRIPT_MODEL,
  referenceTranscriptApplies,
  reviseTranscript,
  startLiveTranscript,
  type TranscriptCompute,
  type TranscriptionDevicePreference,
  type TranscriptPreprocessing,
  type TranscriptProvenance,
  transcriptProvenance,
  UNKNOWN_SPOKEN_LANGUAGE,
} from "@stutter-tracker/shared";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { createGapTracker } from "../audio/captureGaps";
import { measureCaptureOnDevice, preloadCaptureKernel } from "../audio/captureKernel";
import { isScoreWithheld, withCaptureQuality } from "../audio/captureQuality";
import { type AnnotationSaveRequest, AnnotationWorkbench } from "../components/AnnotationWorkbench";
import { BlindReview } from "../components/BlindReview";
import { type AdjudicationRequest, ValidationPanel } from "../components/ValidationPanel";
import { type ContextTags, SessionComparisonPanel } from "../components/SessionComparisonPanel";
import { AnnotationExchangePanel } from "../components/AnnotationExchangePanel";
import { buttonClass } from "../components/styles";
import { DashboardHeader } from "../components/DashboardHeader";
import {
  deleteSessionAudio,
  clockSecondsAt,
  getSessionAudio,
  type KeptSessionAudio,
  putSessionAudio,
  retainSessionAudio,
} from "../storage/sessionAudio";
import { EvidenceExportPanel } from "../components/EvidenceExportPanel";
import { ExportBackupDialog } from "../components/ExportBackupDialog";
import { InsightsSidebar } from "../components/InsightsSidebar";
import { InterruptedCaptureNotice } from "../components/InterruptedCaptureNotice";
import { LowerDashboard } from "../components/LowerDashboard";
import { RecordingWorkspace } from "../components/RecordingWorkspace";
import { TranscriptRevisionsPanel } from "../components/TranscriptRevisionsPanel";
import { StatusMetrics } from "../components/StatusMetrics";
import {
  BrowserRecorderError,
  createBrowserRecorder,
  type BrowserRecorder,
} from "../audio/browserRecorder";
import { planAvailableChunks } from "../recording/chunks";
import type {
  AnalysisReport,
  BlockerStats,
  PauseSpan,
  SavedSession,
  SpeakerIdentification,
  SpeakerIntentPrediction,
  SpeakerMatch,
  SpeakerProfile,
  StutterEvent,
  SpeechCorpusAnalysis,
  SpeechStats,
  TranscriptSegment,
  TranscriptionChunkRecord,
  TranscriptionChunkStats,
  TranscriptionChunkSummary,
  TranscriptionEngine,
  TranscriptionEngineId,
  TranscriptionModelStatus,
  TranscriptionProgressEvent,
  TranscriptionSettings,
  Voiceprint,
} from "../types";
import {
  loadRemoteConsent,
  loadSessionsFromStorage,
  loadSoloSpeakerDeclaration,
  replaceStoredSessions,
  saveRemoteConsent,
  saveSoloSpeakerDeclaration,
} from "../storage/localStorage";
import {
  CAPTURE_CHECKPOINT_PREFIX,
  type CaptureCheckpoint,
  type InterruptedCapture,
  captureCheckpointKey,
  claimCapture,
  hasCheckpointedObservation,
  heldCaptureIds,
  listCaptureCheckpoints,
  readCaptureCheckpoint,
  removeCaptureCheckpoint,
  writeCaptureCheckpoint,
} from "../storage/captureCheckpoint";
import { encryptBackup } from "../storage/encryptedBackup";
import { createSessionMutationQueue } from "../storage/sessionMutations";
export { formatTime } from "../utils/formatting";

const STORE_KEY = "stutter-tracker:sessions";
const VOICE_KEY = "stutter-tracker:voiceprint";
const SPEAKERS_KEY = "stutter-tracker:speakers";
/** How long speaker removal waits for the startup load before it is enabled anyway. */
const SPEAKER_LOAD_GRACE_MS = 5_000;
const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
const LANGUAGES = ["en-US", "de-DE", "en-GB"];
const COMPUTE_SERVER_URL = import.meta.env.VITE_STUTTER_SERVER_URL ?? "http://127.0.0.1:8787";
const TRANSCRIPTION_CHUNK_SECONDS = 8;
/** Upper bound for browser recognition to deliver its final results after Stop. */
const RECOGNITION_END_TIMEOUT_MS = 3_000;
const TRANSCRIPTION_TARGET_SAMPLE_RATE = 16_000;
/** whisper's own window: a post-session reference transcript is sent in chunks of this length. */
const REFERENCE_CHUNK_SECONDS = 30;
const TRANSCRIPTION_ENGINES: TranscriptionEngine[] = [
  {
    id: "browser",
    label: "Browser Speech",
    mode: "Live",
    nativeOnly: false,
    models: ["default"],
  },
  {
    id: "whisperCpp",
    label: "whisper.cpp",
    mode: "Chunked",
    nativeOnly: true,
    models: [
      "tiny.en",
      "tiny",
      "base.en",
      "base",
      "small.en",
      "small",
      "medium.en",
      "medium",
      "large-v3",
      "large-v3-turbo",
    ],
  },
  {
    id: "whisperCli",
    label: "Whisper CLI",
    mode: "Chunked",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large", "turbo"],
  },
  {
    id: "fasterWhisper",
    label: "Faster-Whisper",
    mode: "Chunked",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large-v3", "distil-large-v3"],
  },
];
const COMPUTE_API_TOKEN = import.meta.env.VITE_STUTTER_API_TOKEN ?? "";
const CONSENT_SERVER_URL = COMPUTE_SERVER_URL.trim().replace(/\/+$/, "");
// The destination is fixed for the page lifetime; consent changes reload the page so an
// in-flight run can never switch destinations.
const computeClient = createComputeClient({
  processingPolicy: processingPolicyForServerUrl(
    COMPUTE_SERVER_URL,
    loadRemoteConsent(CONSENT_SERVER_URL),
  ),
  apiToken: COMPUTE_API_TOKEN,
});

export function App() {
  const queryClient = useQueryClient();
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [pauses, setPauses] = useState<PauseSpan[]>([]);
  const [report, setReport] = useState<AnalysisReport>(() => emptyReport());
  // Identity of the analysis run that produced `report`; null when nothing has analyzed it.
  const [reportRun, setReportRun] = useState<AnalysisRunIdentity | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSessions());
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>(() => loadSpeakerProfiles());
  // Captures that were not saved when a window last closed (or that the workspace set aside), until
  // the user recovers or discards them. Filled once startup knows which captures live windows own.
  const [interruptedCaptures, setInterruptedCaptures] = useState<InterruptedCapture[]>([]);
  // Set while checkpointing the unsaved capture fails, so an interruption would lose it.
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  // Set when this window could not take ownership of its capture.
  const [claimError, setClaimError] = useState<string | null>(null);
  // Id of the unsaved capture in the workspace; null when the workspace holds no unsaved capture.
  const captureIdRef = useRef<string | null>(null);
  // Releases this window's claim on the workspace capture.
  const releaseCaptureRef = useRef<(() => void) | null>(null);
  // Set while recovery waits for ownership of a capture; other workspace changes wait for it.
  const workspaceClaimPendingRef = useRef(false);
  // Set while a recording start waits for the model or the microphone.
  const startPendingRef = useRef(false);
  // The workspace capture as last checkpointed successfully, so setting it aside can tell whether
  // the stored copy is current.
  const checkpointedRef = useRef<{ state: string; checkpoint: CaptureCheckpoint | null } | null>(
    null,
  );
  const [failedSpeakerDeletions, setFailedSpeakerDeletions] = useState<SpeakerProfile[]>([]);
  const [pendingSpeakerDeletionIds, setPendingSpeakerDeletionIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Removal waits for the startup load, which could otherwise restore or re-upload a removed
  // voiceprint from its earlier snapshot.
  const [speakersReady, setSpeakersReady] = useState(false);
  // Counts removals, so a slow startup load can tell its snapshot is stale.
  const speakerRemovalsRef = useRef(0);
  const speakerEnrollmentsRef = useRef(0);
  const removedSpeakerIdsRef = useRef(new Set<string>());
  const reloadSpeakersRef = useRef<(() => void) | null>(null);
  const speakerMutationTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const [corpusAnalysis, setCorpusAnalysis] = useState<SpeechCorpusAnalysis>(() =>
    emptyCorpusAnalysis(),
  );
  const [transcription, setTranscription] = useState<TranscriptionSettings>(() =>
    loadTranscriptionSettings(),
  );
  // Backend and device of the latest whisper.cpp-engine transcription, for diagnostics (vox#139).
  const [lastCompute, setLastCompute] = useState<TranscriptCompute | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<TranscriptionProgressEvent | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [modelPreparationFailures, setModelPreparationFailures] = useState<
    Record<string, ModelPreparationFailure>
  >({});
  // The engine and model that produced the workspace transcript; null when unknown.
  const transcriptModelRef = useRef<TranscriptionModelIdentity | null>(null);
  // Model, language and preprocessing of the workspace transcript (vox#26); null when unknown.
  const transcriptProvenanceRef = useRef<TranscriptProvenance | null>(null);
  // Partial-to-final identity of the live transcript, bound to one recording run (vox#26).
  const liveTranscriptRef = useRef<LiveTranscript>(startLiveTranscript("none"));
  // Session ids whose reference transcript is being made.
  const [referencePendingIds, setReferencePendingIds] = useState<string[]>([]);
  const referencePendingRef = useRef(new Set<string>());
  const [chunkStats, setChunkStats] = useState<TranscriptionChunkStats>(() => emptyChunkStats());
  const [transcriptionChunks, setTranscriptionChunks] = useState<TranscriptionChunkRecord[]>([]);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isFinishingCapture, setIsFinishingCapture] = useState(false);
  // Bumped when a capture finishes, so the final audio (which can grow after the last transcript
  // update) gets its own analysis before the session can be saved.
  const [captureRevision, setCaptureRevision] = useState(0);
  const [isNative, setIsNative] = useState(() => isDesktopApp());
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [isMatchingVoice, setIsMatchingVoice] = useState(false);
  const [language, setLanguage] = useState(LANGUAGES[0]);
  const [speakerLabel, setSpeakerLabel] = useState("");
  const [interimText, setInterimText] = useState("");
  const [level, setLevel] = useState(0);
  const [speakerMatch, setSpeakerMatch] = useState<SpeakerMatch | null>(null);
  const [message, setMessage] = useState("Idle");

  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef<string | null>(null);
  // Saves, deletes and restores run one at a time across every window of the app.
  const [sessionMutationQueue] = useState(() => createSessionMutationQueue());
  // True while a restore is running; saves wait for it (their browser write would race the restore).
  const restorePendingRef = useRef(0);
  const newSessionSavePendingRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const browserRecorderRef = useRef<BrowserRecorder | null>(null);
  const startedAtRef = useRef<Date | null>(null);
  const lastFinalEndRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const lastSpeakerMatchAtRef = useRef(0);
  const sampleRateRef = useRef(48_000);
  const samplesRef = useRef<number[]>([]);
  // Samples recorded for the whole capture; the browser engine keeps only the last 90 s in
  // samplesRef, and analysis is sent at most that window.
  const capturedSampleCountRef = useRef(0);
  // Describes the capture whose PCM is in samplesRef; cleared together with it.
  const captureDescriptorRef = useRef<RecordingDescriptor | null>(null);
  // Records the live capture's intervals without samples into its descriptor.
  const gapTrackerRef = useRef<ReturnType<typeof createGapTracker> | null>(null);
  const [soloSpeaker, setSoloSpeakerState] = useState(loadSoloSpeakerDeclaration);
  // Read when the microphone is acquired, so a change while Record is pending still applies.
  const soloSpeakerRef = useRef(soloSpeaker);
  const setSoloSpeaker = (declared: boolean) => {
    soloSpeakerRef.current = declared;
    setSoloSpeakerState(declared);
    saveSoloSpeakerDeclaration(declared);
  };
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const pausesRef = useRef<PauseSpan[]>([]);
  const speakersRef = useRef<SpeakerProfile[]>(speakers);
  const speakerMatchRef = useRef<SpeakerMatch | null>(speakerMatch);
  const speakerMatchInFlightRef = useRef(false);
  const transcriptionRef = useRef(transcription);
  const recordingTranscriptionRef = useRef<TranscriptionSettings | null>(null);
  // Bound when a recording starts; a later selection never redirects that run's transcription.
  const recordingLanguageRef = useRef(language);
  // Language of the session in the workspace, fixed when recording starts or a session loads; the
  // selector can change before Save without relabelling the finished recording.
  const sessionLanguageRef = useRef<string | null>(null);
  // The saved record shown in the workspace, so saving it again keeps its analysis history.
  const loadedSessionRef = useRef<SavedSession | null>(null);
  // The saved session shown in the workspace. While one is shown, the view keeps its stored
  // analysis: live analysis does not run, and a late result never replaces it. The ref is set
  // synchronously so a result that lands before React applies the load is still ignored.
  const [viewedSession, setViewedSessionState] = useState<SavedSession | null>(null);
  // Audio the user kept with the viewed session (vox#23), loaded from this device's storage.
  const [viewedAudio, setViewedAudio] = useState<KeptSessionAudio | null>(null);
  const [keepAudio, setKeepAudio] = useState(false);
  // Blind review (vox#23): only the workbench of a neutrally named session is shown.
  const [blindReview, setBlindReview] = useState<{ sessionId: string | null } | null>(null);
  const reanalyzingRef = useRef(new Set<string>());
  const [reanalyzingSessionIds, setReanalyzingSessionIds] = useState<string[]>([]);
  const viewedSessionRef = useRef<SavedSession | null>(null);
  // Bumped by every change of what the workspace shows or captures, so queued work can tell whether
  // the user touched it meanwhile, even when it ends up back where it was.
  const workspaceGenerationRef = useRef(0);
  const setViewedSession = (session: SavedSession | null) => {
    workspaceGenerationRef.current += 1;
    viewedSessionRef.current = session;
    setViewedSessionState(session);
  };
  const viewedSessionId = blindReview ? blindReview.sessionId : (viewedSession?.id ?? null);
  useEffect(() => {
    setViewedAudio(null);
    if (!viewedSessionId) return;
    let current = true;
    getSessionAudio(viewedSessionId).then(
      (audio) => {
        if (current && audio) setViewedAudio((shown) => shown ?? audio);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [viewedSessionId]);
  // Kept audio whose session is gone (deleted, dropped past the session limit, or an earlier
  // removal failed) is removed on start.
  useEffect(() => {
    void serializeSessionMutation(() =>
      retainSessionAudio(sessionsRef.current.map((session) => session.id)),
    ).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const nextChunkStartSampleRef = useRef(0);
  const chunkIndexRef = useRef(0);
  const chunkTranscriptionTailRef = useRef<Promise<void>>(Promise.resolve());
  const queuedTranscriptionTasksRef = useRef(0);
  const transcriptionRunIdRef = useRef(0);
  const chunkResultsRef = useRef({ completed: 0, failed: 0 });
  const modelDownloadKeyRef = useRef<string | null>(null);
  const modelDownloadPromiseRef = useRef<Promise<boolean> | null>(null);

  const analysisRequest = useMemo(() => {
    const audio = analysisAudioPayload(samplesRef.current, sampleRateRef.current);
    return {
      segments,
      pauses,
      sessionStartedAt: startedAtRef.current?.toISOString(),
      ...audio,
    };
    // captureRevision is a deliberate trigger: samplesRef is a ref and not a dependency itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, pauses, captureRevision]);
  // Read with the observation above, so the quality gate describes the capture analyzed (also a
  // recovered one whose audio is gone). It stays on this device: analysis requests never carry it.
  const analysisDescriptor = useMemo(() => captureDescriptorRef.current, [analysisRequest]);
  const analysisCaptureSeconds = useMemo(
    () =>
      sampleRateRef.current > 0
        ? Math.max(capturedSampleCountRef.current, samplesRef.current.length) /
          sampleRateRef.current
        : 0,
    // Read with the observation above, like the descriptor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analysisRequest],
  );

  const analysisQuery = useQuery({
    // Gaps are appended to the descriptor during capture; a new gap must re-gate the report.
    queryKey: [
      "analysis",
      analysisRequest,
      analysisDescriptor?.runId ?? null,
      analysisDescriptor?.discontinuities.length ?? 0,
      // The same analyzed tail of a longer capture covers a different share of it.
      analysisCaptureSeconds,
    ],
    queryFn: async () => {
      const analysis = await analyzeWithFallback(analysisRequest);
      return {
        ...analysis,
        report: withCaptureQuality(
          analysis.report,
          analysisDescriptor,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          analysisCaptureSeconds,
        ),
      };
    },
    enabled: viewedSession === null,
  });

  const modelStatusesQuery = useQuery({
    queryKey: ["transcription-models", transcription.engine, isNative],
    queryFn: async () => {
      try {
        return await loadTranscriptionModels(transcription.engine);
      } catch {
        // Not checked is not "not downloaded" or "external CLI": say that it is unknown.
        return uncheckedModelStatuses(transcription.engine);
      }
    },
    staleTime: 10_000,
  });

  const modelStatuses = useMemo(
    () =>
      (modelStatusesQuery.data ?? staticModelStatuses(transcription.engine)).map((model) => {
        const failure = modelPreparationFailures[`${transcription.engine}:${model.id}`];
        // A failed or canceled download never makes a model ready; a cached model is ready.
        return failure && !model.cached ? { ...model, preparation: failure } : model;
      }),
    [modelStatusesQuery.data, transcription.engine, modelPreparationFailures],
  );
  const isAnalyzing = analysisQuery.isFetching;
  const selectedEngine = getTranscriptionEngine(transcription.engine);
  const selectedModels = modelStatuses.length
    ? modelStatuses.map((model) => model.id)
    : selectedEngine.models;
  const selectedModelStatus = modelStatuses.find((model) => model.id === transcription.model);
  const chunkProgress = useMemo(
    () => summarizeTranscriptionChunks(transcriptionChunks),
    [transcriptionChunks],
  );
  const captureInProgress =
    isRecording ||
    isFinishingCapture ||
    isTranscribing ||
    chunkProgress.queued + chunkProgress.processing > 0;
  const transcript = useMemo(() => verbatimTranscript(segments), [segments]);
  const readable = useMemo(() => readableTranscript(segments), [segments]);
  const speechStats = normalizedSpeechStats(report);
  const blockerStats = normalizedBlockerStats(report);
  const analyzedChunks = report.chunks ?? [];
  const intentPredictionRequest = useMemo(
    () => ({
      segments,
      sessions,
      // Events of a capture that failed the quality gate are not evidence to predict from.
      events: isScoreWithheld(report) ? [] : (report.events ?? []),
      partialText: [transcript, interimText].filter(Boolean).join(" ").trim(),
      maxContexts: 6,
      maxPredictions: 4,
      phraseTokens: 4,
    }),
    [segments, sessions, report, transcript, interimText],
  );
  const intentPredictionsQuery = useQuery({
    queryKey: ["intent-predictions", intentPredictionRequest],
    queryFn: () => predictSpeakerIntentWithFallback(intentPredictionRequest),
    staleTime: 1_000,
  });
  const intentPredictions =
    intentPredictionsQuery.data ?? fallbackPredictSpeakerIntent(intentPredictionRequest);

  const downloadModelMutation = useMutation({
    mutationFn: ({ engine, model }: { engine: TranscriptionEngineId; model: string }) =>
      downloadTranscriptionModel(engine, model),
    onSuccess: async (_result, { engine, model }) => {
      setModelPreparationFailures(({ [`${engine}:${model}`]: _cleared, ...rest }) => rest);
      await queryClient.invalidateQueries({ queryKey: ["transcription-models", engine] });
      setTranscription((current) => {
        if (current.engine !== engine) {
          return current;
        }
        const next = { ...current, model };
        localStorage.setItem(TRANSCRIPTION_KEY, JSON.stringify(next));
        return next;
      });
      setMessage(`${model} ready`);
    },
    onError: (error, { engine, model }) => {
      const failure = modelPreparationFailure(error);
      setModelPreparationFailures((current) => ({ ...current, [`${engine}:${model}`]: failure }));
      setMessage(`Download ${failure === "failed" ? "failed" : failure}: ${errorMessage(error)}`);
    },
    onSettled: () => {
      setDownloadingModel(null);
    },
  });

  useEffect(() => {
    startedAtAccessor = () => startedAtRef.current;
    return () => {
      startedAtAccessor = null;
    };
  }, []);

  useEffect(() => {
    setIsNative(isDesktopApp());
  }, []);

  useEffect(() => {
    if (!isNative) {
      return;
    }
    let cancelled = false;
    loadSpeechCorpus(sessionsRef.current)
      .then((analysis) => {
        if (!cancelled) {
          setCorpusAnalysis(analysis);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCorpusAnalysis(analyzeLocalCorpus(sessions));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isNative]);

  useEffect(() => {
    if (!isNative) {
      setCorpusAnalysis(analyzeLocalCorpus(sessions));
    }
  }, [isNative, sessions]);

  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    const readyTimer = setTimeout(() => setSpeakersReady(true), SPEAKER_LOAD_GRACE_MS);
    const hydrate = (fallbackToLocal = false) => {
      const request = ++latestRequest;
      const removalsAtStart = speakerRemovalsRef.current;
      const enrollmentsAtStart = speakerEnrollmentsRef.current;
      const isStale = () =>
        cancelled ||
        request !== latestRequest ||
        speakerRemovalsRef.current !== removalsAtStart ||
        speakerEnrollmentsRef.current !== enrollmentsAtStart;
      loadPersistedSpeakerProfiles(
        isStale,
        (profiles) =>
          queueSpeakerMutation(async () => {
            if (isStale()) return [];
            return savePersistedSpeakerProfiles(
              profiles.filter((profile) => !removedSpeakerIdsRef.current.has(profile.id)),
            );
          }),
        fallbackToLocal,
      )
        .then((persistedSpeakers) => {
          if (!isStale()) {
            const next = persistedSpeakers.filter(
              (profile) => !removedSpeakerIdsRef.current.has(profile.id),
            );
            speakersRef.current = next;
            setSpeakers(next);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(readyTimer);
          if (!cancelled) setSpeakersReady(true);
        });
    };
    reloadSpeakersRef.current = () => hydrate();
    hydrate(true);
    return () => {
      cancelled = true;
      reloadSpeakersRef.current = null;
    };
  }, []);

  useEffect(() => {
    segmentsRef.current = segments;
    pausesRef.current = pauses;
  }, [segments, pauses]);

  // Checkpoints the unsaved capture on every observation or analysis change, so closing the tab, a
  // crash or a reload loses at most the change in flight. Failures stay visible until a write
  // succeeds.
  useEffect(() => {
    const id = captureIdRef.current;
    if (!id || viewedSessionRef.current) {
      return;
    }
    const checkpoint = workspaceCheckpoint(id);
    const state = checkpointState(checkpoint);
    if (!hasCheckpointedObservation(checkpoint)) {
      if (removeCaptureCheckpoint(captureCheckpointKey(id))) {
        checkpointedRef.current = { state, checkpoint: null };
        setCheckpointError(null);
      } else {
        // The stored copy is now outdated; keep it from being offered as this capture.
        setCheckpointError(
          "This recording's stored copy is out of date and browser storage refused to update it. Save the recording before replacing it.",
        );
      }
      return;
    }
    try {
      writeCaptureCheckpoint(checkpoint);
      checkpointedRef.current = { state, checkpoint };
      setCheckpointError(null);
    } catch {
      setCheckpointError(
        "This recording is not being kept safe: browser storage is full or unavailable. Save it as soon as it is finished; closing the app now would lose it.",
      );
    }
    // workspaceCheckpoint reads exactly these values from this render. The query state is a
    // dependency too: a new request (such as the final audio after stopping) invalidates the kept
    // analysis until its own run arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    segments,
    pauses,
    report,
    reportRun,
    analysisRequest,
    analysisQuery.isFetching,
    analysisQuery.data,
  ]);

  // Offers captures that no live window owns, and drops ones another window saved or discarded.
  // A window that closes or crashes releases its lock without any event, so ownership is checked
  // again when this window regains focus or becomes visible, when another window writes a
  // checkpoint this one does not offer yet, and periodically.
  useEffect(() => {
    let cancelled = false;
    const detect = () => {
      void detectInterruptedCaptures(sessionsRef.current).then((found) => {
        if (cancelled) {
          return;
        }
        const own = captureIdRef.current ? captureCheckpointKey(captureIdRef.current) : null;
        // Notices whose checkpoint is gone (for example removed above as already saved) go too;
        // ones still stored stay, as their owner may only be busy.
        setInterruptedCaptures((current) =>
          mergeInterruptedCaptures(
            current.filter((item) => readCaptureCheckpoint(item.key) !== null),
            found.filter((item) => item.key !== own),
          ),
        );
      });
    };
    detect();
    const onStorage = (event: StorageEvent) => {
      const key = event.key;
      // Another window saved or deleted sessions: later saves here build on its list instead of
      // overwriting it with this window's older copy.
      if (key === STORE_KEY) {
        try {
          const stored = loadSessionsFromStorage();
          sessionsRef.current = stored;
          setSessions(stored);
        } catch {
          // Unreadable now; keep this window's list rather than dropping it.
        }
        return;
      }
      if (!key?.startsWith(CAPTURE_CHECKPOINT_PREFIX)) {
        return;
      }
      const updated = event.newValue === null ? null : readCaptureCheckpoint(key);
      if (updated === "unavailable") {
        return;
      }
      setInterruptedCaptures((current) =>
        updated
          ? current.map((item) => (item.key === key ? updated : item))
          : current.filter((item) => item.key !== key),
      );
      if (updated) {
        detect();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        detect();
      }
    };
    const interval = window.setInterval(detect, 30_000);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", detect);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", detect);
      document.removeEventListener("visibilitychange", onVisible);
      releaseCaptureRef.current?.();
      releaseCaptureRef.current = null;
    };
  }, []);

  useEffect(() => {
    speakersRef.current = speakers;
  }, [speakers]);

  useEffect(() => {
    speakerMatchRef.current = speakerMatch;
  }, [speakerMatch]);

  useEffect(() => {
    transcriptionRef.current = transcription;
  }, [transcription]);

  useEffect(() => {
    // A late result must not replace a saved session's stored analysis.
    if (analysisQuery.data && viewedSessionRef.current === null) {
      setReport(analysisQuery.data.report);
      setReportRun({
        id: analysisQuery.data.runId,
        createdAt: analysisQuery.data.createdAt,
        analyzer: analysisQuery.data.analyzer,
        usedAudio: analysisQuery.data.usedAudio,
        audioId: analysisQuery.data.audioId,
        inputId: analysisQuery.data.inputId,
        transcription: transcriptModelRef.current,
      });
    }
  }, [analysisQuery.data]);

  useEffect(() => {
    if (
      modelStatusesQuery.data?.length &&
      !modelStatusesQuery.data.some((model) => model.id === transcription.model)
    ) {
      updateTranscriptionModel(modelStatusesQuery.data[0]?.id ?? "default");
    }
  }, [modelStatusesQuery.data, transcription.model]);

  useEffect(() => {
    if (
      isRecording ||
      selectedEngine.id !== "whisperCpp" ||
      !selectedModelStatus?.downloadable ||
      selectedModelStatus.cached
    ) {
      return;
    }
    void downloadModel(selectedModelStatus.id, transcription.engine);
  }, [
    isRecording,
    selectedEngine.id,
    selectedModelStatus?.id,
    selectedModelStatus?.cached,
    selectedModelStatus?.downloadable,
    transcription.engine,
  ]);

  useEffect(() => {
    if (!isNative) {
      return;
    }
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<TranscriptionProgressEvent>("transcription-progress", (event) => {
          if (cancelled) {
            return;
          }
          setDownloadProgress(event.payload);
          if (event.payload.phase === "downloading") {
            setDownloadingModel(event.payload.model ?? null);
          } else {
            setDownloadingModel(null);
          }
        }),
      )
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isNative]);

  // Sessions whose saved analysis is not verified for their transcript, flagged next to the corpus
  // (local or desktop) instead of being counted silently.
  const localUnverifiedCount = useMemo(
    () => sessions.filter((session) => !isAnalysisVerified(session)).length,
    [sessions],
  );
  // The desktop corpus keeps sessions the browser history has pruned, so in the desktop app the
  // warning is counted over the corpus actually shown.
  const [desktopUnverifiedCount, setDesktopUnverifiedCount] = useState<number | null>(null);
  useEffect(() => {
    if (!isNative) {
      setDesktopUnverifiedCount(null);
      return;
    }
    let cancelled = false;
    // A small payload (inputId and observation per session), not the full store.
    void invoke<unknown>("speech_corpus_observations")
      .then((exported) => {
        if (!cancelled) {
          setDesktopUnverifiedCount(countUnverifiedCorpusSessions(exported));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopUnverifiedCount(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isNative, corpusAnalysis]);
  const unverifiedSessionCount = desktopUnverifiedCount ?? localUnverifiedCount;

  const todayStats = useMemo(() => {
    const now = new Date().toDateString();
    const todays = ownSessions(sessions).filter(
      (session) => new Date(session.startedAt).toDateString() === now,
    );
    // Sessions whose capture failed the quality gate have no event count to add.
    const totalEvents = todays.reduce(
      (sum, session) => sum + (isScoreWithheld(session.report) ? 0 : session.report.stutterCount),
      0,
    );
    const totalMinutes = todays.reduce(
      (sum, session) => sum + session.report.totalDurationSeconds / 60,
      0,
    );
    const unverified = todays.filter((session) => !isAnalysisVerified(session)).length;
    return { count: todays.length, totalEvents, totalMinutes, unverified };
  }, [sessions]);

  async function startRecording() {
    // A new capture would reset the refs the previous one is still finishing with.
    if (isRecording || isFinishingCapture || workspaceClaimPendingRef.current) {
      return;
    }
    // Starting over sets the previous unsaved capture aside for recovery, which needs a current
    // checkpoint of it.
    if (!canSetAsideWorkspaceCapture()) {
      return;
    }
    // Recovery must not replace the workspace while this start is still waiting.
    startPendingRef.current = true;
    workspaceGenerationRef.current += 1;
    try {
      if (selectedEngine.id !== "browser") {
        const ready = await ensureSelectedModelReady(transcription);
        if (!ready) {
          return;
        }
      }
      if (!isDesktopApp()) {
        // Browser-local analysis measures the capture with the WASM kernel; load it while recording.
        preloadCaptureKernel();
      }
      setMessage("Requesting microphone");
      const recorder = await createBrowserRecorder({
        onSamples: handleRecordedSamples,
        onLevel: setLevel,
      });

      browserRecorderRef.current = recorder;
      sampleRateRef.current = recorder.sampleRate;
      samplesRef.current = [];
      capturedSampleCountRef.current = 0;
      const captureId = crypto.randomUUID();
      captureDescriptorRef.current = {
        sessionId: captureId,
        runId: crypto.randomUUID(),
        origin: isDesktopApp() ? "desktop" : "browser",
        role: "appInput",
        sampleRate: recorder.sampleRate,
        ...recorder.capture,
        startOffsetSeconds: 0,
        discontinuities: [],
        speakerAssessment: soloSpeakerRef.current ? "singleSpeakerDeclared" : "unknown",
      };
      gapTrackerRef.current = createGapTracker(recorder.sampleRate, {
        startedAtSeconds: performance.now() / 1000,
      });
      recordingTranscriptionRef.current = transcriptionRef.current;
      recordingLanguageRef.current = language;
      sessionLanguageRef.current = language;
      loadedSessionRef.current = null;
      setViewedSession(null);
      resetChunkTranscription();
      liveTranscriptRef.current = startLiveTranscript(captureDescriptorRef.current.runId);
      transcriptProvenanceRef.current = transcriptProvenance({
        engine: selectedEngine.id,
        model: transcriptionRef.current.model,
        language,
        preprocessing: provisionalPreprocessing(selectedEngine.id, recorder.sampleRate),
      });
      setAsideUnsavedCapture();
      startedAtRef.current = new Date();
      activeSessionIdRef.current = null;
      takeWorkspaceCapture(captureId, null);
      lastFinalEndRef.current = 0;
      lastVoiceAtRef.current = 0;
      lastSpeakerMatchAtRef.current = 0;
      setSegments([]);
      setPauses([]);
      setInterimText("");
      setSpeakerMatch(null);
      setIsRecording(true);
      setMessage(
        selectedEngine.id === "browser"
          ? "Recording"
          : `Recording and chunking for ${selectedEngine.label}`,
      );
      if (selectedEngine.id === "browser") {
        startSpeechRecognition();
      }
    } catch (error) {
      await browserRecorderRef.current?.stop();
      browserRecorderRef.current = null;
      captureDescriptorRef.current = null;
      gapTrackerRef.current = null;
      recordingTranscriptionRef.current = null;
      setIsRecording(false);
      setIsTranscribing(false);
      setLevel(0);
      setMessage(recordingErrorMessage(error));
    } finally {
      startPendingRef.current = false;
    }
  }

  // Applies a live transcript update of the bound run; ignored updates change nothing.
  function applyLiveUpdate(update: LiveTranscriptUpdate) {
    const next = applyLiveTranscriptUpdate(liveTranscriptRef.current, update);
    if (next === liveTranscriptRef.current) {
      return;
    }
    liveTranscriptRef.current = next;
    setSegments(liveTranscriptSegments(next));
    setInterimText(liveTranscriptPartialText(next));
  }

  // Ends the live run: its late partials and finals are ignored from now on.
  function cancelLiveTranscript() {
    const current = liveTranscriptRef.current;
    liveTranscriptRef.current = applyLiveTranscriptUpdate(current, {
      kind: "cancel",
      runId: current.runId,
    });
  }

  function startSpeechRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    if (!Recognition) {
      setMessage("Recording without browser transcription");
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;
    // Results are identified per run and per recognition start: indices restart after a restart.
    const runId = liveTranscriptRef.current.runId;
    let generation = 0;
    let sequence = 0;
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript.trim() ?? "";
        if (!text) {
          continue;
        }
        const unitId = `${generation}:${index}`;
        if (result.isFinal) {
          const state = liveTranscriptRef.current;
          // A repeated final or one of an earlier run must not move the timing estimate either.
          if (state.runId !== runId || state.canceled || isUnitFinal(state, unitId)) {
            continue;
          }
          const endSeconds = elapsedSeconds();
          const estimatedDuration = Math.max(0.7, text.split(/\s+/).length * 0.34);
          const startSeconds = Math.max(lastFinalEndRef.current, endSeconds - estimatedDuration);
          lastFinalEndRef.current = endSeconds;
          const match = speakerMatchRef.current;
          // Browser speech reports no timing: the estimate only orders the segment.
          const segment: TranscriptSegment = {
            text,
            startSeconds,
            endSeconds,
            confidence: result[0]?.confidence,
            speakerId: match?.speakerId,
            speakerLabel: match?.label,
            speakerScore: match?.score,
            isFinal: true,
            alignment: "unaligned",
          };
          applyLiveUpdate({ kind: "final", runId, unitId, segments: [segment] });
        } else {
          sequence += 1;
          applyLiveUpdate({ kind: "partial", runId, unitId, sequence, text });
        }
      }
    };
    recognition.onerror = (event) => {
      setMessage(`Speech recognition: ${event.error}`);
    };
    recognition.onend = () => {
      if (!isRecordingRef.current) {
        recognitionEndedRef.current?.();
      }
      if (isRecordingRef.current) {
        generation += 1;
        try {
          recognition.start();
        } catch {
          setMessage("Speech recognition paused");
        }
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setMessage("Speech recognition unavailable");
    }
  }

  const isRecordingRef = useRef(false);
  // Resolves when browser recognition has delivered its final results after Stop.
  const recognitionEndedRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  function handleRecordedSamples(chunk: Float32Array) {
    const gap = gapTrackerRef.current?.observe(chunk.length, performance.now() / 1000);
    if (gap) {
      captureDescriptorRef.current?.discontinuities.push(gap);
    }
    const samples = samplesRef.current;
    capturedSampleCountRef.current += chunk.length;
    for (const sample of chunk) {
      samples.push(sample);
    }
    const maxSamples = sampleRateRef.current * 90;
    if (recordingTranscriptionRef.current?.engine === "browser" && samples.length > maxSamples) {
      samples.splice(0, samples.length - maxSamples);
    }
    enqueueAvailableTranscriptionChunks(false);

    const frame = chunk.length ? chunk : new Float32Array();
    void (async () => {
      let energy = 0;
      for (const sample of frame) {
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / Math.max(1, frame.length));
      setLevel(Math.min(1, rms * 12));

      const now = elapsedSeconds();
      if (rms > 0.025) {
        if (lastVoiceAtRef.current > 0 && now - lastVoiceAtRef.current > 0.75) {
          setPauses((current) => [
            ...current,
            {
              startSeconds: lastVoiceAtRef.current,
              endSeconds: now,
              afterText: interimText || segmentsRef.current.at(-1)?.text,
            },
          ]);
        }
        lastVoiceAtRef.current = now;
      }

      const speakerProfiles = speakersRef.current;
      if (
        speakerProfiles.length &&
        !speakerMatchInFlightRef.current &&
        samplesRef.current.length > sampleRateRef.current * 1.5 &&
        now - lastSpeakerMatchAtRef.current > 0.8
      ) {
        const recent = samplesRef.current.slice(-Math.floor(sampleRateRef.current * 2));
        lastSpeakerMatchAtRef.current = now;
        speakerMatchInFlightRef.current = true;
        setIsMatchingVoice(true);
        identifySpeaker(recent, sampleRateRef.current, speakerProfiles)
          .then((result) => {
            // A speaker removed while identification ran must not come back as a match.
            const match =
              result.bestMatch &&
              speakersRef.current.some((speaker) => speaker.id === result.bestMatch?.speakerId)
                ? result.bestMatch
                : null;
            speakerMatchRef.current = match;
            setSpeakerMatch(match);
          })
          .catch(() => undefined)
          .finally(() => {
            speakerMatchInFlightRef.current = false;
            setIsMatchingVoice(false);
          });
      }
    })();
  }

  async function stopRecording() {
    if (!isRecording) {
      return;
    }
    // Saving and loading stay unavailable until every late transcript result has arrived.
    setIsFinishingCapture(true);
    try {
      await finishCapture();
    } finally {
      setIsFinishingCapture(false);
      setCaptureRevision((revision) => revision + 1);
    }
  }

  async function finishCapture() {
    const shouldTranscribeNative = recordingTranscriptionRef.current?.engine !== "browser";
    const capturedSamples = samplesRef.current.slice();
    const capturedSampleRate = sampleRateRef.current;
    setIsRecording(false);
    isRecordingRef.current = false;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    const recognitionEnded = recognition
      ? new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // It never ended: detach it so late callbacks cannot reach a later capture.
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            try {
              recognition.abort();
            } catch {
              // Already stopped.
            }
            recognitionEndedRef.current = null;
            resolve();
          }, RECOGNITION_END_TIMEOUT_MS);
          recognitionEndedRef.current = () => {
            clearTimeout(timer);
            recognitionEndedRef.current = null;
            resolve();
          };
        })
      : Promise.resolve();
    recognition?.stop();
    // The capture ends now; recorder teardown time is not missing audio.
    const stoppedAtSeconds = performance.now() / 1000;
    await browserRecorderRef.current?.stop();
    browserRecorderRef.current = null;
    const finalGap = gapTrackerRef.current?.finish(stoppedAtSeconds);
    if (finalGap) {
      captureDescriptorRef.current?.discontinuities.push(finalGap);
    }
    gapTrackerRef.current = null;
    setLevel(0);
    await recognitionEnded;
    if (!shouldTranscribeNative) {
      setMessage("Stopped");
      recordingTranscriptionRef.current = null;
      return;
    }
    if (
      capturedSamples.length < capturedSampleRate / 2 &&
      chunkResultsRef.current.completed === 0
    ) {
      setMessage("Not enough audio to transcribe");
      recordingTranscriptionRef.current = null;
      return;
    }
    setMessage("Finishing transcription chunks");
    try {
      samplesRef.current = capturedSamples;
      sampleRateRef.current = capturedSampleRate;
      enqueueAvailableTranscriptionChunks(true);
      await chunkTranscriptionTailRef.current;
      const { completed, failed } = chunkResultsRef.current;
      if (completed > 0) {
        setMessage(
          failed > 0
            ? `Transcribed ${completed} chunk${completed === 1 ? "" : "s"}, ${failed} failed`
            : `Transcribed ${completed} chunk${completed === 1 ? "" : "s"}`,
        );
      } else {
        setMessage("No transcript returned");
      }
    } finally {
      recordingTranscriptionRef.current = null;
      fetchModelStatuses();
    }
  }

  async function saveSpeakerProfile() {
    if (samplesRef.current.length < sampleRateRef.current) {
      setMessage("Record a short sample first");
      return;
    }
    const label = speakerLabel.trim() || `Speaker ${speakersRef.current.length + 1}`;
    const existing = speakersRef.current.find(
      (speaker) => speaker.label.toLowerCase() === label.toLowerCase(),
    );
    setIsEnrolling(true);
    setMessage("Enrolling speaker");
    try {
      const result = await createSpeakerProfile(
        existing?.id,
        label,
        samplesRef.current.slice(-sampleRateRef.current * 12),
        sampleRateRef.current,
      );
      // Same queue as removals, built from the latest list when it runs, so an enrollment
      // cannot write back a profile removed while it was being created.
      const persisted = await queueSpeakerMutation(async () => {
        const latest = speakersRef.current;
        if (existing && !latest.some((speaker) => speaker.id === existing.id)) {
          throw new Error(
            "This voiceprint was removed while enrollment was pending. Enroll again to create a new profile.",
          );
        }
        const next =
          existing && latest.some((speaker) => speaker.id === existing.id)
            ? latest.map((speaker) =>
                speaker.id === existing.id
                  ? {
                      ...speaker,
                      label: result.label,
                      embeddings: [...speaker.embeddings, ...result.embeddings],
                      sampleCount: speaker.sampleCount + result.sampleCount,
                      sampleRate: result.sampleRate,
                    }
                  : speaker,
              )
            : [...latest, result];
        const saved = await savePersistedSpeakerProfiles(next);
        speakerEnrollmentsRef.current += 1;
        if (saved.some((speaker) => speaker.id === result.id)) {
          removedSpeakerIdsRef.current.delete(result.id);
        }
        speakersRef.current = saved;
        return saved;
      });
      setSpeakers(persisted);
      setSpeakerLabel("");
      setMessage(`${result.label} enrolled`);
    } catch (error) {
      setMessage(`Enrollment failed: ${errorMessage(error)}`);
    } finally {
      setIsEnrolling(false);
    }
  }

  // Writes storage first, so a failed write (quota, blocked storage) leaves memory unchanged.
  function persistSessions(next: SavedSession[]) {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    sessionsRef.current = next;
    setSessions(next);
  }

  // Each mutation starts from the stored list: another window may have changed it before its
  // storage event arrived here.
  function serializeSessionMutation<T>(mutation: () => Promise<T>): Promise<T> {
    return sessionMutationQueue(() => {
      try {
        const stored = loadSessionsFromStorage();
        sessionsRef.current = stored;
        setSessions(stored);
      } catch {
        // Unreadable now; keep this window's list rather than dropping it.
      }
      return mutation();
    });
  }

  async function saveSession() {
    if (restorePendingRef.current > 0) {
      setMessage("Wait for the session restore to finish before saving");
      return;
    }
    if (!segments.length && !pauses.length && !report.events.length) {
      setMessage("Nothing to save");
      return;
    }
    // A saved session freezes the workspace's analysis, so the observation must be complete and
    // the shown report must be the analysis of exactly that observation.
    if (captureInProgress) {
      setMessage("Stop recording and let transcription finish before saving");
      return;
    }
    if (
      !viewedSessionRef.current &&
      (isAnalyzing ||
        (reportRun !== null &&
          (reportRun.inputId !== observationFingerprint(segments, pauses) ||
            reportRun.audioId !== currentAudioId())))
    ) {
      setMessage("Analysis is still updating; save again in a moment");
      return;
    }
    const loaded = loadedSessionRef.current;
    if (
      loaded &&
      observationFingerprint(segments, pauses) ===
        observationFingerprint(loaded.segments, loaded.pauses)
    ) {
      await saveLoadedSession(loaded);
      return;
    }
    // Until a queued save has stored the workspace, another click would store a second copy.
    if (newSessionSavePendingRef.current) {
      setMessage("Session is already being saved");
      return;
    }
    const captureId = captureIdRef.current;
    const descriptor = captureDescriptorRef.current;
    // The capture's audio, kept on the device when the user asked for it; either way it feeds the
    // automatic reference transcript of this recording.
    const capturedAudio =
      captureId && descriptor?.sessionId === captureId ? captureForKeeping(descriptor) : null;
    const keptCapture = keepAudio ? capturedAudio : null;
    const reference: { saved: { session: SavedSession; audio: KeptSessionAudio } | null } = {
      saved: null,
    };
    const startedAt = startedAtRef.current?.toISOString() ?? new Date().toISOString();
    const spokenLanguage = canonicalSpokenLanguage(sessionLanguageRef.current);
    newSessionSavePendingRef.current = true;
    let audioOutcome: "kept" | string | null = null;
    const outcome = await serializeSessionMutation(async () => {
      if (captureId && captureIdRef.current !== captureId) {
        // An earlier queued save stored it, or the workspace set it aside while this one waited.
        return sessionsRef.current.some((candidate) => candidate.id === captureId)
          ? ("unchanged" as const)
          : ("set-aside" as const);
      }
      // A capture is saved under its checkpoint id, so a checkpoint left behind by a crash between
      // the save and its removal is recognized as saved instead of being recovered as a duplicate.
      const sessionId =
        captureId && !sessionsRef.current.some((candidate) => candidate.id === captureId)
          ? captureId
          : crypto.randomUUID();
      const session: SavedSession = createSessionRecord({
        id: sessionId,
        // The capture's provenance travels with it; an edited saved session keeps the original's.
        recordings:
          descriptor && descriptor.sessionId === captureId
            ? [{ ...descriptor, sessionId }]
            : (loaded?.recordings.map((recording) => ({ ...recording, sessionId })) ?? []),
        startedAt,
        segments,
        pauses,
        report,
        run: reportRun ?? {
          id: crypto.randomUUID(),
          createdAt: null,
          analyzer: null,
          usedAudio: null,
          audioId: null,
          // Saved before any analysis finished: the report was not computed from this observation.
          inputId: UNKNOWN_INPUT_ID,
        },
        context: { spokenLanguage, task: null, condition: null },
        transcript: transcriptProvenanceRef.current
          ? {
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              kind: "provisional",
              provenance: transcriptProvenanceRef.current,
              supersedes: null,
            }
          : undefined,
      });
      try {
        persistSessions([session, ...sessionsRef.current].slice(0, 50));
      } catch {
        return "failed" as const;
      }
      if (captureId) {
        // Left behind if this fails; the next start recognizes it as saved and removes it.
        removeCaptureCheckpoint(captureCheckpointKey(captureId));
        releaseWorkspaceCapture();
      }
      activeSessionIdRef.current = session.id;
      // Later saves of this workspace append runs to this record instead of creating copies.
      loadedSessionRef.current = session;
      setViewedSession(session);
      if (capturedAudio) {
        reference.saved = {
          session,
          audio: { ...capturedAudio, sessionId: session.id, keptAt: new Date().toISOString() },
        };
      }
      if (keptCapture) {
        const kept = { ...keptCapture, sessionId: session.id, keptAt: new Date().toISOString() };
        try {
          await putSessionAudio(kept);
          if (viewedSessionRef.current?.id === session.id) setViewedAudio(kept);
          audioOutcome = "kept";
        } catch (error) {
          audioOutcome = errorMessage(error);
        }
      }
      // Sessions past the limit were dropped above; so is any audio kept with them.
      await retainSessionAudio(sessionsRef.current.map((candidate) => candidate.id)).catch(
        () => undefined,
      );
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(session));
        return "corpus" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    }).finally(() => {
      newSessionSavePendingRef.current = false;
    });
    const audioNote =
      audioOutcome === null
        ? ""
        : audioOutcome === "kept"
          ? "; audio kept on this device for review"
          : `; the audio could not be kept (${audioOutcome})`;
    setMessage(
      (outcome === "failed"
        ? "Could not save the session: browser storage is full or unavailable"
        : outcome === "unchanged"
          ? "Session is already saved"
          : outcome === "set-aside"
            ? "The recording was set aside before it was saved; recover it to save it"
            : outcome === "corpus"
              ? "Session saved to corpus"
              : "Session saved locally") +
        (outcome === "corpus" || outcome === "local" ? audioNote : ""),
    );
    if ((outcome === "corpus" || outcome === "local") && reference.saved) {
      void startReferenceTranscript(reference.saved.session, reference.saved.audio);
    }
  }

  // The raw capture as the workspace holds it, with what is needed to place it on the session
  // clock. The browser engine keeps a rolling window, so earlier samples may be gone.
  function captureForKeeping(descriptor: RecordingDescriptor) {
    const samples = Float32Array.from(samplesRef.current);
    const sampleRate = sampleRateRef.current;
    if (!samples.length || sampleRate <= 0) return null;
    return {
      sampleRate,
      samples,
      startOffsetSeconds: descriptor.startOffsetSeconds,
      discontinuities: descriptor.discontinuities.map((gap) => ({ ...gap })),
      droppedSeconds: Math.max(0, capturedSampleCountRef.current - samples.length) / sampleRate,
      audioId: audioFingerprint(samples, sampleRate),
    };
  }

  // Fingerprint of the audio an analysis of the workspace would use now (null without audio).
  function currentAudioId() {
    const audio = analysisAudioPayload(samplesRef.current, sampleRateRef.current);
    return audio.samples && audio.sampleRate
      ? audioFingerprint(audio.samples, audio.sampleRate)
      : null;
  }

  // Saving the session already on screen never creates a copy: either it is unchanged, or a new
  // analysis run is appended to its history.
  async function saveLoadedSession(loaded: SavedSession) {
    const knownRuns = [loaded.analysis.id, ...loaded.priorAnalyses.map((run) => run.id)];
    if (!reportRun || knownRuns.includes(reportRun.id)) {
      setMessage("Session is already saved");
      return;
    }
    const run = reportRun;
    const savedReport = report;
    // Runs after every queued mutation and rebuilds from the latest stored record, so a session
    // deleted meanwhile is never written back and queued saves keep each other's runs.
    const outcome = await serializeSessionMutation(async () => {
      const latest = sessionsRef.current.find((candidate) => candidate.id === loaded.id);
      if (!latest) {
        return "deleted" as const;
      }
      if (
        latest.analysis.id === run.id ||
        latest.priorAnalyses.some((prior) => prior.id === run.id)
      ) {
        return "unchanged" as const;
      }
      const updated = reanalyzeSession(latest, run, savedReport);
      // The user may have opened another session while this save waited in the queue.
      if (loadedSessionRef.current?.id === updated.id) {
        loadedSessionRef.current = updated;
      }
      try {
        persistSessions(
          sessionsRef.current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        );
      } catch {
        return "failed" as const;
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(updated));
        return "corpus" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    });
    setMessage(
      outcome === "failed"
        ? "Could not save the session: browser storage is full or unavailable"
        : outcome === "deleted"
          ? "Session was deleted; nothing saved"
          : outcome === "unchanged"
            ? "Session is already saved"
            : outcome === "corpus"
              ? "New analysis saved to the session"
              : "New analysis saved locally",
    );
  }

  // Explicit reanalysis of a saved transcript (no stored audio): appends a run, keeping the
  // earlier ones, and shows the new result if that session is on screen.
  async function reanalyzeSavedSession(session: SavedSession) {
    if (captureInProgress) {
      setMessage("Stop recording and let transcription finish before reanalyzing");
      return;
    }
    // Audio is not stored, so a session without transcript or pauses has nothing to replay;
    // analyzing empty input would replace an acoustic-only result with nothing.
    if (!isReplayable(session)) {
      setMessage("This session has no saved transcript to reanalyze");
      return;
    }
    // One run per session at a time, so runs are appended in the order they were started.
    if (reanalyzingRef.current.has(session.id)) {
      return;
    }
    reanalyzingRef.current.add(session.id);
    setReanalyzingSessionIds([...reanalyzingRef.current]);
    try {
      await runReanalysis(session);
    } finally {
      reanalyzingRef.current.delete(session.id);
      setReanalyzingSessionIds([...reanalyzingRef.current]);
    }
  }

  async function runReanalysis(session: SavedSession) {
    setMessage("Reanalyzing saved session");
    const analysis = await analyzeWithFallback({
      segments: session.segments,
      pauses: session.pauses,
      sessionStartedAt: session.startedAt,
    });
    const outcome = await serializeSessionMutation(async () => {
      const latest = sessionsRef.current.find((candidate) => candidate.id === session.id);
      if (!latest) {
        return "deleted" as const;
      }
      const updated = reanalyzeSession(
        latest,
        {
          id: analysis.runId,
          createdAt: analysis.createdAt,
          analyzer: analysis.analyzer,
          usedAudio: false,
          audioId: null,
          // The stored transcript is reanalyzed: the model that produced its current revision.
          transcription: latest.transcript?.provenance
            ? {
                engine: latest.transcript.provenance.engine,
                model: latest.transcript.provenance.model,
              }
            : (latest.analysis.transcription ?? null),
        },
        analysis.report,
      );
      try {
        persistSessions(
          sessionsRef.current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        );
      } catch {
        return "failed" as const;
      }
      if (viewedSessionRef.current?.id === updated.id) {
        loadedSessionRef.current = updated;
        setViewedSession(updated);
        setReport(updated.report);
        setReportRun(updated.analysis);
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(updated));
        return "saved" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    });
    setMessage(
      outcome === "saved"
        ? "Reanalysis added to the session"
        : outcome === "local"
          ? isDesktopApp()
            ? "Reanalysis saved locally; the desktop corpus still has the earlier analysis"
            : "Reanalysis added to the session"
          : outcome === "deleted"
            ? "Session was deleted; nothing reanalyzed"
            : "Could not save the reanalysis: browser storage is full or unavailable",
    );
  }

  /**
   * Automatic post-session reference transcript (vox#26, owner answer Q3 B): after a recording is
   * saved, its whole audio is transcribed again with the fixed REFERENCE_TRANSCRIPT_MODEL when
   * whisper.cpp can run here, that model is already on this device and it is larger than the
   * provisional model. The result is saved as a new current transcript revision next to the
   * provisional one and the session is reanalyzed. Nothing is downloaded for it.
   */
  async function startReferenceTranscript(session: SavedSession, audio: KeptSessionAudio) {
    const model = REFERENCE_TRANSCRIPT_MODEL;
    if (
      !(isNative || computeClient.destination.kind !== "onDevice") ||
      audio.sessionId !== session.id ||
      // A rolling capture window lost the start; a reference would not cover the recording.
      audio.droppedSeconds > 0 ||
      !referenceTranscriptApplies(
        session.transcript?.provenance ?? session.analysis.transcription ?? null,
      )
    ) {
      return;
    }
    if (referencePendingRef.current.has(session.id)) {
      return;
    }
    referencePendingRef.current.add(session.id);
    setReferencePendingIds([...referencePendingRef.current]);
    try {
      const settings: TranscriptionSettings = {
        engine: "whisperCpp",
        model,
        device: transcriptionRef.current.device,
      };
      const statuses = await loadTranscriptionModels("whisperCpp").catch(() => []);
      if (!statuses.some((status) => status.id === model && status.cached)) {
        return;
      }
      // Bound now: the session's own language, never the current selection.
      const spoken = canonicalSpokenLanguage(session.context.spokenLanguage);
      const language =
        session.transcript?.provenance?.language ??
        (spoken === UNKNOWN_SPOKEN_LANGUAGE ? "auto" : spoken);
      const chunk = Math.round(audio.sampleRate * REFERENCE_CHUNK_SECONDS);
      const segments: TranscriptSegment[] = [];
      let detectedLanguage: string | null = null;
      // The last chunk's: after a GPU failure every later chunk runs on the CPU.
      let compute: TranscriptCompute | null = null;
      for (let start = 0; start < audio.samples.length; start += chunk) {
        const end = Math.min(audio.samples.length, start + chunk);
        setMessage(
          `Reference transcript with ${model}: ${Math.round((start / audio.samples.length) * 100)}%`,
        );
        const samples = resampleSamples(
          Array.from(audio.samples.subarray(start, end)),
          audio.sampleRate,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
        );
        const result = await transcribeAudio(
          samples,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          settings,
          language,
        );
        detectedLanguage ??= result.language ?? null;
        compute = result.compute ?? compute;
        if (result.compute) setLastCompute(result.compute);
        const identified = await identifyTranscriptSpeakers(
          result.segments,
          samples,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          speakersRef.current,
        );
        // Chunk time to the session clock through the capture's sample index, across its gaps.
        const clock = (seconds: number) =>
          clockSecondsAt(
            audio,
            Math.min(end, start + Math.round(Math.max(0, seconds) * audio.sampleRate)),
          );
        segments.push(
          ...markUnalignedTiming(identified).map((segment) =>
            segment.alignment === "unaligned"
              ? {
                  ...segment,
                  startSeconds: clock(0),
                  endSeconds: clock(0),
                }
              : {
                  ...segment,
                  startSeconds: clock(segment.startSeconds),
                  endSeconds: clock(segment.endSeconds),
                },
          ),
        );
      }
      const provenance = transcriptProvenance({
        engine: "whisperCpp",
        model,
        language,
        detectedLanguage,
        preprocessing: {
          captureSampleRate: audio.sampleRate,
          modelSampleRate: TRANSCRIPTION_TARGET_SAMPLE_RATE,
          chunkSeconds: REFERENCE_CHUNK_SECONDS,
        },
        compute,
      });
      const revision: { record: SavedSession | null } = { record: null };
      const saved = await updateStoredSession(
        session.id,
        (latest) => {
          revision.record = reviseTranscript(
            latest,
            {
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              kind: "reference",
              provenance,
            },
            segments,
          );
          return revision.record;
        },
        "reference transcript",
      );
      const updated = revision.record;
      if (!saved || !updated) {
        return;
      }
      // Shown only if the user is still on that session; another session is never touched.
      if (viewedSessionRef.current?.id === updated.id) {
        setSegments(updated.segments);
        transcriptProvenanceRef.current = provenance;
        transcriptModelRef.current = { engine: provenance.engine, model: provenance.model };
      }
      await reanalyzeSavedSession(updated);
    } catch (error) {
      setMessage(`Reference transcript failed: ${errorMessage(error)}`);
    } finally {
      referencePendingRef.current.delete(session.id);
      setReferencePendingIds([...referencePendingRef.current]);
    }
  }

  // Applies one change to the latest stored copy of a session through the mutation queue. Returns
  // false when nothing was saved, so the caller keeps what the user entered.
  async function updateStoredSession(
    sessionId: string,
    update: (latest: SavedSession) => SavedSession,
    what: string,
  ) {
    if (restorePendingRef.current > 0) {
      setMessage(`Wait for the session restore to finish before saving the ${what}`);
      return false;
    }
    const outcome = await serializeSessionMutation(async () => {
      const latest = sessionsRef.current.find((candidate) => candidate.id === sessionId);
      if (!latest) {
        return "deleted" as const;
      }
      let updated: SavedSession;
      try {
        updated = update(latest);
      } catch (error) {
        return { rejected: errorMessage(error) };
      }
      try {
        persistSessions(
          sessionsRef.current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        );
      } catch {
        return "failed" as const;
      }
      if (viewedSessionRef.current?.id === updated.id) {
        loadedSessionRef.current = updated;
        setViewedSession(updated);
      }
      if (updated.reviewCopy) {
        return "saved" as const;
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(updated));
        return "saved" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    });
    const capitalized = what[0].toUpperCase() + what.slice(1);
    setMessage(
      typeof outcome === "object"
        ? `${capitalized} not saved: ${outcome.rejected}`
        : outcome === "saved"
          ? `${capitalized} saved to the session`
          : outcome === "local"
            ? isDesktopApp()
              ? `${capitalized} saved locally; the desktop corpus still has the earlier version`
              : `${capitalized} saved to the session`
            : outcome === "deleted"
              ? `Session was deleted; ${what} not saved`
              : `Could not save the ${what}: browser storage is full or unavailable`,
    );
    return outcome === "saved" || outcome === "local";
  }

  // Appends the rater's revision, replacing only that rater's previous revision.
  function saveAnnotation(sessionId: string, request: AnnotationSaveRequest) {
    return updateStoredSession(
      sessionId,
      (latest) =>
        annotateSession(latest, {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          author: request.author,
          // Outside blind review the analysis is on screen next to the workbench; a review copy
          // has no analysis to show.
          basedOnRunId: request.blind || latest.reviewCopy ? null : latest.analysis.id,
          events: request.events,
          status: request.status,
          supersedes: currentRevisionBy(latest, request.author)?.id ?? null,
        }),
      "annotation",
    );
  }

  // Records the adjudicator's per-item decisions for the session's current ratings; both rater
  // revisions stay unchanged.
  function saveAdjudication(sessionId: string, request: AdjudicationRequest) {
    return updateStoredSession(
      sessionId,
      (latest) =>
        annotateSession(
          latest,
          adjudicationRevision(latest, {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            ...request,
          }),
        ),
      "adjudication",
    );
  }

  // Adds a rater's annotation file: merged into the session it describes, or kept as a review
  // copy when this device does not have that session. Nothing local is changed or removed.
  async function importAnnotationFile(file: File) {
    if (restorePendingRef.current > 0) {
      setMessage("Wait for the session restore to finish before importing annotations");
      return;
    }
    let exchange: AnnotationExchange;
    let audio: KeptSessionAudio | null = null;
    try {
      exchange = parseAnnotationExchange(JSON.parse(await file.text()));
      if (exchange.audio) {
        const samples = decodeSamples(exchange.audio.samples);
        if (audioFingerprint(samples, exchange.audio.sampleRate) !== exchange.audio.audioId) {
          throw new Error("the file's audio does not match its fingerprint");
        }
        const { samples: _encoded, ...placement } = exchange.audio;
        audio = {
          ...placement,
          samples,
          sessionId: exchange.session.id,
          keptAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      setMessage(`Import failed: ${errorMessage(error)}`);
      return;
    }
    const outcome = await serializeSessionMutation(async () => {
      const existing = sessionsRef.current.find((session) => session.id === exchange.session.id);
      let result: ReturnType<typeof mergeAnnotationExchange>;
      try {
        result = mergeAnnotationExchange(
          existing ??
            reviewCopyFromExchange(exchange, {
              importedAt: new Date(),
              emptyReport: emptyReport(),
            }),
          exchange,
        );
      } catch (error) {
        return { failed: errorMessage(error) };
      }
      try {
        persistSessions(
          existing
            ? sessionsRef.current.map((session) =>
                session.id === result.record.id ? result.record : session,
              )
            : [result.record, ...sessionsRef.current],
        );
      } catch {
        return { failed: "browser storage is full or unavailable" };
      }
      if (viewedSessionRef.current?.id === result.record.id) {
        loadedSessionRef.current = result.record;
        setViewedSession(result.record);
      }
      let audioNote = "";
      if (audio) {
        try {
          const kept = await getSessionAudio(result.record.id);
          if (!kept) {
            await putSessionAudio(audio);
            if (viewedSessionRef.current?.id === result.record.id) setViewedAudio(audio);
            audioNote = "; its audio is kept on this device for review";
          } else if (kept.audioId !== audio.audioId) {
            audioNote = "; its audio differs from the audio kept here, which was left unchanged";
          }
        } catch (error) {
          audioNote = `; its audio could not be kept (${errorMessage(error)})`;
        }
      }
      if (existing && !existing.reviewCopy) {
        try {
          setCorpusAnalysis(await saveSpeechCorpusSession(result.record));
        } catch {
          setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        }
      }
      return { ...result, created: !existing, audioNote };
    });
    setMessage(
      "failed" in outcome
        ? `Import failed: ${outcome.failed}`
        : `${outcome.created ? "Added a review copy with" : "Imported"} ${outcome.added} new annotation revision${outcome.added === 1 ? "" : "s"}${outcome.alreadyPresent ? ` (${outcome.alreadyPresent} already here)` : ""}${outcome.audioNote}`,
    );
  }

  function tagContext(sessionId: string, tags: ContextTags) {
    return updateStoredSession(
      sessionId,
      (latest) => {
        const previous = latest.context.condition;
        // Re-tagging the same aid keeps the settings recorded with it.
        const condition =
          tags.condition?.kind === "assisted" &&
          previous?.kind === "assisted" &&
          previous.aidId === tags.condition.aidId
            ? previous
            : tags.condition;
        return tagSessionContext(latest, { ...tags, condition });
      },
      "session context",
    );
  }

  function declareSessionValidation(sessionId: string, raters: [AnnotationRater, AnnotationRater]) {
    return updateStoredSession(
      sessionId,
      (latest) => declareValidation(latest, { declaredAt: new Date().toISOString(), raters }),
      "validation declaration",
    );
  }

  // Removing a voiceprint deletes the local copy and, when a server holds it, the server copy;
  // the message says which happened. Removals run one at a time from the latest list.
  function removeSpeakerProfile(speaker: SpeakerProfile) {
    if (!window.confirm(`Remove the voiceprint for ${speaker.label}?`)) {
      return Promise.resolve();
    }
    speakerRemovalsRef.current += 1;
    return queueSpeakerMutation(() => removeSpeakerLocally(speaker)).then((removed) => {
      if (!removed) {
        speakerRemovalsRef.current -= 1;
        reloadSpeakersRef.current?.();
        return;
      }
      removedSpeakerIdsRef.current.add(speaker.id);
      reloadSpeakersRef.current?.();
      // Remote deletion remains outside the queue so a stalled server does not block local changes.
      return deleteSpeakerRemotely(speaker);
    });
  }

  function queueSpeakerMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = speakerMutationTailRef.current.then(mutation);
    speakerMutationTailRef.current = operation.catch(() => undefined);
    return operation;
  }

  /** Removes the local copies; resolves true when the speaker is gone locally. */
  async function removeSpeakerLocally(speaker: SpeakerProfile): Promise<boolean> {
    const remaining = speakersRef.current.filter((candidate) => candidate.id !== speaker.id);
    // Browser-storage copies go first (on desktop they are what the profile was migrated from),
    // so a failure leaves the profile listed and removable.
    try {
      removeLocalSpeakerCopy(speaker.id);
    } catch (error) {
      setMessage(`Could not remove ${speaker.label} from this browser: ${errorMessage(error)}`);
      return false;
    }
    let next = remaining;
    if (isDesktopApp()) {
      try {
        next = await invoke<SpeakerProfile[]>("save_speaker_profiles", { speakers: remaining });
      } catch (error) {
        setMessage(`Could not remove ${speaker.label}: ${errorMessage(error)}`);
        return false;
      }
    }
    speakersRef.current = next;
    setSpeakers(next);
    if (speakerMatchRef.current?.speakerId === speaker.id) {
      speakerMatchRef.current = null;
      setSpeakerMatch(null);
    }
    if (isDesktopApp()) {
      setMessage(`Removed ${speaker.label}`);
    }
    return true;
  }

  async function deleteSpeakerRemotely(speaker: SpeakerProfile) {
    if (isDesktopApp()) {
      return;
    }
    setPendingSpeakerDeletionIds((ids) => new Set([...ids, speaker.id]));
    try {
      const result = await computeClient.deleteSpeakerProfile(speaker.id);
      if (result !== "noServer") {
        setFailedSpeakerDeletions((profiles) =>
          profiles.filter((profile) => profile.id !== speaker.id),
        );
        reloadSpeakersRef.current?.();
      }
      setMessage(
        result === "noServer"
          ? // No server is permitted now; one used under earlier consent may still hold a copy.
            `Removed ${speaker.label} from this device. No compute server is selected now; if you sent it to one earlier, delete it there too.`
          : `Removed ${speaker.label} here and from the compute server`,
      );
    } catch (error) {
      setFailedSpeakerDeletions((profiles) => [
        ...profiles.filter((profile) => profile.id !== speaker.id),
        speaker,
      ]);
      setMessage(
        `Removed ${speaker.label} on this device only; deleting it from the compute server failed (${errorMessage(error)})`,
      );
    } finally {
      setPendingSpeakerDeletionIds((ids) => {
        const next = new Set(ids);
        next.delete(speaker.id);
        return next;
      });
    }
  }

  // The workspace capture as a checkpoint. The analysis is kept only when it is the finished
  // analysis of exactly this observation and audio, because it cannot be recomputed after recovery.
  function workspaceCheckpoint(id: string): CaptureCheckpoint {
    // The query's data belongs to the current request (observation and audio), so a run that came
    // from it matches the current audio without fingerprinting the samples again.
    const analysis =
      reportRun &&
      analysisQuery.data &&
      !analysisQuery.isFetching &&
      reportRun.id === analysisQuery.data.runId &&
      reportRun.inputId === observationFingerprint(segments, pauses)
        ? { report, run: reportRun }
        : null;
    return {
      version: 1,
      id,
      startedAt: (startedAtRef.current ?? new Date()).toISOString(),
      updatedAt: new Date().toISOString(),
      language: sessionLanguageRef.current,
      segments,
      pauses,
      analysis,
      recording:
        captureDescriptorRef.current?.sessionId === id ? captureDescriptorRef.current : null,
      transcription: transcriptModelRef.current,
    };
  }

  // Makes `id` the workspace capture, owned by this window until it is saved or set aside.
  function takeWorkspaceCapture(id: string, release: (() => void) | null) {
    releaseWorkspaceCapture();
    workspaceGenerationRef.current += 1;
    captureIdRef.current = id;
    if (release) {
      releaseCaptureRef.current = release;
    } else {
      void claimCapture(id).then((claimed) => {
        if (captureIdRef.current !== id || releaseCaptureRef.current) {
          claimed?.();
        } else if (claimed) {
          releaseCaptureRef.current = claimed;
        } else {
          setClaimError(
            "This recording could not be reserved for this window, so another open window may offer it for recovery. Save it as soon as it is finished.",
          );
        }
      });
    }
  }

  function releaseWorkspaceCapture() {
    releaseCaptureRef.current?.();
    releaseCaptureRef.current = null;
    setClaimError(null);
    captureIdRef.current = null;
    checkpointedRef.current = null;
    setCheckpointError(null);
  }

  // False, with a message, when the workspace holds an observation whose checkpoint is missing or
  // stale: replacing the workspace would lose it.
  function canSetAsideWorkspaceCapture() {
    const id = captureIdRef.current;
    if (!id) {
      return true;
    }
    // A running analysis may still use the capture's audio, which is not kept; its result would be
    // lost with the workspace.
    if (isAnalyzing) {
      setMessage("Wait for the analysis of the current recording to finish first");
      return false;
    }
    const checkpoint = workspaceCheckpoint(id);
    if (checkpointedRef.current?.state === checkpointState(checkpoint)) {
      return true;
    }
    // Nothing to keep, unless an outdated stored copy could not be removed and would be offered.
    if (!hasCheckpointedObservation(checkpoint) && !checkpointedRef.current?.checkpoint) {
      return true;
    }
    setMessage(
      "Save the current recording first: browser storage could not keep a copy of it, so replacing it would lose it",
    );
    return false;
  }

  // Replacing the workspace (a new capture, opening or recovering a recording) offers its unsaved
  // capture for recovery instead of dropping it. Callers check canSetAsideWorkspaceCapture first.
  function setAsideUnsavedCapture() {
    const id = captureIdRef.current;
    const checkpoint = checkpointedRef.current?.checkpoint;
    if (id && checkpoint) {
      setInterruptedCaptures((current) =>
        mergeInterruptedCaptures(current, [
          { key: captureCheckpointKey(id), kind: "checkpoint", checkpoint },
        ]),
      );
    }
    releaseWorkspaceCapture();
  }

  function replaceInterruptedCapture(capture: InterruptedCapture) {
    setInterruptedCaptures((current) =>
      current.map((item) => (item.key === capture.key ? capture : item)),
    );
  }

  function dropInterruptedCapture(key: string) {
    setInterruptedCaptures((current) => current.filter((item) => item.key !== key));
  }

  function showSavedSession(session: SavedSession) {
    startedAtRef.current = new Date(session.startedAt);
    activeSessionIdRef.current = session.id;
    setSegments(session.segments);
    setPauses(session.pauses);
    setReport(session.report);
    setReportRun(session.analysis);
    transcriptModelRef.current = session.analysis.transcription ?? null;
    transcriptProvenanceRef.current = session.transcript?.provenance ?? null;
    cancelLiveTranscript();
    sessionLanguageRef.current = session.context.spokenLanguage;
    loadedSessionRef.current = session;
    setViewedSession(session);
    // Audio is not stored with sessions; keeping the last recording's PCM would analyze
    // this session against someone else's audio.
    samplesRef.current = [];
    capturedSampleCountRef.current = 0;
    captureDescriptorRef.current = null;
  }

  async function recoverInterruptedCapture(capture: InterruptedCapture) {
    if (
      workspaceClaimPendingRef.current ||
      startPendingRef.current ||
      captureInProgress ||
      capture.kind !== "checkpoint" ||
      !canSetAsideWorkspaceCapture()
    ) {
      return;
    }
    // Other workspace changes wait until ownership is settled, so the checks above stay true.
    workspaceClaimPendingRef.current = true;
    let release: (() => void) | null;
    try {
      release = await claimCapture(capture.checkpoint.id);
    } finally {
      workspaceClaimPendingRef.current = false;
    }
    if (!release) {
      setMessage("This recording is open in another window");
      return;
    }
    // A recording may have started meanwhile; replacing its workspace would mix its live input into
    // the recovered capture.
    if (startPendingRef.current || isRecordingRef.current) {
      release();
      return;
    }
    // Another window may have recovered, changed or removed it before releasing it.
    const current = readCaptureCheckpoint(capture.key);
    if (current === "unavailable") {
      release();
      setMessage("Could not recover the recording: browser storage is unavailable");
      return;
    }
    if (current?.kind !== "checkpoint") {
      release();
      if (current) {
        replaceInterruptedCapture(current);
      } else {
        dropInterruptedCapture(capture.key);
      }
      setMessage("This recording changed in another window; check it again");
      return;
    }
    const { checkpoint } = current;
    // Another window may have saved sessions since this one loaded them; recovering against a stale
    // list would also overwrite them on save.
    let storedSessions: SavedSession[];
    try {
      storedSessions = loadSessionsFromStorage();
    } catch {
      release();
      setMessage("Could not recover the recording: saved sessions could not be read");
      return;
    }
    sessionsRef.current = storedSessions;
    setSessions(storedSessions);
    if (storedSessions.some((session) => session.id === checkpoint.id)) {
      release();
      removeCaptureCheckpoint(capture.key);
      dropInterruptedCapture(capture.key);
      setMessage("This recording was already saved");
      return;
    }
    setAsideUnsavedCapture();
    dropInterruptedCapture(capture.key);
    if (checkpoint.analysis) {
      // Its analysis used audio that was not kept, so it is saved as it was rather than reanalyzed
      // from the transcript alone.
      await saveRecoveredCapture(checkpoint, checkpoint.analysis, capture.key, release);
      return;
    }
    startedAtRef.current = new Date(checkpoint.startedAt);
    activeSessionIdRef.current = null;
    samplesRef.current = [];
    capturedSampleCountRef.current = 0;
    // The audio is gone, but the capture's provenance and speaker declaration still apply.
    captureDescriptorRef.current = checkpoint.recording;
    resetChunkTranscription();
    // The recovered transcript keeps the model that produced it.
    transcriptModelRef.current = checkpoint.transcription ?? null;
    transcriptProvenanceRef.current = null;
    sessionLanguageRef.current = checkpoint.language;
    loadedSessionRef.current = null;
    setViewedSession(null);
    takeWorkspaceCapture(checkpoint.id, release);
    setSegments(checkpoint.segments);
    setPauses(checkpoint.pauses);
    setReport(emptyReport());
    setReportRun(null);
    setInterimText("");
    setSpeakerMatch(null);
    setMessage(
      "Recovered the interrupted recording's transcript; its audio was not kept. Save it to keep it.",
    );
  }

  async function saveRecoveredCapture(
    checkpoint: CaptureCheckpoint,
    analysis: NonNullable<CaptureCheckpoint["analysis"]>,
    key: string,
    release: () => void,
  ) {
    // The workspace as recovery left it; opening a session or starting a capture changes it.
    const workspaceAtStart = workspaceGenerationRef.current;
    const session = createSessionRecord({
      id: checkpoint.id,
      recordings: checkpoint.recording ? [checkpoint.recording] : [],
      startedAt: checkpoint.startedAt,
      segments: checkpoint.segments,
      pauses: checkpoint.pauses,
      report: analysis.report,
      run: analysis.run,
      context: {
        spokenLanguage: canonicalSpokenLanguage(checkpoint.language),
        task: null,
        condition: null,
      },
    });
    // The checkpoint and its claim stay until the browser write succeeded under the lock.
    const outcome = await serializeSessionMutation(async () => {
      if (sessionsRef.current.some((candidate) => candidate.id === session.id)) {
        removeCaptureCheckpoint(key);
        release();
        return "already-saved" as const;
      }
      try {
        persistSessions([session, ...sessionsRef.current].slice(0, 50));
      } catch {
        release();
        setInterruptedCaptures((current) =>
          mergeInterruptedCaptures(current, [{ key, kind: "checkpoint", checkpoint }]),
        );
        return "failed" as const;
      }
      removeCaptureCheckpoint(key);
      release();
      // A capture, recording or opened session may have taken the workspace while this save waited.
      if (
        !captureIdRef.current &&
        !startPendingRef.current &&
        !isRecordingRef.current &&
        workspaceGenerationRef.current === workspaceAtStart
      ) {
        setInterimText("");
        setSpeakerMatch(null);
        resetChunkTranscription();
        showSavedSession(session);
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(session));
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
      }
      return "saved" as const;
    });
    setMessage(
      outcome === "failed"
        ? "Could not save the recovered recording: browser storage is full or unavailable"
        : outcome === "already-saved"
          ? "This recording was already saved"
          : "Recovered and saved the interrupted recording; its audio was not kept.",
    );
  }

  async function discardInterruptedCapture(capture: InterruptedCapture) {
    if (
      !window.confirm(
        "Discard the interrupted recording? Its transcript cannot be recovered afterwards.",
      )
    ) {
      return;
    }
    const release = await claimCapture(capture.key.slice(CAPTURE_CHECKPOINT_PREFIX.length));
    if (!release) {
      setMessage("This recording is open in another window");
      return;
    }
    const removed = removeCaptureCheckpoint(capture.key);
    release();
    if (!removed) {
      setMessage("Could not discard the interrupted recording: browser storage is unavailable");
      return;
    }
    dropInterruptedCapture(capture.key);
    setMessage("Interrupted recording discarded");
  }

  async function deleteSession(session: SavedSession) {
    setDeletingSessionId(session.id);
    try {
      const corpus = await serializeSessionMutation(async () => {
        // A checkpoint of this capture that outlived its save would bring it back as an
        // interrupted recording, so deletion stops while it cannot be removed.
        if (!removeCaptureCheckpoint(captureCheckpointKey(session.id))) {
          throw new Error("its unsaved copy in browser storage could not be removed");
        }
        dropInterruptedCapture(captureCheckpointKey(session.id));
        try {
          await deleteSessionAudio(session.id);
        } catch (error) {
          throw new Error(`its kept audio could not be removed (${errorMessage(error)})`);
        }
        if (viewedSessionRef.current?.id === session.id) setViewedAudio(null);
        const remainingSessions = sessionsRef.current.filter(
          (candidate) => candidate.id !== session.id,
        );
        // A review copy was never in the desktop corpus; its figures stay as they are.
        const analysis = session.reviewCopy
          ? isDesktopApp()
            ? await loadSpeechCorpus(ownSessions(remainingSessions)).catch(() =>
                analyzeLocalCorpus(remainingSessions),
              )
            : analyzeLocalCorpus(remainingSessions)
          : await deleteSpeechCorpusSession(session.id, remainingSessions);
        const next = sessionsRef.current.filter((candidate) => candidate.id !== session.id);
        persistSessions(next);
        if (activeSessionIdRef.current === session.id) {
          startedAtRef.current = null;
          samplesRef.current = [];
          capturedSampleCountRef.current = 0;
          captureDescriptorRef.current = null;
          setSegments([]);
          setPauses([]);
          setReport(emptyReport());
          setReportRun(null);
          sessionLanguageRef.current = null;
          loadedSessionRef.current = null;
          setViewedSession(null);
          setInterimText("");
          setSpeakerMatch(null);
          resetChunkTranscription();
          transcriptProvenanceRef.current = null;
          activeSessionIdRef.current = null;
        }
        return analysis;
      });
      setCorpusAnalysis(corpus);
      setMessage("Session deleted");
    } catch (error) {
      setMessage(`Delete failed: ${errorMessage(error)}`);
    } finally {
      setDeletingSessionId(null);
    }
  }

  /**
   * Replaces every saved session with a validated backup (vox#86 (a)). Runs after every queued
   * save/delete/annotation mutation, writes browser storage first and, on desktop, replaces the
   * native speech corpus too; a failure leaves both stores as they were.
   */
  function restoreSessions(restored: SavedSession[]): Promise<void> {
    // The gate covers the queued wait too: a save accepted before the restore starts would write
    // browser storage that the restore then overwrites.
    // Counted, so a failed restore does not reopen saves while another one is still queued.
    restorePendingRef.current += 1;
    const operation = serializeSessionMutation(() => applyRestore(restored));
    void operation.then(
      () => undefined,
      () => {
        restorePendingRef.current -= 1;
      },
    );
    return operation;
  }

  async function applyRestore(restored: SavedSession[]) {
    // Backups never contain audio, so a restore replaces kept audio with none. Removed first, in
    // one transaction: if it fails, nothing has been replaced.
    try {
      await retainSessionAudio([]);
    } catch (error) {
      throw new Error(`audio kept for review could not be removed: ${errorMessage(error)}`);
    }
    setViewedAudio(null);
    // The native corpus is replaced first, so browser storage (shared with other windows) never
    // holds a restore that could still fail; a native failure therefore changes nothing.
    if (isDesktopApp()) {
      try {
        await invoke("replace_speech_corpus_sessions", { sessions: ownSessions(restored) });
      } catch (error) {
        throw new Error(`the desktop corpus could not be replaced: ${errorMessage(error)}`);
      }
    }
    try {
      replaceStoredSessions(restored);
    } catch (error) {
      // Browser storage refused the write (quota, blocked storage): put the native corpus back to
      // this window's sessions, which it mirrored before the restore.
      if (isDesktopApp()) {
        try {
          await invoke("replace_speech_corpus_sessions", {
            sessions: ownSessions(sessionsRef.current),
          });
        } catch (rollbackError) {
          throw new Error(
            `browser storage refused the restore (${errorMessage(error)}) and the desktop corpus could not be put back (${errorMessage(rollbackError)}); it now holds the backup's sessions, so restore the same backup again once storage has room`,
          );
        }
      }
      throw error;
    }
    // Mutations queued behind the restore must see the restored set.
    sessionsRef.current = restored;
    setSessions(restored);
  }

  async function exportJson(passphrase: string | null) {
    const backup = { sessions, speakers, corpus: corpusAnalysis };
    if (!passphrase) {
      downloadJsonFile("stutter-tracker-export.json", backup);
      return;
    }
    // Only the envelope becomes a Blob; the plaintext stays an in-memory string.
    const envelope = await encryptBackup(JSON.stringify(backup), passphrase);
    downloadFile("stutter-tracker-export.encrypted.json", envelope);
  }

  async function exportCorpusJson() {
    const corpus = await loadSpeechCorpusExport(sessions);
    downloadJsonFile("stutter-tracker-corpus.json", {
      exportedAt: new Date().toISOString(),
      corpus,
      analysis: corpusAnalysis,
    });
  }

  function downloadJsonFile(filename: string, value: unknown) {
    downloadFile(filename, JSON.stringify(value, null, 2));
  }

  function downloadFile(filename: string, payload: string) {
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function updateTranscriptionEngine(engine: TranscriptionEngineId) {
    const nextEngine = getTranscriptionEngine(engine);
    const next = {
      ...transcription,
      engine,
      model: nextEngine.models[0],
    };
    setTranscription(next);
    localStorage.setItem(TRANSCRIPTION_KEY, JSON.stringify(next));
  }

  function updateTranscriptionModel(model: string) {
    const next = { ...transcription, model };
    setTranscription(next);
    localStorage.setItem(TRANSCRIPTION_KEY, JSON.stringify(next));
  }

  function updateTranscriptionDevice(device: TranscriptionDevicePreference) {
    const next = { ...transcription, device };
    setTranscription(next);
    localStorage.setItem(TRANSCRIPTION_KEY, JSON.stringify(next));
  }

  async function fetchModelStatuses() {
    await queryClient.invalidateQueries({
      queryKey: ["transcription-models", transcription.engine],
    });
  }

  async function ensureSelectedModelReady(settings: TranscriptionSettings) {
    let status = modelStatusesQuery.data?.find((model) => model.id === settings.model);
    if (!status) {
      try {
        const models = await loadTranscriptionModels(settings.engine);
        status = models.find((model) => model.id === settings.model);
      } catch {
        status = modelStatuses.find((model) => model.id === settings.model);
      }
    }
    if (!status || status.cached || !status.downloadable) {
      return true;
    }
    setMessage(`Preparing ${settings.model}`);
    return downloadModel(settings.model, settings.engine);
  }

  async function downloadModel(model: string, engine = transcription.engine) {
    const key = `${engine}:${model}`;
    if (modelDownloadKeyRef.current === key && modelDownloadPromiseRef.current) {
      return modelDownloadPromiseRef.current;
    }
    setDownloadingModel(model);
    setDownloadProgress({
      phase: "downloading",
      message: `Downloading \`${model}\``,
      model,
      progress: 0,
    });
    setMessage(`Downloading ${model}`);
    const promise = downloadModelMutation
      .mutateAsync({ engine, model })
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        if (modelDownloadKeyRef.current === key) {
          modelDownloadKeyRef.current = null;
          modelDownloadPromiseRef.current = null;
        }
      });
    modelDownloadKeyRef.current = key;
    modelDownloadPromiseRef.current = promise;
    return promise;
  }

  function resetChunkTranscription() {
    cancelLiveTranscript();
    transcriptionRunIdRef.current += 1;
    transcriptModelRef.current = null;
    nextChunkStartSampleRef.current = 0;
    chunkIndexRef.current = 0;
    queuedTranscriptionTasksRef.current = 0;
    chunkResultsRef.current = { completed: 0, failed: 0 };
    chunkTranscriptionTailRef.current = Promise.resolve();
    setChunkStats(emptyChunkStats());
    setTranscriptionChunks([]);
    setIsTranscribing(false);
  }

  function enqueueAvailableTranscriptionChunks(forceFinal: boolean) {
    const settings = recordingTranscriptionRef.current;
    if (!settings || settings.engine === "browser") {
      return;
    }
    const sampleRate = sampleRateRef.current;
    for (const { startSample, endSample } of planAvailableChunks({
      totalSamples: samplesRef.current.length,
      nextStartSample: nextChunkStartSampleRef.current,
      sampleRate,
      chunkSeconds: TRANSCRIPTION_CHUNK_SECONDS,
      forceFinal,
    })) {
      nextChunkStartSampleRef.current = endSample;
      enqueueTranscriptionChunk(
        samplesRef.current.slice(startSample, endSample),
        sampleRate,
        startSample / sampleRate,
        settings,
        recordingLanguageRef.current,
      );
      if (forceFinal) {
        return;
      }
    }
  }

  function enqueueTranscriptionChunk(
    chunkSamples: number[],
    sampleRate: number,
    offsetSeconds: number,
    settings: TranscriptionSettings,
    language: string,
  ) {
    const runId = transcriptionRunIdRef.current;
    const liveRunId = liveTranscriptRef.current.runId;
    const chunkNumber = ++chunkIndexRef.current;
    const durationSeconds = chunkSamples.length / sampleRate;
    queuedTranscriptionTasksRef.current += 1;
    setIsTranscribing(true);
    setTranscriptionChunks((current) => [
      ...current,
      {
        id: chunkNumber,
        startSeconds: offsetSeconds,
        endSeconds: offsetSeconds + durationSeconds,
        durationSeconds,
        status: "queued",
        transcript: "",
        segmentCount: 0,
      },
    ]);
    setChunkStats((current) => ({
      ...current,
      queued: current.queued + 1,
      lastMessage: `Queued chunk ${chunkNumber}`,
    }));

    const task = async () => {
      if (runId !== transcriptionRunIdRef.current) {
        return;
      }
      setChunkStats((current) => ({
        ...current,
        queued: Math.max(0, current.queued - 1),
        processing: current.processing + 1,
        lastMessage: `Transcribing chunk ${chunkNumber}`,
      }));
      setTranscriptionChunks((current) =>
        updateTranscriptionChunk(current, chunkNumber, { status: "processing" }),
      );
      setMessage(`Transcribing chunk ${chunkNumber}`);
      try {
        const transcriptionSamples = resampleSamples(
          chunkSamples,
          sampleRate,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
        );
        const result = await transcribeAudio(
          transcriptionSamples,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          settings,
          language,
        );
        if (runId !== transcriptionRunIdRef.current) {
          return;
        }
        transcriptModelRef.current = {
          engine: result.provider ?? settings.engine,
          model: result.model ?? settings.model,
        };
        transcriptProvenanceRef.current = transcriptProvenance({
          engine: result.provider ?? settings.engine,
          model: result.model ?? settings.model,
          language,
          detectedLanguage: result.language ?? null,
          preprocessing: provisionalPreprocessing(settings.engine, sampleRate),
          compute: result.compute,
        });
        if (result.compute) setLastCompute(result.compute);
        const chunkSegments = await identifyTranscriptSpeakers(
          result.segments,
          transcriptionSamples,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          speakersRef.current,
        );
        const offsetSegments = offsetTranscriptSegments(chunkSegments, offsetSeconds);
        const chunkTranscript = offsetSegments
          .map((segment) => segment.text)
          .join(" ")
          .trim();
        applyLiveUpdate({
          kind: "final",
          runId: liveRunId,
          unitId: `chunk:${chunkNumber}`,
          segments: markUnalignedTiming(offsetSegments),
        });
        chunkResultsRef.current.completed += 1;
        setTranscriptionChunks((current) =>
          updateTranscriptionChunk(current, chunkNumber, {
            status: "completed",
            transcript: chunkTranscript,
            segmentCount: offsetSegments.length,
            error: undefined,
          }),
        );
        setChunkStats((current) => ({
          ...current,
          completed: current.completed + 1,
          lastMessage: `Completed chunk ${chunkNumber}`,
        }));
      } catch (error) {
        const message = errorMessage(error);
        chunkResultsRef.current.failed += 1;
        setTranscriptionChunks((current) =>
          updateTranscriptionChunk(current, chunkNumber, {
            status: "failed",
            error: message,
          }),
        );
        setChunkStats((current) => ({
          ...current,
          failed: current.failed + 1,
          lastMessage: `Chunk ${chunkNumber} failed: ${message}`,
        }));
        setMessage(`Chunk ${chunkNumber} failed: ${message}`);
        // A model that went missing since its last check must not keep showing as ready.
        void queryClient.invalidateQueries({ queryKey: ["transcription-models", settings.engine] });
      } finally {
        queuedTranscriptionTasksRef.current = Math.max(0, queuedTranscriptionTasksRef.current - 1);
        setChunkStats((current) => ({
          ...current,
          processing: Math.max(0, current.processing - 1),
        }));
        if (queuedTranscriptionTasksRef.current === 0) {
          setIsTranscribing(false);
        }
      }
    };

    chunkTranscriptionTailRef.current = chunkTranscriptionTailRef.current
      .catch(() => undefined)
      .then(task);
  }

  if (blindReview) {
    const blindSession = sessions.find((session) => session.id === blindReview.sessionId) ?? null;
    return (
      <main className="mx-auto min-h-screen max-w-[1420px] bg-[#f5f7f5] p-5 text-[#17201b] max-sm:p-3">
        <BlindReview
          sessions={sessions}
          selectedId={blindSession?.id ?? null}
          message={message}
          onSelect={(sessionId) => setBlindReview({ sessionId })}
          onExit={() => {
            setBlindReview(null);
            setMessage("Blind review ended");
          }}
        >
          {blindSession && (
            <AnnotationWorkbench
              key={blindSession.id}
              session={blindSession}
              audio={viewedAudio?.sessionId === blindSession.id ? viewedAudio : null}
              blind
              disabled={captureInProgress}
              onSave={(request) => saveAnnotation(blindSession.id, request)}
            />
          )}
        </BlindReview>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-[1420px] bg-[#f5f7f5] p-5 text-[#17201b] max-sm:p-3">
      <DashboardHeader
        isFinishingCapture={isFinishingCapture}
        engines={TRANSCRIPTION_ENGINES}
        languages={LANGUAGES}
        transcription={transcription}
        selectedModels={selectedModels}
        language={language}
        isNative={isNative}
        isRecording={isRecording}
        processingDestination={
          isNative
            ? { kind: "onDevice", label: "On this device (desktop app)" }
            : computeClient.destination
        }
        onRemoteConsentChange={(granted) => {
          if (computeClient.destination.kind === "onDevice") return;
          saveRemoteConsent(CONSENT_SERVER_URL, granted);
          window.location.reload();
        }}
        onEngineChange={updateTranscriptionEngine}
        onModelChange={updateTranscriptionModel}
        onDeviceChange={updateTranscriptionDevice}
        lastCompute={lastCompute}
        onLanguageChange={setLanguage}
        onRecordingToggle={isRecording ? stopRecording : startRecording}
        soloSpeaker={soloSpeaker}
        onSoloSpeakerChange={setSoloSpeaker}
      />

      <StatusMetrics report={report} speechStats={speechStats} blockerStats={blockerStats} />

      {interruptedCaptures.map((capture) => (
        <InterruptedCaptureNotice
          key={capture.key}
          capture={capture}
          recoverDisabled={captureInProgress}
          onRecover={() => void recoverInterruptedCapture(capture)}
          onDiscard={() => void discardInterruptedCapture(capture)}
        />
      ))}

      <section className="mb-4 flex items-stretch gap-4 max-lg:flex-col">
        <RecordingWorkspace
          isNative={isNative}
          message={message}
          speakersCount={speakers.length}
          speakerMatch={speakerMatch}
          isRecording={isRecording}
          isTranscribing={isTranscribing}
          isAnalyzing={isAnalyzing}
          isEnrolling={isEnrolling}
          isMatchingVoice={isMatchingVoice}
          downloadingModel={downloadingModel}
          downloadProgress={downloadProgress}
          selectedModelStatus={selectedModelStatus}
          chunkStats={chunkStats}
          chunkProgress={chunkProgress}
          transcriptionChunks={transcriptionChunks}
          hasAnalysisEvents={report.events.length > 0}
          level={level}
          transcript={transcript}
          transcriptSegments={segments}
          readableTranscript={readable}
          interimText={interimText}
          canEnroll={samplesRef.current.length > 0}
          onEnroll={saveSpeakerProfile}
          onSave={saveSession}
          keepAudio={keepAudio}
          onKeepAudioChange={
            !viewedSession && captureDescriptorRef.current && samplesRef.current.length > 0
              ? setKeepAudio
              : undefined
          }
          saveDisabled={captureInProgress || isAnalyzing}
          storageWarning={checkpointError ?? claimError}
          onExport={() => setExportDialogOpen(true)}
          savedSessionCount={sessions.length}
          onRestoreSessions={restoreSessions}
        />

        <InsightsSidebar
          todayStats={todayStats}
          report={report}
          speechStats={speechStats}
          blockerStats={blockerStats}
          selectedEngine={selectedEngine}
          selectedModel={transcription.model}
          selectedModelStatus={selectedModelStatus}
          modelStatuses={modelStatuses}
          corpusAnalysis={corpusAnalysis}
          unverifiedSessionCount={unverifiedSessionCount}
          speakers={speakers}
          failedSpeakerDeletions={failedSpeakerDeletions}
          pendingSpeakerDeletionIds={pendingSpeakerDeletionIds}
          onSpeakerDeletionRetry={(speaker) => void deleteSpeakerRemotely(speaker)}
          speakerLabel={speakerLabel}
          canEnroll={samplesRef.current.length > 0}
          isRecording={isRecording}
          isTranscribing={isTranscribing}
          downloadingModel={downloadingModel}
          isDownloadPending={downloadModelMutation.isPending}
          onModelSelect={updateTranscriptionModel}
          onModelDownload={(model) => downloadModel(model)}
          onSpeakerLabelChange={setSpeakerLabel}
          onSpeakerRemove={
            speakersReady ? (speaker) => void removeSpeakerProfile(speaker) : undefined
          }
          onEnroll={saveSpeakerProfile}
          onCorpusExport={exportCorpusJson}
        />
      </section>

      <LowerDashboard
        report={report}
        segments={segments}
        intentPredictions={intentPredictions}
        analyzedChunks={analyzedChunks}
        blockerStats={blockerStats}
        sessions={sessions}
        deletingSessionId={deletingSessionId}
        sessionLoadDisabled={captureInProgress}
        onSessionLoad={(session) => {
          // Live capture would keep appending to the loaded transcript.
          if (captureInProgress) {
            return;
          }
          if (workspaceClaimPendingRef.current || !canSetAsideWorkspaceCapture()) {
            return;
          }
          setAsideUnsavedCapture();
          showSavedSession(session);
        }}
        onSessionDelete={(session) => void deleteSession(session)}
        onSessionReanalyze={(session) => void reanalyzeSavedSession(session)}
        reanalyzingSessionIds={reanalyzingSessionIds}
      />
      {sessions.length > 0 && (
        <section className="mb-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={captureInProgress}
            onClick={() => {
              setMessage("");
              setBlindReview({ sessionId: null });
            }}
          >
            Start blind review
          </button>
          <span className="text-sm text-[#647169]">
            Annotate saved sessions without seeing their analysis, dates or conditions.
          </span>
        </section>
      )}
      {viewedSession && (
        <AnnotationWorkbench
          key={viewedSession.id}
          session={viewedSession}
          audio={viewedAudio?.sessionId === viewedSession.id ? viewedAudio : null}
          disabled={captureInProgress}
          onSave={(request) => saveAnnotation(viewedSession.id, request)}
        />
      )}
      {viewedSession && !viewedSession.reviewCopy && (
        <TranscriptRevisionsPanel
          key={`transcripts-${viewedSession.id}`}
          session={viewedSession}
          referenceAvailable={isNative || computeClient.destination.kind !== "onDevice"}
          pending={referencePendingIds.includes(viewedSession.id)}
        />
      )}
      <ValidationPanel
        sessions={sessions}
        session={viewedSession}
        disabled={captureInProgress}
        onDeclare={declareSessionValidation}
        onAdjudicate={saveAdjudication}
      />
      <SessionComparisonPanel
        sessions={ownSessions(sessions)}
        session={viewedSession}
        disabled={captureInProgress}
        onTag={tagContext}
      />
      <AnnotationExchangePanel
        session={viewedSession}
        audio={viewedAudio?.sessionId === viewedSession?.id ? viewedAudio : null}
        onImport={importAnnotationFile}
      />
      <EvidenceExportPanel sessions={ownSessions(sessions)} />
      {exportDialogOpen && (
        <ExportBackupDialog onClose={() => setExportDialogOpen(false)} onDownload={exportJson} />
      )}
    </main>
  );
}

async function analyze(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
}): Promise<AnalyzedSpeech> {
  if (!isDesktopApp()) {
    return computeClient.analyzeSpeechSessionRun(request);
  }
  const report = await invoke<AnalysisReport & { analyzerVersion?: string }>(
    "analyze_speech_session",
    { request },
  );
  return { report, analyzer: desktopAnalyzer(report.analyzerVersion) };
}

/** The desktop command reports its detector version; older desktop builds leave it unknown. */
export function desktopAnalyzer(version: string | undefined): AnalyzerIdentity {
  return {
    producer: "desktopNative",
    algorithm: "analyze_speech_session",
    version: version ?? null,
  };
}

async function analyzeWithFallback(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
}): Promise<
  AnalyzedSpeech & {
    usedAudio: boolean;
    inputId: string;
    audioId: string | null;
    runId: string;
    createdAt: string;
  }
> {
  const usedAudio = Boolean(request.samples?.length && request.sampleRate);
  // Minted here, where the analyzer actually runs, so a cached result keeps its identity.
  const provenance = {
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    usedAudio,
    audioId:
      usedAudio && request.samples && request.sampleRate
        ? audioFingerprint(request.samples, request.sampleRate)
        : null,
    inputId: observationFingerprint(request.segments, request.pauses),
  };
  // An on-device analysis (the compute client's own fallback, or this one) measures the analyzed
  // audio window with the WASM kernel; without a kernel the run stays unmeasured. Metrics reported
  // by the desktop app or a compute server are kept as they are.
  const measuredOnDevice = async ({
    report,
    analyzer,
  }: AnalyzedSpeech): Promise<AnalyzedSpeech> => {
    if (
      analyzer.producer !== ON_DEVICE_ANALYZER.producer ||
      report.captureMetrics ||
      !usedAudio ||
      !request.samples ||
      !request.sampleRate
    ) {
      return { report, analyzer };
    }
    const captureMetrics = await measureCaptureOnDevice(request.samples, request.sampleRate);
    return { report: captureMetrics ? { ...report, captureMetrics } : report, analyzer };
  };
  let analyzed: AnalyzedSpeech;
  try {
    analyzed = await analyze(request);
  } catch {
    analyzed = { report: fallbackAnalyze(request), analyzer: ON_DEVICE_ANALYZER };
  }
  return { ...(await measuredOnDevice(analyzed)), ...provenance };
}

export type IntentPredictionRequest = {
  segments: TranscriptSegment[];
  sessions: SavedSession[];
  events: StutterEvent[];
  partialText: string;
  maxContexts: number;
  maxPredictions: number;
  phraseTokens: number;
};

async function predictSpeakerIntentWithFallback(
  request: IntentPredictionRequest,
): Promise<SpeakerIntentPrediction[]> {
  try {
    return await predictSpeakerIntent(request);
  } catch {
    return fallbackPredictSpeakerIntent(request);
  }
}

async function predictSpeakerIntent(
  request: IntentPredictionRequest,
): Promise<SpeakerIntentPrediction[]> {
  if (!isDesktopApp()) {
    return fallbackPredictSpeakerIntent(request);
  }
  return invoke<SpeakerIntentPrediction[]>("predict_speaker_intent", { request });
}

async function createSpeakerProfile(
  id: string | undefined,
  label: string,
  samples: number[],
  sampleRate: number,
): Promise<SpeakerProfile> {
  if (!isDesktopApp()) {
    return computeClient.createSpeakerProfile({ id, label, samples, sampleRate });
  }
  return invoke<SpeakerProfile>("create_speaker_profile", {
    request: { id, label, samples: decimate(samples), sampleRate },
  });
}

async function identifySpeaker(
  samples: number[],
  sampleRate: number,
  speakers: SpeakerProfile[],
): Promise<SpeakerIdentification> {
  if (!speakers.length) {
    return { matches: [], isMatch: false };
  }
  if (!isDesktopApp()) {
    return computeClient.identifySpeaker({
      samples,
      sampleRate,
      speakers,
      threshold: 0.82,
      maxResults: 3,
    });
  }
  return invoke<SpeakerIdentification>("identify_speaker", {
    request: {
      samples: decimate(samples),
      sampleRate,
      speakers,
      threshold: 0.82,
      maxResults: 3,
    },
  });
}

async function identifyTranscriptSpeakers(
  segments: TranscriptSegment[],
  samples: number[],
  sampleRate: number,
  speakers: SpeakerProfile[],
) {
  if (!speakers.length) {
    return segments;
  }
  return Promise.all(
    segments.map(async (segment) => {
      const start = Math.max(0, Math.floor(segment.startSeconds * sampleRate));
      const end = Math.min(samples.length, Math.ceil(segment.endSeconds * sampleRate));
      if (end - start < sampleRate / 4) {
        return segment;
      }
      try {
        const result = await identifySpeaker(samples.slice(start, end), sampleRate, speakers);
        const match = result.bestMatch;
        if (!match) {
          return segment;
        }
        return {
          ...segment,
          speakerId: match.speakerId,
          speakerLabel: match.label,
          speakerScore: match.score,
        };
      } catch {
        return segment;
      }
    }),
  );
}

async function loadTranscriptionModels(
  engine: TranscriptionEngineId,
): Promise<TranscriptionModelStatus[]> {
  if (!isDesktopApp()) {
    return computeClient.transcriptionModels(engine);
  }
  const result = await invoke<{ models: TranscriptionModelStatus[] }>("transcription_models", {
    request: { provider: engine },
  });
  return result.models;
}

async function transcribeAudio(
  samples: number[],
  sampleRate: number,
  settings: TranscriptionSettings,
  language: string,
): Promise<{
  segments: TranscriptSegment[];
  provider?: TranscriptionEngineId;
  model?: string;
  language?: string | null;
  compute?: TranscriptCompute;
}> {
  if (!isDesktopApp()) {
    return computeClient.transcribeAudio({
      samples,
      sampleRate,
      provider: settings.engine,
      model: settings.model,
      language,
      device: settings.device,
    });
  }
  return invoke<{
    segments: TranscriptSegment[];
    provider?: TranscriptionEngineId;
    model?: string;
    language?: string | null;
    compute?: TranscriptCompute;
  }>("transcribe_audio", {
    request: {
      samples,
      sampleRate,
      provider: settings.engine,
      model: settings.model,
      language,
      device: settings.device,
    },
  });
}

async function downloadTranscriptionModel(engine: TranscriptionEngineId, model: string) {
  if (!isDesktopApp()) {
    return computeClient.downloadTranscriptionModel(engine, model);
  }
  return invoke<TranscriptionModelStatus>("download_transcription_model", {
    request: {
      provider: engine,
      model,
    },
  });
}

/**
 * Loads the desktop corpus. Rows saved before the corpus kept capture quality get the verdict of
 * the matching saved session first, so a known-unknown capture does not count as unchecked.
 */
async function loadSpeechCorpus(sessions: SavedSession[]): Promise<SpeechCorpusAnalysis> {
  if (!isDesktopApp()) {
    throw new Error("desktop corpus is only available in the Tauri app");
  }
  const qualities = Object.fromEntries(
    sessions.flatMap((session) =>
      session.report.captureQuality ? [[session.id, session.report.captureQuality]] : [],
    ),
  );
  // The backend ships with this app, so the command exists. When it fails, the caller falls back to
  // the gated analysis of the saved sessions, never to ungated legacy rows.
  return Object.keys(qualities).length
    ? invoke<SpeechCorpusAnalysis>("backfill_speech_corpus_capture_quality", { qualities })
    : invoke<SpeechCorpusAnalysis>("load_speech_corpus");
}

/**
 * Counts desktop-corpus sessions whose analysis is not verified for their transcript: those
 * without stored provenance, and those whose `analysis.inputId` does not match the untouched
 * observation (`observedSegments` and `pauses`) the corpus keeps.
 */
export function countUnverifiedCorpusSessions(exported: unknown): number {
  const sessions =
    exported &&
    typeof exported === "object" &&
    Array.isArray((exported as { sessions?: unknown }).sessions)
      ? ((exported as { sessions: unknown[] }).sessions as Record<string, unknown>[])
      : [];
  return sessions.filter((session) => {
    const analysis = session.analysis as { inputId?: unknown } | undefined;
    if (!analysis || !Array.isArray(session.observedSegments) || !Array.isArray(session.pauses)) {
      return true;
    }
    return (
      analysis.inputId !==
      observationFingerprint(
        session.observedSegments as TranscriptSegment[],
        session.pauses as PauseSpan[],
      )
    );
  }).length;
}

async function loadSpeechCorpusExport(sessions: SavedSession[]) {
  if (!isDesktopApp()) {
    return localSpeechCorpusExport(sessions);
  }
  try {
    return await invoke<unknown>("export_speech_corpus");
  } catch {
    return localSpeechCorpusExport(sessions);
  }
}

/** Sessions of this user's own speech: every saved session except review copies. */
function ownSessions(sessions: SavedSession[]) {
  return sessions.filter((session) => !session.reviewCopy);
}

async function saveSpeechCorpusSession(session: SavedSession): Promise<SpeechCorpusAnalysis> {
  if (session.reviewCopy) {
    throw new Error("review copies are not part of the speech corpus");
  }
  if (!isDesktopApp()) {
    throw new Error("desktop corpus is only available in the Tauri app");
  }
  return invoke<SpeechCorpusAnalysis>("save_speech_corpus_session", { session });
}

async function deleteSpeechCorpusSession(
  sessionId: string,
  remainingSessions: SavedSession[],
): Promise<SpeechCorpusAnalysis> {
  if (!isDesktopApp()) {
    return analyzeLocalCorpus(remainingSessions);
  }
  return invoke<SpeechCorpusAnalysis>("delete_speech_corpus_session", { sessionId });
}

export function fallbackAnalyze(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
}): AnalysisReport {
  return sharedFallbackAnalyze(request) as AnalysisReport;
}

function emptySpeechStats(): SpeechStats {
  return {
    speakingDurationSeconds: 0,
    pauseDurationSeconds: 0,
    wordsPerMinute: 0,
    articulationRateWpm: 0,
    meanChunkWords: 0,
    meanChunkDurationSeconds: 0,
    eventDensityPer100Words: 0,
    fluencyPercentage: 100,
  };
}

function emptyBlockerStats(): BlockerStats {
  return {
    blockCount: 0,
    totalBlockSeconds: 0,
    averageBlockSeconds: 0,
    longestBlockSeconds: 0,
    blocksPerMinute: 0,
    blockedTimePercentage: 0,
  };
}

function decimate(samples: number[]) {
  const maxSamples = 96_000;
  if (samples.length <= maxSamples) {
    return samples;
  }
  const step = Math.ceil(samples.length / maxSamples);
  const result: number[] = [];
  for (let index = 0; index < samples.length; index += step) {
    result.push(samples[index]);
  }
  return result;
}

function analysisAudioPayload(samples: number[], sampleRate: number) {
  if (!samples.length || sampleRate <= 0) {
    return {};
  }
  const maxSourceSamples = Math.floor(sampleRate * 90);
  const capped = samples.slice(Math.max(0, samples.length - maxSourceSamples));
  return {
    samples: resampleSamples(capped, sampleRate, TRANSCRIPTION_TARGET_SAMPLE_RATE),
    sampleRate: TRANSCRIPTION_TARGET_SAMPLE_RATE,
  };
}

export const resampleSamples = sharedResampleSamples;

export function offsetTranscriptSegments(
  segments: TranscriptSegment[],
  offsetSeconds: number,
): TranscriptSegment[] {
  return segments.map((segment) => ({
    ...segment,
    startSeconds: segment.startSeconds + offsetSeconds,
    endSeconds: segment.endSeconds + offsetSeconds,
  }));
}

function updateTranscriptionChunk(
  chunks: TranscriptionChunkRecord[],
  id: number,
  patch: Partial<TranscriptionChunkRecord>,
) {
  return chunks.map((chunk) => (chunk.id === id ? { ...chunk, ...patch } : chunk));
}

export function summarizeTranscriptionChunks(
  chunks: Pick<TranscriptionChunkRecord, "status">[],
): TranscriptionChunkSummary {
  return chunks.reduce<TranscriptionChunkSummary>(
    (summary, chunk) => {
      summary.total += 1;
      summary[chunk.status] += 1;
      return summary;
    },
    {
      total: 0,
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    },
  );
}

type LocalMarkov = {
  order: number;
  transitions: Map<string, Map<string, number>>;
};

type IntentCandidate = Omit<SpeakerIntentPrediction, "id" | "confidence" | "suggestions"> & {
  tokens: string[];
};

export function fallbackPredictSpeakerIntent(
  request: IntentPredictionRequest,
): SpeakerIntentPrediction[] {
  const orderTwo = createLocalMarkov(2);
  const orderOne = createLocalMarkov(1);
  for (const document of intentTrainingDocuments(request)) {
    trainLocalMarkov(orderTwo, document);
    trainLocalMarkov(orderOne, document);
  }

  const predictions: SpeakerIntentPrediction[] = [];
  const seen = new Set<string>();
  for (const candidate of intentCandidates(request).slice(0, request.maxContexts * 2)) {
    const suggestions =
      predictLocalIntent(
        orderTwo,
        candidate.tokens,
        request.maxPredictions,
        request.phraseTokens,
      ) ||
      predictLocalIntent(orderOne, candidate.tokens, request.maxPredictions, request.phraseTokens);
    if (!suggestions?.length) {
      continue;
    }
    const key = `${candidate.reason}:${candidate.contextText}:${candidate.triggerText ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    predictions.push({
      id: `intent-${predictions.length + 1}`,
      reason: candidate.reason,
      contextText: candidate.contextText,
      triggerText: candidate.triggerText,
      startSeconds: candidate.startSeconds,
      endSeconds: candidate.endSeconds,
      speakerId: candidate.speakerId,
      speakerLabel: candidate.speakerLabel,
      confidence: Math.max(...suggestions.map((suggestion) => suggestion.probability)),
      suggestions,
    });
    if (predictions.length >= request.maxContexts) {
      break;
    }
  }
  return predictions;
}

function intentTrainingDocuments(request: IntentPredictionRequest) {
  return [...request.sessions.flatMap((session) => session.segments), ...request.segments]
    .filter((segment) => segment.isFinal)
    .map((segment) => segment.text.trim())
    .filter(Boolean);
}

function intentCandidates(request: IntentPredictionRequest): IntentCandidate[] {
  const candidates: IntentCandidate[] = [];
  const partialTokens = tokenizeIntentText(request.partialText);
  if (partialTokens.length) {
    const latestSegment = request.segments.at(-1);
    candidates.push({
      reason: "currentContext",
      contextText: intentContextText(partialTokens),
      tokens: partialTokens,
      triggerText: null,
      startSeconds: latestSegment?.endSeconds,
      endSeconds: latestSegment?.endSeconds,
      speakerId: latestSegment?.speakerId,
      speakerLabel: latestSegment?.speakerLabel,
    });
  }

  for (const event of [...request.events].reverse()) {
    const segment = nearestIntentSegment(request.segments, event.startSeconds, event.endSeconds);
    if (!segment) {
      continue;
    }
    const segmentTokens = tokenizeIntentText(segment.text);
    const eventTokens = tokenizeIntentText(event.text);
    const tokens =
      prefixForIntentEvent(segmentTokens, eventTokens) ??
      tokensBeforeIntentTime(request.segments, event.startSeconds);
    if (!tokens.length) {
      continue;
    }
    candidates.push({
      reason: intentReasonForKind(event.kind),
      contextText: intentContextText(tokens),
      tokens,
      triggerText: event.text,
      startSeconds: event.startSeconds,
      endSeconds: event.endSeconds,
      speakerId: segment.speakerId,
      speakerLabel: segment.speakerLabel,
    });
  }
  return candidates;
}

function createLocalMarkov(order: number): LocalMarkov {
  return { order, transitions: new Map() };
}

function trainLocalMarkov(model: LocalMarkov, text: string) {
  const tokens = tokenizeIntentText(text);
  for (let index = model.order; index < tokens.length; index += 1) {
    const key = markovKey(tokens.slice(index - model.order, index));
    const next = model.transitions.get(key) ?? new Map<string, number>();
    next.set(tokens[index], (next.get(tokens[index]) ?? 0) + 1);
    model.transitions.set(key, next);
  }
}

function predictLocalIntent(
  model: LocalMarkov,
  context: string[],
  limit: number,
  phraseTokens: number,
) {
  if (context.length < model.order) {
    return null;
  }
  const key = markovKey(context.slice(-model.order));
  const counts = model.transitions.get(key);
  if (!counts?.size) {
    return null;
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0) || 1;
  return [...counts.entries()]
    .map(([token, count]) => ({
      token,
      count,
      probability: count / total,
      phrase: generateLocalPhrase(model, [...context, token], context.length + phraseTokens)
        .slice(context.length)
        .join(" "),
    }))
    .sort((left, right) => right.count - left.count || left.token.localeCompare(right.token))
    .slice(0, limit);
}

function generateLocalPhrase(model: LocalMarkov, seed: string[], maxTokens: number) {
  const tokens = [...seed];
  while (tokens.length < maxTokens) {
    const counts = model.transitions.get(markovKey(tokens.slice(-model.order)));
    const next = bestLocalNext(counts);
    if (!next) {
      break;
    }
    tokens.push(next);
  }
  return tokens;
}

function bestLocalNext(counts?: Map<string, number>) {
  if (!counts?.size) {
    return null;
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]?.[0];
}

function markovKey(tokens: string[]) {
  return JSON.stringify(tokens);
}

function tokenizeIntentText(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

function nearestIntentSegment(
  segments: TranscriptSegment[],
  startSeconds: number,
  endSeconds: number,
) {
  return segments
    .filter((segment) => segment.isFinal)
    .sort(
      (left, right) =>
        distanceToIntentSpan(left, startSeconds, endSeconds) -
        distanceToIntentSpan(right, startSeconds, endSeconds),
    )[0];
}

function distanceToIntentSpan(
  segment: TranscriptSegment,
  startSeconds: number,
  endSeconds: number,
) {
  if (segment.startSeconds <= endSeconds && segment.endSeconds >= startSeconds) {
    return 0;
  }
  return segment.endSeconds < startSeconds
    ? startSeconds - segment.endSeconds
    : segment.startSeconds - endSeconds;
}

function prefixForIntentEvent(segmentTokens: string[], eventTokens: string[]) {
  if (!eventTokens.length) {
    return null;
  }
  for (let index = 0; index < segmentTokens.length; index += 1) {
    const matches = eventTokens.every((token, offset) => segmentTokens[index + offset] === token);
    if (matches) {
      return segmentTokens.slice(0, Math.min(segmentTokens.length, index + 1));
    }
  }
  return null;
}

function tokensBeforeIntentTime(segments: TranscriptSegment[], seconds: number) {
  return segments
    .filter((segment) => segment.isFinal && segment.endSeconds <= seconds)
    .flatMap((segment) => tokenizeIntentText(segment.text));
}

function intentContextText(tokens: string[]) {
  return tokens.slice(-5).join(" ");
}

function intentReasonForKind(kind: StutterEvent["kind"]): IntentCandidate["reason"] {
  const reasons = {
    block: "block",
    filler: "filler",
    wordRepetition: "repetition",
    soundRepetition: "repetition",
    prolongation: "prolongation",
  } as const;
  return reasons[kind];
}

function emptyReport(): AnalysisReport {
  return {
    totalDurationSeconds: 0,
    wordCount: 0,
    stutterCount: 0,
    stuttersPerMinute: 0,
    severity: "none",
    speechStats: emptySpeechStats(),
    blockerStats: emptyBlockerStats(),
    chunks: [],
    events: [],
    byKind: {},
  };
}

function emptyCorpusAnalysis(): SpeechCorpusAnalysis {
  return {
    stats: {
      sessions: 0,
      documents: 0,
      speakers: 0,
      totalDurationSeconds: 0,
      totalTerms: 0,
      uniqueTerms: 0,
      averageTermsPerDocument: 0,
      wordCount: 0,
      stutterCount: 0,
      stuttersPerMinute: 0,
      lexicalDiversity: 0,
      withheldSessions: 0,
    },
    text: {
      bytes: 0,
      chars: 0,
      words: 0,
      lines: 0,
      sentences: 0,
      uniqueTerms: 0,
    },
    readability: {
      sentenceCount: 0,
      wordCount: 0,
      averageSentenceWords: 0,
      averageWordChars: 0,
    },
    sentiment: {
      positiveScore: 0,
      negativeScore: 0,
      compound: 0,
      tokenCount: 0,
      matchedTerms: 0,
      label: "neutral",
    },
    linguistic: {
      tokenCount: 0,
      sentenceCount: 0,
      lemmaCount: 0,
      entityCount: 0,
      entities: [],
      topics: [],
      register: "Neutral",
      disfluencyMarkers: 0,
      questionCount: 0,
      exclamationCount: 0,
    },
    topTerms: [],
    keywords: [],
    summary: [],
    speakers: [],
  };
}

function localSpeechCorpusExport(sessions: SavedSession[]) {
  return {
    sessions: ownSessions(sessions).map((session) => ({
      id: session.id,
      startedAt: session.startedAt,
      segments: session.segments.filter((segment) => segment.isFinal && segment.text.trim()),
      totalDurationSeconds: session.report.totalDurationSeconds,
      wordCount: session.report.wordCount,
      stutterCount: session.report.stutterCount,
      stuttersPerMinute: session.report.stuttersPerMinute,
      // Exact counts of an unknown-quality capture stay qualified by their verdict.
      ...(session.report.captureQuality ? { captureQuality: session.report.captureQuality } : {}),
    })),
  };
}

function analyzeLocalCorpus(allSessions: SavedSession[]): SpeechCorpusAnalysis {
  // Review copies hold someone else's speech; they are not part of this user's corpus.
  const sessions = ownSessions(allSessions);
  const corpus = emptyCorpusAnalysis();
  const terms = new Map<string, { count: number; documents: Set<string> }>();
  const speakerTerms = new Map<string, Map<string, number>>();
  const speakerSummaries = new Map<
    string,
    { label: string; documents: number; words: number; duration: number; stutters: number }
  >();
  let documents = 0;
  let duration = 0;
  let scoredDuration = 0;
  let stutters = 0;
  let withheldSessions = 0;

  for (const session of sessions) {
    // A capture that failed the quality gate has no score; its counts stay out of the totals.
    const withheld = isScoreWithheld(session.report);
    const sessionStutters = withheld ? 0 : session.report.stutterCount;
    duration += session.report.totalDurationSeconds;
    if (withheld) {
      withheldSessions += 1;
    } else {
      scoredDuration += session.report.totalDurationSeconds;
    }
    stutters += sessionStutters;
    for (const [index, segment] of session.segments.entries()) {
      if (!segment.isFinal || !segment.text.trim()) {
        continue;
      }
      documents += 1;
      const documentId = `${session.id}:${index}`;
      const speakerKey = segment.speakerId ?? segment.speakerLabel ?? "Unknown speaker";
      const speakerLabel = segment.speakerLabel ?? segment.speakerId ?? "Unknown speaker";
      const words = corpusTerms(segment.text);
      const segmentStutters =
        session.report.wordCount > 0
          ? Math.round((sessionStutters * words.length) / session.report.wordCount)
          : 0;
      const speaker = speakerSummaries.get(speakerKey) ?? {
        label: speakerLabel,
        documents: 0,
        words: 0,
        duration: 0,
        stutters: 0,
      };
      speaker.documents += 1;
      speaker.words += words.length;
      speaker.duration += Math.max(0, segment.endSeconds - segment.startSeconds);
      speaker.stutters += segmentStutters;
      speakerSummaries.set(speakerKey, speaker);
      const perSpeaker = speakerTerms.get(speakerKey) ?? new Map<string, number>();
      speakerTerms.set(speakerKey, perSpeaker);
      for (const word of words) {
        const entry = terms.get(word) ?? { count: 0, documents: new Set<string>() };
        entry.count += 1;
        entry.documents.add(documentId);
        terms.set(word, entry);
        perSpeaker.set(word, (perSpeaker.get(word) ?? 0) + 1);
      }
    }
  }

  const totalTerms = [...terms.values()].reduce((sum, term) => sum + term.count, 0);
  corpus.stats = {
    sessions: sessions.length,
    documents,
    speakers: speakerSummaries.size,
    totalDurationSeconds: duration,
    totalTerms,
    uniqueTerms: terms.size,
    averageTermsPerDocument: documents ? totalTerms / documents : 0,
    wordCount: sessions.reduce((sum, session) => sum + session.report.wordCount, 0),
    stutterCount: stutters,
    stuttersPerMinute: stutters / Math.max(1 / 60, scoredDuration / 60),
    lexicalDiversity: totalTerms ? terms.size / totalTerms : 0,
    withheldSessions,
  };
  corpus.text.words = totalTerms;
  corpus.text.uniqueTerms = terms.size;
  corpus.topTerms = termEntries(terms, documents);
  corpus.keywords = corpus.topTerms.slice(0, 10).map((term) => ({
    text: term.term,
    score: term.collectionFrequency,
    count: term.collectionCount,
  }));
  corpus.speakers = [...speakerSummaries.entries()]
    .map(([key, speaker]) => ({
      speakerId: key === "Unknown speaker" ? null : key,
      speakerLabel: speaker.label,
      documents: speaker.documents,
      wordCount: speaker.words,
      durationSeconds: speaker.duration,
      stutterCount: speaker.stutters,
      lexicalDiversity: speaker.words ? (speakerTerms.get(key)?.size ?? 0) / speaker.words : 0,
      topTerms: termEntries(speakerTerms.get(key) ?? new Map<string, number>(), speaker.documents),
      keywords: termEntries(speakerTerms.get(key) ?? new Map<string, number>(), speaker.documents)
        .slice(0, 8)
        .map((term) => ({
          text: term.term,
          score: term.collectionFrequency,
          count: term.collectionCount,
        })),
    }))
    .sort((left, right) => right.wordCount - left.wordCount);
  return corpus;
}

function corpusTerms(text: string) {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9]+(?:'[a-z0-9]+)?/g)
      ?.filter((term) => term.length > 1) ?? []
  );
}

function termEntries(
  terms: Map<string, { count: number; documents: Set<string> } | number>,
  documentCount: number,
) {
  const total = [...terms.values()].reduce<number>(
    (sum, value) => sum + (typeof value === "number" ? value : value.count),
    0,
  );
  return [...terms.entries()]
    .map(([term, value]) => {
      const count = typeof value === "number" ? value : value.count;
      return {
        term,
        collectionCount: count,
        documentCount: typeof value === "number" ? documentCount : value.documents.size,
        collectionFrequency: total ? count / total : 0,
      };
    })
    .sort((left, right) => right.collectionCount - left.collectionCount)
    .slice(0, 12);
}

function normalizedSpeechStats(report: AnalysisReport): SpeechStats {
  return report.speechStats ?? emptySpeechStats();
}

function normalizedBlockerStats(report: AnalysisReport): BlockerStats {
  return report.blockerStats ?? emptyBlockerStats();
}

function emptyChunkStats(): TranscriptionChunkStats {
  return {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    lastMessage: "No chunks yet",
  };
}

function removeLocalSpeakerCopy(id: string) {
  const raw = localStorage.getItem(SPEAKERS_KEY);
  let stored: unknown;
  try {
    stored = JSON.parse(raw ?? "[]");
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    // Corrupt payloads contain no usable local profiles; do not block server deletion.
    stored = [];
  }
  if (Array.isArray(stored)) {
    const kept = stored.filter(
      (candidate: unknown) =>
        !(
          typeof candidate === "object" &&
          candidate !== null &&
          "id" in candidate &&
          typeof candidate.id === "string" &&
          speakerProfileStorageId(candidate.id) === speakerProfileStorageId(id)
        ),
    );
    if (kept.length !== stored.length) {
      localStorage.setItem(SPEAKERS_KEY, JSON.stringify(kept));
    }
  }
  // The pre-profile key belongs only to this profile. Absent copies need no write.
  if (id === "legacy-speaker" && localStorage.getItem(VOICE_KEY) !== null) {
    localStorage.removeItem(VOICE_KEY);
  }
}

/** `isStale` turns true after a removal, so the snapshot taken at start is not re-uploaded. */
async function loadPersistedSpeakerProfiles(
  isStale: () => boolean = () => false,
  migrate: (profiles: SpeakerProfile[]) => Promise<SpeakerProfile[]> = savePersistedSpeakerProfiles,
  fallbackToLocal = true,
): Promise<SpeakerProfile[]> {
  const localSpeakers = loadSpeakerProfiles();
  if (isDesktopApp()) {
    try {
      const speakers = await invoke<SpeakerProfile[]>("load_speaker_profiles");
      if (speakers.length) {
        return normalizeSpeakerProfiles(speakers);
      }
      if (localSpeakers.length && !isStale()) {
        return migrate(localSpeakers);
      }
      return [];
    } catch (error) {
      if (!fallbackToLocal) throw error;
      return localSpeakers;
    }
  }

  try {
    const speakers = await computeClient.listSpeakerProfiles();
    if (speakers.length) {
      return normalizeSpeakerProfiles(speakers);
    }
    if (localSpeakers.length && !isStale()) {
      return migrate(localSpeakers);
    }
    return [];
  } catch (error) {
    if (!fallbackToLocal) throw error;
    return localSpeakers;
  }
}

async function savePersistedSpeakerProfiles(speakers: SpeakerProfile[]): Promise<SpeakerProfile[]> {
  const normalized = normalizeSpeakerProfiles(speakers);
  if (isDesktopApp()) {
    return invoke<SpeakerProfile[]>("save_speaker_profiles", { speakers: normalized });
  }
  if (computeClient.destination.kind !== "server") {
    // No permitted server: voiceprints stay in this browser.
    localStorage.setItem(SPEAKERS_KEY, JSON.stringify(normalized));
    return normalized;
  }
  try {
    return await computeClient.saveSpeakerProfiles(normalized);
  } catch {
    localStorage.setItem(SPEAKERS_KEY, JSON.stringify(normalized));
    return normalized;
  }
}

/**
 * Checkpoints of captures that were never saved and that no live window owns. A checkpoint of a
 * session that was saved (the app stopped before removing it) or one without any observation is
 * removed instead.
 */
async function detectInterruptedCaptures(sessions: SavedSession[]): Promise<InterruptedCapture[]> {
  const held = await heldCaptureIds();
  return listCaptureCheckpoints().filter((capture) => {
    if (held.has(capture.key.slice(CAPTURE_CHECKPOINT_PREFIX.length))) {
      return false;
    }
    if (
      capture.kind === "checkpoint" &&
      (sessions.some((session) => session.id === capture.checkpoint.id) ||
        !hasCheckpointedObservation(capture.checkpoint))
    ) {
      removeCaptureCheckpoint(capture.key);
      return false;
    }
    return true;
  });
}

function mergeInterruptedCaptures(current: InterruptedCapture[], added: InterruptedCapture[]) {
  const keys = new Set(current.map((item) => item.key));
  return [...current, ...added.filter((item) => !keys.has(item.key))];
}

// What a checkpoint holds, ignoring its write time.
function checkpointState(checkpoint: CaptureCheckpoint) {
  return JSON.stringify([
    checkpoint.id,
    observationFingerprint(checkpoint.segments, checkpoint.pauses),
    checkpoint.analysis?.run.id ?? null,
    checkpoint.transcription ?? null,
  ]);
}

function loadSessions(): SavedSession[] {
  try {
    return loadSessionsFromStorage();
  } catch {
    return [];
  }
}

function loadSpeakerProfiles(): SpeakerProfile[] {
  try {
    const speakers = JSON.parse(localStorage.getItem(SPEAKERS_KEY) ?? "[]") as SpeakerProfile[];
    if (Array.isArray(speakers) && speakers.length > 0) {
      return normalizeSpeakerProfiles(speakers);
    }
    const legacy = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null") as Voiceprint | null;
    if (legacy?.embedding?.length) {
      return [
        {
          id: "legacy-speaker",
          label: "Enrolled speaker",
          embeddings: [legacy.embedding],
          sampleRate: legacy.sampleRate,
          sampleCount: legacy.sampleCount,
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
}

/** Native IDs are opaque; only browser/server IDs use the server's canonical form. */
function speakerProfileStorageId(id: string) {
  return isDesktopApp() ? id : id.trim().slice(0, 120);
}

function normalizeSpeakerProfiles(speakers: SpeakerProfile[]) {
  const normalized = new Map<string, SpeakerProfile>();
  for (const speaker of speakers) {
    if (
      typeof speaker.id === "string" &&
      speaker.id.trim().length > 0 &&
      typeof speaker.label === "string" &&
      speaker.label.trim().length > 0 &&
      Array.isArray(speaker.embeddings) &&
      speaker.embeddings.length > 0
    ) {
      const id = speakerProfileStorageId(speaker.id);
      normalized.set(id, { ...speaker, id, label: speaker.label.trim() });
    }
  }
  return [...normalized.values()];
}

function loadTranscriptionSettings(): TranscriptionSettings {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TRANSCRIPTION_KEY) ?? "null",
    ) as Partial<TranscriptionSettings> | null;
    const fallback = defaultTranscriptionSettings();
    const engine =
      TRANSCRIPTION_ENGINES.find((item) => item.id === parsed?.engine) ??
      getTranscriptionEngine(fallback.engine);
    const model = engine.models.includes(parsed?.model ?? "")
      ? (parsed?.model ?? engine.models[0])
      : engine.models.includes(fallback.model)
        ? fallback.model
        : engine.models[0];
    return { engine: engine.id, model, device: parsed?.device === "cpu" ? "cpu" : "auto" };
  } catch {
    return defaultTranscriptionSettings();
  }
}

function defaultTranscriptionSettings(): TranscriptionSettings {
  return isDesktopApp()
    ? { engine: "whisperCpp", model: "base.en", device: "auto" }
    : { engine: "browser", model: "default", device: "auto" };
}

export function staticModelStatuses(engine: TranscriptionEngineId): TranscriptionModelStatus[] {
  return getTranscriptionEngine(engine).models.map((model) => ({
    id: model,
    label: model,
    cached: engine === "browser",
    downloadable: false,
  }));
}

function isDesktopApp() {
  return isTauri() || "__TAURI_INTERNALS__" in window;
}

function getTranscriptionEngine(id: TranscriptionEngineId) {
  return TRANSCRIPTION_ENGINES.find((engine) => engine.id === id) ?? TRANSCRIPTION_ENGINES[0];
}

/** What the provisional transcription did to the captured audio before the model saw it. */
function provisionalPreprocessing(
  engine: TranscriptionEngineId,
  captureSampleRate: number,
): TranscriptPreprocessing {
  return engine === "browser"
    ? { captureSampleRate: null, modelSampleRate: null, chunkSeconds: null }
    : {
        captureSampleRate,
        modelSampleRate: TRANSCRIPTION_TARGET_SAMPLE_RATE,
        chunkSeconds: TRANSCRIPTION_CHUNK_SECONDS,
      };
}

function elapsedSeconds() {
  const startedAt = startedAtRefGlobal();
  return startedAt ? (Date.now() - startedAt.getTime()) / 1000 : 0;
}

let startedAtAccessor: (() => Date | null) | null = null;
function startedAtRefGlobal() {
  return startedAtAccessor?.() ?? null;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("native_worker_unavailable")) {
    return "Compute server has no native transcription worker configured.";
  }
  if (message.includes("server_busy")) {
    return "Compute server is busy; try again shortly.";
  }
  if (message.includes("unauthorized")) {
    return "Compute server rejected the API token.";
  }
  return message;
}

function recordingErrorMessage(error: unknown) {
  if (error instanceof BrowserRecorderError) {
    if (error.code === "denied") {
      return "Microphone permission was denied";
    }
    if (error.code === "unavailable") {
      return "Microphone recording is unavailable in this browser";
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Recording failed: ${message}`;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    __TAURI_INTERNALS__?: unknown;
  }
}
