import type { ProcessingDestination } from "@stutter-tracker/compute-client";
import {
  canStartWithParticipants,
  type DeclaredParticipant,
  describeCompute,
  OTHER_PARTICIPANTS_REQUIRED_MESSAGE,
  participantStatement,
  type TranscriptCompute,
  type TranscriptionDevicePreference,
} from "@stutter-tracker/shared";
import { Mic, MicOff, X } from "lucide-react";
import { useState } from "react";
import type { TranscriptionEngine, TranscriptionEngineId, TranscriptionSettings } from "../types";
import {
  buttonClass,
  controlClass,
  cx,
  dangerButtonClass,
  eyebrowClass,
  primaryButtonClass,
} from "./styles";

type DashboardHeaderProps = {
  engines: TranscriptionEngine[];
  languages: string[];
  transcription: TranscriptionSettings;
  selectedModels: string[];
  language: string;
  isNative: boolean;
  isRecording: boolean;
  /** Stop was pressed and the previous capture is still shutting down. */
  isFinishingCapture?: boolean;
  processingDestination: ProcessingDestination;
  onRemoteConsentChange: (granted: boolean) => void;
  onEngineChange: (engine: TranscriptionEngineId) => void;
  onModelChange: (model: string) => void;
  onDeviceChange: (device: TranscriptionDevicePreference) => void;
  /** Backend and device of the latest whisper.cpp-engine transcription; null before the first. */
  lastCompute: TranscriptCompute | null;
  onLanguageChange: (language: string) => void;
  onRecordingToggle: () => void;
  /** Declared before recording; fixed for the capture it starts. */
  soloSpeaker: boolean;
  onSoloSpeakerChange: (declared: boolean) => void;
  /** The next session will record other people; each listed person must then be confirmed. */
  othersRecorded: boolean;
  onOthersRecordedChange: (declared: boolean) => void;
  /** The other people listed for this session; cleared when a recording ends. */
  participants: readonly DeclaredParticipant[];
  onParticipantAdd: (label: string) => void;
  onParticipantConfirm: (id: string, confirmed: boolean) => void;
  onParticipantRemove: (id: string) => void;
};

export function DashboardHeader({
  engines,
  languages,
  transcription,
  selectedModels,
  language,
  isNative,
  isRecording,
  isFinishingCapture = false,
  processingDestination,
  onRemoteConsentChange,
  onEngineChange,
  onModelChange,
  onDeviceChange,
  lastCompute,
  onLanguageChange,
  onRecordingToggle,
  soloSpeaker,
  onSoloSpeakerChange,
  othersRecorded,
  onOthersRecordedChange,
  participants,
  onParticipantAdd,
  onParticipantConfirm,
  onParticipantRemove,
}: DashboardHeaderProps) {
  const whisperCpp = transcription.engine === "whisperCpp";
  const needsAgreement =
    !isRecording && !canStartWithParticipants({ othersRecorded, participants });
  return (
    <section className="mb-4 flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
      <div>
        <p className={eyebrowClass}>Stutter Tracker</p>
        <h1 className="m-0 text-5xl leading-none text-[#17201b] max-sm:text-4xl">Speech Log</h1>
        <ProcessingDestinationNotice
          destination={processingDestination}
          disabled={isRecording}
          onRemoteConsentChange={onRemoteConsentChange}
        />
        {whisperCpp && lastCompute ? (
          <p
            className="m-0 text-sm text-[#536158]"
            role="status"
            aria-label="Transcription device"
            title={lastCompute.gpuUnavailableReason}
          >
            Transcription: <strong>{describeCompute(lastCompute)}</strong>
            {lastCompute.gpuUnavailableReason ? " (GPU unavailable)" : ""}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 max-sm:flex-col max-sm:items-stretch">
        <select
          className={controlClass}
          value={transcription.engine}
          onChange={(event) => onEngineChange(event.target.value as TranscriptionEngineId)}
          disabled={isRecording}
          aria-label="Transcription engine"
        >
          {engines.map((engine) => (
            <option
              key={engine.id}
              value={engine.id}
              disabled={engine.nativeOnly && !isNative && processingDestination.kind !== "server"}
            >
              {engine.label}
            </option>
          ))}
        </select>
        <select
          className={controlClass}
          value={transcription.model}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={isRecording || selectedModels.length < 2}
          aria-label="Transcription model"
        >
          {selectedModels.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {whisperCpp ? (
          <label
            className="flex items-center gap-2 text-sm text-[#2d4e43]"
            title="By default transcription uses the GPU when one is usable and falls back to the CPU"
          >
            <input
              type="checkbox"
              checked={transcription.device === "cpu"}
              disabled={isRecording}
              onChange={(event) => onDeviceChange(event.target.checked ? "cpu" : "auto")}
            />
            CPU only
          </label>
        ) : null}
        <select
          className={controlClass}
          value={language}
          onChange={(event) => onLanguageChange(event.target.value)}
          disabled={isRecording}
          aria-label="Recognition language"
        >
          {languages.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <label
          className="flex items-center gap-2 text-sm text-[#2d4e43]"
          title="Without this, results stay unknown: other voices could be counted as yours"
        >
          <input
            type="checkbox"
            checked={soloSpeaker}
            disabled={isRecording}
            onChange={(event) => onSoloSpeakerChange(event.target.checked)}
          />
          Only I speak
        </label>
        <label className="flex items-center gap-2 text-sm text-[#2d4e43]">
          <input
            type="checkbox"
            checked={othersRecorded}
            disabled={isRecording}
            onChange={(event) => onOthersRecordedChange(event.target.checked)}
          />
          Recording other people
        </label>
        {othersRecorded && (
          <ParticipantsList
            participants={participants}
            disabled={isRecording}
            onAdd={onParticipantAdd}
            onConfirm={onParticipantConfirm}
            onRemove={onParticipantRemove}
          />
        )}
        <button
          className={cx(isRecording ? dangerButtonClass : primaryButtonClass)}
          onClick={onRecordingToggle}
          disabled={isFinishingCapture || needsAgreement}
          title={
            isFinishingCapture
              ? "Finishing the previous recording"
              : needsAgreement
                ? OTHER_PARTICIPANTS_REQUIRED_MESSAGE
                : undefined
          }
        >
          {isRecording ? <MicOff size={18} /> : <Mic size={18} />}
          {isRecording ? "Stop" : "Record"}
        </button>
      </div>
    </section>
  );
}

function ProcessingDestinationNotice({
  destination,
  disabled,
  onRemoteConsentChange,
}: {
  destination: ProcessingDestination;
  disabled: boolean;
  onRemoteConsentChange: (granted: boolean) => void;
}) {
  const remote =
    (destination.kind === "server" && destination.mode === "remote") ||
    (destination.kind === "blocked" && destination.needsRemoteConsent);
  return (
    <div className="mt-2 text-sm text-[#536158]" role="status" aria-label="Processing destination">
      <p className="m-0">
        Processing: <strong>{destination.label}</strong>
      </p>
      {destination.kind === "blocked" ? <p className="m-0">{destination.reason}</p> : null}
      {remote ? (
        <label className="mt-1 flex items-center gap-2">
          <input
            type="checkbox"
            checked={destination.kind === "server"}
            disabled={disabled}
            onChange={(event) => onRemoteConsentChange(event.target.checked)}
          />
          Send recordings, transcripts and speaker profiles (voiceprints) to this remote server for
          analysis and storage
        </label>
      ) : null}
    </div>
  );
}

/** Each other person in the next recording, confirmed one by one (#151). */
function ParticipantsList({
  participants,
  disabled,
  onAdd,
  onConfirm,
  onRemove,
}: {
  participants: readonly DeclaredParticipant[];
  disabled: boolean;
  onAdd: (label: string) => void;
  onConfirm: (id: string, confirmed: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const [label, setLabel] = useState("");
  const add = () => {
    onAdd(label);
    setLabel("");
  };
  return (
    <fieldset
      className="flex flex-col gap-1 text-sm text-[#2d4e43]"
      aria-label="Other participants"
    >
      {participants.map((participant) => (
        <div key={participant.id} className="flex items-center gap-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={participant.confirmedAt !== null}
              disabled={disabled}
              onChange={(event) => onConfirm(participant.id, event.target.checked)}
            />
            {participantStatement(participant.label)}
          </label>
          <button
            type="button"
            aria-label={`Remove ${participant.label}`}
            disabled={disabled}
            onClick={() => onRemove(participant.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className={controlClass}
          aria-label="Other participant's name or label"
          placeholder="Name or label"
          value={label}
          disabled={disabled}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button className={buttonClass} type="submit" disabled={disabled || !label.trim()}>
          Add person
        </button>
      </form>
    </fieldset>
  );
}
