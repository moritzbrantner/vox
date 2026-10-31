import {
  addParticipant as addDeclaredParticipant,
  confirmParticipant as confirmDeclaredParticipant,
  type DeclaredParticipant,
  removeParticipant as removeDeclaredParticipant,
} from "@stutter-tracker/shared";
import { useEffect, useRef, useState } from "react";
import { loadSoloSpeakerDeclaration, saveSoloSpeakerDeclaration } from "../../storage/localStorage";
import type { useWorkspace } from "./useWorkspace";

type RecordingConsentDeps = Pick<ReturnType<typeof useWorkspace>, "isRecording">;

/** Who is being recorded: the solo declaration and each other person's confirmation (#66, #151). */
export function useRecordingConsent({ isRecording }: RecordingConsentDeps) {
  const [soloSpeaker, setSoloSpeakerState] = useState(loadSoloSpeakerDeclaration);
  // Read when the microphone is acquired, so a change while Record is pending still applies.
  const soloSpeakerRef = useRef(soloSpeaker);
  const setSoloSpeaker = (declared: boolean) => {
    soloSpeakerRef.current = declared;
    setSoloSpeakerState(declared);
    saveSoloSpeakerDeclaration(declared);
    if (declared) setOthersRecorded(false);
  };
  // Recording other people needs each listed person confirmed for this session. Nothing is
  // stored: the list is cleared whenever a recording ends, so it never carries over.
  const [othersRecorded, setOthersRecordedState] = useState(false);
  const [participants, setParticipants] = useState<DeclaredParticipant[]>([]);
  const setOthersRecorded = (declared: boolean) => {
    setOthersRecordedState(declared);
    setParticipants([]);
    if (declared) setSoloSpeaker(false);
  };
  useEffect(() => {
    if (!isRecording) setParticipants([]);
  }, [isRecording]);

  return {
    soloSpeaker,
    soloSpeakerRef,
    setSoloSpeaker,
    othersRecorded,
    setOthersRecorded,
    participants,
    addParticipant: (label: string) =>
      setParticipants((current) => addDeclaredParticipant(current, label, crypto.randomUUID())),
    confirmParticipant: (id: string, confirmed: boolean) =>
      setParticipants((current) => confirmDeclaredParticipant(current, id, confirmed)),
    removeParticipant: (id: string) =>
      setParticipants((current) => removeDeclaredParticipant(current, id)),
  };
}
