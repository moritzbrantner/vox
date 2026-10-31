import { useEffect, useRef, useState } from "react";
import { loadSoloSpeakerDeclaration, saveSoloSpeakerDeclaration } from "../../storage/localStorage";
import type { useWorkspace } from "./useWorkspace";

type RecordingConsentDeps = Pick<ReturnType<typeof useWorkspace>, "isRecording">;

/** Who is being recorded: the solo declaration and this session's confirmation for others (#66). */
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
  // Recording other people needs a confirmation made for this session (#66). Neither is stored:
  // the agreement is cleared whenever a recording ends, so it never carries over.
  const [othersRecorded, setOthersRecordedState] = useState(false);
  const [othersAgreed, setOthersAgreed] = useState(false);
  const setOthersRecorded = (declared: boolean) => {
    setOthersRecordedState(declared);
    setOthersAgreed(false);
    if (declared) setSoloSpeaker(false);
  };
  useEffect(() => {
    if (!isRecording) setOthersAgreed(false);
  }, [isRecording]);

  return {
    soloSpeaker,
    soloSpeakerRef,
    setSoloSpeaker,
    othersRecorded,
    othersAgreed,
    setOthersAgreed,
    setOthersRecorded,
  };
}
