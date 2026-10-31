import {
  OTHER_PARTICIPANTS_REQUIRED_MESSAGE,
  canStartWithParticipants,
  isUnitFinal,
  participantsConfirmationForStart,
  startLiveTranscript,
  transcriptProvenance,
} from "@stutter-tracker/shared";
import { useRef, useState } from "react";
import { type BrowserRecorder, createBrowserRecorder } from "../../audio/browserRecorder";
import { createGapTracker } from "../../audio/captureGaps";
import { preloadCaptureKernel } from "../../audio/captureKernel";
import { type TranscriptSegment } from "../../types";
import { RECOGNITION_END_TIMEOUT_MS, isDesktopApp } from "../config";
import { recordingErrorMessage } from "../errors";
import { identifySpeaker } from "../speakerProfiles";
import { provisionalPreprocessing } from "../transcription";
import { elapsedSeconds } from "./useWorkspace";
import type { useWorkspace } from "./useWorkspace";
import type { useRecordingConsent } from "./useRecordingConsent";
import type { useSpeakerProfiles } from "./useSpeakerProfiles";
import type { useTranscriptionModels } from "./useTranscriptionModels";
import type { useChunkTranscription } from "./useChunkTranscription";
import type { useCaptureRecovery } from "./useCaptureRecovery";
import type { useVoiceActivity } from "./useVoiceActivity";

type RecordingDeps = Pick<
  ReturnType<typeof useWorkspace>,
  | "setSegments"
  | "setPauses"
  | "transcriptProvenanceRef"
  | "liveTranscriptRef"
  | "isRecording"
  | "setIsRecording"
  | "isFinishingCapture"
  | "setIsFinishingCapture"
  | "setCaptureRevision"
  | "language"
  | "interimText"
  | "setInterimText"
  | "setMessage"
  | "activeSessionIdRef"
  | "startedAtRef"
  | "sampleRateRef"
  | "samplesRef"
  | "capturedSampleCountRef"
  | "captureDescriptorRef"
  | "segmentsRef"
  | "sessionLanguageRef"
  | "loadedSessionRef"
  | "workspaceGenerationRef"
  | "setViewedSession"
  | "isRecordingRef"
> &
  Pick<
    ReturnType<typeof useRecordingConsent>,
    "soloSpeakerRef" | "othersRecorded" | "othersAgreed"
  > &
  Pick<
    ReturnType<typeof useSpeakerProfiles>,
    "setSpeakerMatch" | "speakersRef" | "speakerMatchRef" | "speakerMatchInFlightRef"
  > &
  Pick<
    ReturnType<typeof useTranscriptionModels>,
    | "transcription"
    | "transcriptionRef"
    | "selectedEngine"
    | "fetchModelStatuses"
    | "ensureSelectedModelReady"
  > &
  Pick<
    ReturnType<typeof useChunkTranscription>,
    | "setIsTranscribing"
    | "recordingTranscriptionRef"
    | "recordingLanguageRef"
    | "chunkTranscriptionTailRef"
    | "chunkResultsRef"
    | "applyLiveUpdate"
    | "resetChunkTranscription"
    | "enqueueAvailableTranscriptionChunks"
  > &
  Pick<
    ReturnType<typeof useCaptureRecovery>,
    | "workspaceClaimPendingRef"
    | "startPendingRef"
    | "takeWorkspaceCapture"
    | "canSetAsideWorkspaceCapture"
    | "setAsideUnsavedCapture"
  > & {
    voiceActivity: Pick<ReturnType<typeof useVoiceActivity>, "start" | "push" | "seal" | "finish">;
  };

/** A recording run: microphone, browser recognition, level and pauses, and finishing the capture. */
export function useRecording({
  setSegments,
  setPauses,
  transcriptProvenanceRef,
  liveTranscriptRef,
  isRecording,
  setIsRecording,
  isFinishingCapture,
  setIsFinishingCapture,
  setCaptureRevision,
  language,
  interimText,
  setInterimText,
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
  workspaceGenerationRef,
  setViewedSession,
  isRecordingRef,
  soloSpeakerRef,
  othersRecorded,
  othersAgreed,
  setSpeakerMatch,
  speakersRef,
  speakerMatchRef,
  speakerMatchInFlightRef,
  transcription,
  transcriptionRef,
  selectedEngine,
  fetchModelStatuses,
  ensureSelectedModelReady,
  setIsTranscribing,
  recordingTranscriptionRef,
  recordingLanguageRef,
  chunkTranscriptionTailRef,
  chunkResultsRef,
  applyLiveUpdate,
  resetChunkTranscription,
  enqueueAvailableTranscriptionChunks,
  workspaceClaimPendingRef,
  startPendingRef,
  takeWorkspaceCapture,
  canSetAsideWorkspaceCapture,
  setAsideUnsavedCapture,
  voiceActivity,
}: RecordingDeps) {
  const [isMatchingVoice, setIsMatchingVoice] = useState(false);

  const [level, setLevel] = useState(0);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const browserRecorderRef = useRef<BrowserRecorder | null>(null);

  const lastFinalEndRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const lastSpeakerMatchAtRef = useRef(0);

  // Records the live capture's intervals without samples into its descriptor.
  const gapTrackerRef = useRef<ReturnType<typeof createGapTracker> | null>(null);

  async function startRecording() {
    // A new capture would reset the refs the previous one is still finishing with.
    if (isRecording || isFinishingCapture || workspaceClaimPendingRef.current) {
      return;
    }
    // A session that records other people does not start without this session's confirmation.
    const participants = { othersRecorded, othersAgreed };
    if (!canStartWithParticipants(participants)) {
      setMessage(OTHER_PARTICIPANTS_REQUIRED_MESSAGE);
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
      const otherParticipants = participantsConfirmationForStart(participants);
      if (otherParticipants) captureDescriptorRef.current.otherParticipants = otherParticipants;
      gapTrackerRef.current = createGapTracker(recorder.sampleRate, {
        startedAtSeconds: performance.now() / 1000,
      });
      voiceActivity.start(captureDescriptorRef.current.runId, recorder.sampleRate);
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

  // Resolves when browser recognition has delivered its final results after Stop.
  const recognitionEndedRef = useRef<(() => void) | null>(null);

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
    voiceActivity.push(chunk);

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
    const capturedSampleCount = capturedSampleCountRef.current;
    const capturedSampleRate = sampleRateRef.current;
    // Later recorder chunks are not part of the capture, so live detection stops with it.
    voiceActivity.seal();
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
    // Speech detection of exactly the samples this capture keeps (live and after Stop).
    const descriptor = captureDescriptorRef.current;
    if (descriptor) {
      await voiceActivity
        .finish({
          descriptor,
          samples: capturedSamples,
          sampleRate: capturedSampleRate,
          capturedSampleCount,
        })
        .catch(() => null);
    }
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

  return { isMatchingVoice, level, startRecording, stopRecording };
}
