import { useState } from "react";
import { latestVoiceActivity } from "@stutter-tracker/shared";
import { AnnotationExchangePanel } from "../components/AnnotationExchangePanel";
import { AnnotationWorkbench } from "../components/AnnotationWorkbench";
import { BlindReview } from "../components/BlindReview";
import { DashboardHeader } from "../components/DashboardHeader";
import { EvidenceExportPanel } from "../components/EvidenceExportPanel";
import { ExportBackupDialog } from "../components/ExportBackupDialog";
import { InsightsSidebar } from "../components/InsightsSidebar";
import { InterruptedCaptureNotice } from "../components/InterruptedCaptureNotice";
import { LowerDashboard } from "../components/LowerDashboard";
import { RecordingWorkspace } from "../components/RecordingWorkspace";
import { SessionComparisonPanel } from "../components/SessionComparisonPanel";
import { StatusMetrics } from "../components/StatusMetrics";
import { StorageProtectionNotice } from "../components/StorageProtectionNotice";
import { TranscriptRevisionsPanel } from "../components/TranscriptRevisionsPanel";
import { ValidationPanel } from "../components/ValidationPanel";
import { VoiceActivityTimeline } from "../components/VoiceActivityTimeline";
import { buttonClass } from "../components/styles";
import { encryptBackup } from "../storage/encryptedBackup";
import { saveRemoteConsent } from "../storage/localStorage";
import { normalizedBlockerStats, normalizedSpeechStats } from "./analysis";
import { CONSENT_SERVER_URL, LANGUAGES, TRANSCRIPTION_ENGINES, computeClient } from "./config";
import { downloadFile, downloadJsonFile } from "./downloads";
import { useCaptureRecovery } from "./hooks/useCaptureRecovery";
import { useChunkTranscription } from "./hooks/useChunkTranscription";
import { useIntentPredictions } from "./hooks/useIntentPredictions";
import { useLiveAnalysis } from "./hooks/useLiveAnalysis";
import { useReanalysis } from "./hooks/useReanalysis";
import { useRecording } from "./hooks/useRecording";
import { useRecordingConsent } from "./hooks/useRecordingConsent";
import { useSessionLibrary } from "./hooks/useSessionLibrary";
import { useSessionRemoval } from "./hooks/useSessionRemoval";
import { useSessionSaving } from "./hooks/useSessionSaving";
import { useSessionUpdates } from "./hooks/useSessionUpdates";
import { useSpeakerProfiles } from "./hooks/useSpeakerProfiles";
import { useTranscriptionModels } from "./hooks/useTranscriptionModels";
import { useWorkspace } from "./hooks/useWorkspace";
import { useVoiceActivity } from "./hooks/useVoiceActivity";
import { loadSpeechCorpusExport, ownSessions } from "./speechCorpus";

export function App() {
  const {
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
  } = useWorkspace();
  const voiceActivity = useVoiceActivity();
  const {
    soloSpeaker,
    soloSpeakerRef,
    setSoloSpeaker,
    othersRecorded,
    othersAgreed,
    setOthersAgreed,
    setOthersRecorded,
  } = useRecordingConsent({ isRecording });
  const {
    sessions,
    setSessions,
    corpusAnalysis,
    setCorpusAnalysis,
    sessionsRef,
    restorePendingRef,
    unverifiedSessionCount,
    todayStats,
    persistSessions,
    serializeSessionMutation,
  } = useSessionLibrary({ isNative });
  const {
    speakers,
    failedSpeakerDeletions,
    pendingSpeakerDeletionIds,
    speakersReady,
    isEnrolling,
    speakerLabel,
    setSpeakerLabel,
    speakerMatch,
    setSpeakerMatch,
    speakersRef,
    speakerMatchRef,
    speakerMatchInFlightRef,
    saveSpeakerProfile,
    removeSpeakerProfile,
    deleteSpeakerRemotely,
  } = useSpeakerProfiles({ setMessage, sampleRateRef, samplesRef });
  const { analysisRequest, analysisQuery, isAnalyzing } = useLiveAnalysis({
    segments,
    pauses,
    setReport,
    setReportRun,
    transcriptModelRef,
    captureRevision,
    startedAtRef,
    sampleRateRef,
    samplesRef,
    capturedSampleCountRef,
    captureDescriptorRef,
    viewedSession,
    viewedSessionRef,
  });
  const {
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
  } = useTranscriptionModels({ isRecording, isNative, setMessage });
  const {
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
  } = useChunkTranscription({
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
  });
  const { intentPredictions } = useIntentPredictions({
    segments,
    report,
    interimText,
    transcript,
    sessions,
  });
  const {
    interruptedCaptures,
    checkpointError,
    claimError,
    captureIdRef,
    workspaceClaimPendingRef,
    startPendingRef,
    takeWorkspaceCapture,
    releaseWorkspaceCapture,
    canSetAsideWorkspaceCapture,
    setAsideUnsavedCapture,
    dropInterruptedCapture,
    showSavedSession,
    recoverInterruptedCapture,
    discardInterruptedCapture,
  } = useCaptureRecovery({
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
    setInterimText,
    setMessage,
    activeSessionIdRef,
    startedAtRef,
    samplesRef,
    capturedSampleCountRef,
    captureDescriptorRef,
    sessionLanguageRef,
    loadedSessionRef,
    viewedSessionRef,
    workspaceGenerationRef,
    setViewedSession,
    isRecordingRef,
    setSessions,
    setCorpusAnalysis,
    sessionsRef,
    persistSessions,
    serializeSessionMutation,
    setSpeakerMatch,
    analysisRequest,
    analysisQuery,
    isAnalyzing,
    captureInProgress,
    cancelLiveTranscript,
    resetChunkTranscription,
  });
  const { isMatchingVoice, level, startRecording, stopRecording } = useRecording({
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
  });
  const {
    updateStoredSession,
    saveAnnotation,
    saveAdjudication,
    importAnnotationFile,
    tagContext,
    declareSessionValidation,
  } = useSessionUpdates({
    setMessage,
    loadedSessionRef,
    setViewedAudio,
    viewedSessionRef,
    setViewedSession,
    setCorpusAnalysis,
    sessionsRef,
    restorePendingRef,
    persistSessions,
    serializeSessionMutation,
  });
  const {
    referencePendingIds,
    reanalyzingSessionIds,
    reanalyzeSavedSession,
    startReferenceTranscript,
  } = useReanalysis({
    setSegments,
    setReport,
    setReportRun,
    transcriptModelRef,
    transcriptProvenanceRef,
    isNative,
    setMessage,
    loadedSessionRef,
    viewedSessionRef,
    setViewedSession,
    setCorpusAnalysis,
    sessionsRef,
    persistSessions,
    serializeSessionMutation,
    speakersRef,
    transcriptionRef,
    setLastCompute,
    captureInProgress,
    updateStoredSession,
  });
  const { saveSession } = useSessionSaving({
    segments,
    pauses,
    report,
    reportRun,
    transcriptProvenanceRef,
    setMessage,
    activeSessionIdRef,
    startedAtRef,
    sampleRateRef,
    samplesRef,
    capturedSampleCountRef,
    captureDescriptorRef,
    sessionLanguageRef,
    loadedSessionRef,
    setViewedAudio,
    keepAudio,
    viewedSessionRef,
    setViewedSession,
    setCorpusAnalysis,
    sessionsRef,
    restorePendingRef,
    persistSessions,
    serializeSessionMutation,
    isAnalyzing,
    captureInProgress,
    captureIdRef,
    releaseWorkspaceCapture,
    startReferenceTranscript,
    voiceActivityEvidenceRef: voiceActivity.evidenceRef,
  });
  const { deletingSessionId, deleteSession, restoreSessions } = useSessionRemoval({
    setSegments,
    setPauses,
    setReport,
    setReportRun,
    transcriptProvenanceRef,
    setInterimText,
    setMessage,
    activeSessionIdRef,
    startedAtRef,
    samplesRef,
    capturedSampleCountRef,
    captureDescriptorRef,
    sessionLanguageRef,
    loadedSessionRef,
    setViewedAudio,
    viewedSessionRef,
    setViewedSession,
    setSessions,
    setCorpusAnalysis,
    sessionsRef,
    restorePendingRef,
    persistSessions,
    serializeSessionMutation,
    setSpeakerMatch,
    resetChunkTranscription,
    dropInterruptedCapture,
  });

  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const speechStats = normalizedSpeechStats(report);
  const blockerStats = normalizedBlockerStats(report);
  const analyzedChunks = report.chunks ?? [];

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
        othersRecorded={othersRecorded}
        onOthersRecordedChange={setOthersRecorded}
        othersAgreed={othersAgreed}
        onOthersAgreedChange={setOthersAgreed}
      />

      <StorageProtectionNotice />

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
          voiceActivity={
            <VoiceActivityTimeline
              live={viewedSession ? null : voiceActivity.live}
              liveDescriptor={viewedSession ? null : captureDescriptorRef.current}
              evidence={
                viewedSession
                  ? (latestVoiceActivity(viewedSession)?.evidence ?? null)
                  : voiceActivity.evidence
              }
              reviewWithoutEvidence={Boolean(viewedSession && !latestVoiceActivity(viewedSession))}
              isRecording={isRecording}
              now={performance.now()}
            />
          }
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
