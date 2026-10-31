import {
  type AnalysisRunIdentity,
  type LiveTranscript,
  type RecordingDescriptor,
  type TranscriptProvenance,
  type TranscriptionModelIdentity,
  readableTranscript,
  startLiveTranscript,
  verbatimTranscript,
} from "@stutter-tracker/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { type KeptSessionAudio, getSessionAudio } from "../../storage/sessionAudio";
import {
  type AnalysisReport,
  type PauseSpan,
  type SavedSession,
  type TranscriptSegment,
} from "../../types";
import { emptyReport } from "../analysis";
import { LANGUAGES, isDesktopApp } from "../config";

/** The workspace: the observation on screen, its report, the captured audio and the viewed session. */
export function useWorkspace() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [pauses, setPauses] = useState<PauseSpan[]>([]);
  const [report, setReport] = useState<AnalysisReport>(() => emptyReport());
  // Identity of the analysis run that produced `report`; null when nothing has analyzed it.
  const [reportRun, setReportRun] = useState<AnalysisRunIdentity | null>(null);

  // The engine and model that produced the workspace transcript; null when unknown.
  const transcriptModelRef = useRef<TranscriptionModelIdentity | null>(null);
  // Model, language and preprocessing of the workspace transcript (vox#26); null when unknown.
  const transcriptProvenanceRef = useRef<TranscriptProvenance | null>(null);
  // Partial-to-final identity of the live transcript, bound to one recording run (vox#26).
  const liveTranscriptRef = useRef<LiveTranscript>(startLiveTranscript("none"));

  const [isRecording, setIsRecording] = useState(false);
  const [isFinishingCapture, setIsFinishingCapture] = useState(false);
  // Bumped when a capture finishes, so the final audio (which can grow after the last transcript
  // update) gets its own analysis before the session can be saved.
  const [captureRevision, setCaptureRevision] = useState(0);
  const [isNative, setIsNative] = useState(() => isDesktopApp());

  const [language, setLanguage] = useState(LANGUAGES[0]);

  const [interimText, setInterimText] = useState("");

  const [message, setMessage] = useState("Idle");

  const activeSessionIdRef = useRef<string | null>(null);

  const startedAtRef = useRef<Date | null>(null);

  const sampleRateRef = useRef(48_000);
  const samplesRef = useRef<number[]>([]);
  // Samples recorded for the whole capture; the browser engine keeps only the last 90 s in
  // samplesRef, and analysis is sent at most that window.
  const capturedSampleCountRef = useRef(0);
  // Describes the capture whose PCM is in samplesRef; cleared together with it.
  const captureDescriptorRef = useRef<RecordingDescriptor | null>(null);

  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const pausesRef = useRef<PauseSpan[]>([]);

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

  const transcript = useMemo(() => verbatimTranscript(segments), [segments]);
  const readable = useMemo(() => readableTranscript(segments), [segments]);

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
    segmentsRef.current = segments;
    pausesRef.current = pauses;
  }, [segments, pauses]);

  const isRecordingRef = useRef(false);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  return {
    segments,
    setSegments,
    pauses,
    setPauses,
    report,
    setReport,
    reportRun,
    setReportRun,
    transcriptModelRef,
    transcriptProvenanceRef,
    liveTranscriptRef,
    isRecording,
    setIsRecording,
    isFinishingCapture,
    setIsFinishingCapture,
    captureRevision,
    setCaptureRevision,
    isNative,
    language,
    setLanguage,
    interimText,
    setInterimText,
    message,
    setMessage,
    activeSessionIdRef,
    startedAtRef,
    sampleRateRef,
    samplesRef,
    capturedSampleCountRef,
    captureDescriptorRef,
    segmentsRef,
    sessionLanguageRef,
    loadedSessionRef,
    viewedSession,
    viewedAudio,
    setViewedAudio,
    keepAudio,
    setKeepAudio,
    blindReview,
    setBlindReview,
    viewedSessionRef,
    workspaceGenerationRef,
    setViewedSession,
    transcript,
    readable,
    isRecordingRef,
  };
}

export function elapsedSeconds() {
  const startedAt = startedAtRefGlobal();
  return startedAt ? (Date.now() - startedAt.getTime()) / 1000 : 0;
}

let startedAtAccessor: (() => Date | null) | null = null;
function startedAtRefGlobal() {
  return startedAtAccessor?.() ?? null;
}
