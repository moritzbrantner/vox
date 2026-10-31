import {
  type ModelPreparationFailure,
  type TranscriptionDevicePreference,
  modelPreparationFailure,
  uncheckedModelStatuses,
} from "@stutter-tracker/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type TranscriptionEngineId,
  type TranscriptionProgressEvent,
  type TranscriptionSettings,
} from "../../types";
import { TRANSCRIPTION_KEY, getTranscriptionEngine } from "../config";
import { errorMessage } from "../errors";
import {
  downloadTranscriptionModel,
  loadTranscriptionModels,
  loadTranscriptionSettings,
  staticModelStatuses,
} from "../transcription";
import type { useWorkspace } from "./useWorkspace";

type TranscriptionModelsDeps = Pick<
  ReturnType<typeof useWorkspace>,
  "isRecording" | "isNative" | "setMessage"
>;

/** Engine and model selection, model status and model downloads. */
export function useTranscriptionModels({
  isRecording,
  isNative,
  setMessage,
}: TranscriptionModelsDeps) {
  const queryClient = useQueryClient();
  const [transcription, setTranscription] = useState<TranscriptionSettings>(() =>
    loadTranscriptionSettings(),
  );

  const [downloadProgress, setDownloadProgress] = useState<TranscriptionProgressEvent | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [modelPreparationFailures, setModelPreparationFailures] = useState<
    Record<string, ModelPreparationFailure>
  >({});

  const transcriptionRef = useRef(transcription);

  const modelDownloadKeyRef = useRef<string | null>(null);
  const modelDownloadPromiseRef = useRef<Promise<boolean> | null>(null);

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

  const selectedEngine = getTranscriptionEngine(transcription.engine);
  const selectedModels = modelStatuses.length
    ? modelStatuses.map((model) => model.id)
    : selectedEngine.models;
  const selectedModelStatus = modelStatuses.find((model) => model.id === transcription.model);

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
    transcriptionRef.current = transcription;
  }, [transcription]);

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

  return {
    transcription,
    downloadProgress,
    downloadingModel,
    transcriptionRef,
    modelStatuses,
    selectedEngine,
    selectedModels,
    selectedModelStatus,
    downloadModelMutation,
    updateTranscriptionEngine,
    updateTranscriptionModel,
    updateTranscriptionDevice,
    fetchModelStatuses,
    ensureSelectedModelReady,
    downloadModel,
  };
}
