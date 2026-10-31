import {
  type LiveTranscriptUpdate,
  type TranscriptCompute,
  applyLiveTranscriptUpdate,
  liveTranscriptPartialText,
  liveTranscriptSegments,
  markUnalignedTiming,
  transcriptProvenance,
} from "@stutter-tracker/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { planAvailableChunks } from "../../recording/chunks";
import {
  type TranscriptionChunkRecord,
  type TranscriptionChunkStats,
  type TranscriptionSettings,
} from "../../types";
import { TRANSCRIPTION_CHUNK_SECONDS, TRANSCRIPTION_TARGET_SAMPLE_RATE } from "../config";
import { errorMessage } from "../errors";
import { identifyTranscriptSpeakers } from "../speakerProfiles";
import {
  emptyChunkStats,
  offsetTranscriptSegments,
  provisionalPreprocessing,
  resampleSamples,
  summarizeTranscriptionChunks,
  transcribeAudio,
  updateTranscriptionChunk,
} from "../transcription";
import type { useWorkspace } from "./useWorkspace";
import type { useSpeakerProfiles } from "./useSpeakerProfiles";

type ChunkTranscriptionDeps = Pick<
  ReturnType<typeof useWorkspace>,
  | "setSegments"
  | "transcriptModelRef"
  | "transcriptProvenanceRef"
  | "liveTranscriptRef"
  | "isRecording"
  | "isFinishingCapture"
  | "language"
  | "setInterimText"
  | "setMessage"
  | "sampleRateRef"
  | "samplesRef"
> &
  Pick<ReturnType<typeof useSpeakerProfiles>, "speakersRef">;

/** The live transcript of a run and the queue of its transcription chunks. */
export function useChunkTranscription({
  setSegments,
  transcriptModelRef,
  transcriptProvenanceRef,
  liveTranscriptRef,
  isRecording,
  isFinishingCapture,
  language,
  setInterimText,
  setMessage,
  sampleRateRef,
  samplesRef,
  speakersRef,
}: ChunkTranscriptionDeps) {
  const queryClient = useQueryClient();
  // Backend and device of the latest whisper.cpp-engine transcription, for diagnostics (vox#139).
  const [lastCompute, setLastCompute] = useState<TranscriptCompute | null>(null);

  const [chunkStats, setChunkStats] = useState<TranscriptionChunkStats>(() => emptyChunkStats());
  const [transcriptionChunks, setTranscriptionChunks] = useState<TranscriptionChunkRecord[]>([]);

  const [isTranscribing, setIsTranscribing] = useState(false);

  const recordingTranscriptionRef = useRef<TranscriptionSettings | null>(null);
  // Bound when a recording starts; a later selection never redirects that run's transcription.
  const recordingLanguageRef = useRef(language);

  const nextChunkStartSampleRef = useRef(0);
  const chunkIndexRef = useRef(0);
  const chunkTranscriptionTailRef = useRef<Promise<void>>(Promise.resolve());
  const queuedTranscriptionTasksRef = useRef(0);
  const transcriptionRunIdRef = useRef(0);
  const chunkResultsRef = useRef({ completed: 0, failed: 0 });

  const chunkProgress = useMemo(
    () => summarizeTranscriptionChunks(transcriptionChunks),
    [transcriptionChunks],
  );
  const captureInProgress =
    isRecording ||
    isFinishingCapture ||
    isTranscribing ||
    chunkProgress.queued + chunkProgress.processing > 0;

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

  return {
    lastCompute,
    setLastCompute,
    chunkStats,
    transcriptionChunks,
    isTranscribing,
    setIsTranscribing,
    recordingTranscriptionRef,
    recordingLanguageRef,
    chunkTranscriptionTailRef,
    chunkResultsRef,
    chunkProgress,
    captureInProgress,
    applyLiveUpdate,
    cancelLiveTranscript,
    resetChunkTranscription,
    enqueueAvailableTranscriptionChunks,
  };
}
