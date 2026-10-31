import { App as TrackerApp } from "./app/TrackerApp";
import { AuditoryFeedbackLab } from "./components/AuditoryFeedbackLab";

export { desktopAnalyzer, fallbackAnalyze } from "./app/analysis";
export { fallbackPredictSpeakerIntent } from "./app/speakerIntent";
export { countUnverifiedCorpusSessions } from "./app/speechCorpus";
export {
  offsetTranscriptSegments,
  resampleSamples,
  staticModelStatuses,
  summarizeTranscriptionChunks,
} from "./app/transcription";
export { formatTime } from "./utils/formatting";

export function App() {
  return (
    <>
      <TrackerApp />
      <AuditoryFeedbackLab />
    </>
  );
}
