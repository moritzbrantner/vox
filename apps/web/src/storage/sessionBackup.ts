import {
  type LegacySessionRecord,
  migrateSessionRecord,
  isOtherParticipantsConfirmation,
  isRunCaptureQuality,
  isVoiceActivityEvidence,
  SESSION_SCHEMA_VERSION,
  TRANSCRIPTION_ENGINES,
  transcriptObservationIds,
} from "@stutter-tracker/shared";
import type { SavedSession } from "../types";

/** Version 1 held legacy session records; version 2 holds canonical session records. */
export const SESSION_BACKUP_VERSION = 2;
const SUPPORTED_BACKUP_VERSIONS = new Set([1, 2]);
const SPEAKING_TASK_KINDS = new Set([
  "reading",
  "monologue",
  "conversation",
  "phoneCall",
  "presentation",
  "other",
]);
export const MAX_RESTORED_SESSIONS = 50;

export type SessionBackup = {
  version: typeof SESSION_BACKUP_VERSION;
  exportedAt: string;
  sessions: SavedSession[];
};

export function createSessionBackup(
  sessions: SavedSession[],
  exportedAt = new Date(),
): SessionBackup {
  return {
    version: SESSION_BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    sessions,
  };
}

export function parseSessionBackup(value: unknown): SavedSession[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error("Backup must contain a sessions array.");
  }
  if (value.version != null && !SUPPORTED_BACKUP_VERSIONS.has(value.version as number)) {
    throw new Error(`Unsupported backup version ${String(value.version)}.`);
  }
  if (value.exportedAt != null && !isValidDateString(value.exportedAt)) {
    throw new Error("Backup export timestamp is invalid.");
  }
  if (value.sessions.length > MAX_RESTORED_SESSIONS) {
    throw new Error(`Backup contains more than ${MAX_RESTORED_SESSIONS} sessions.`);
  }

  // Every session is validated before any is returned, so an import applies all or nothing.
  const ids = new Set<string>();
  return value.sessions.map((candidate, index) => {
    const session = parseStoredSession(candidate);
    if (!session) {
      throw new Error(`Backup session ${index + 1} is invalid.`);
    }
    if (ids.has(session.id)) {
      throw new Error(`Backup contains duplicate session id ${session.id}.`);
    }
    ids.add(session.id);
    return session;
  });
}

/**
 * Validates one stored or exported session and lifts legacy records into the canonical schema.
 * Returns null for malformed records; throws for a schema version this build cannot read.
 */
export function parseStoredSession(value: unknown): SavedSession | null {
  if (!isLegacySession(value)) {
    return null;
  }
  if (!("schemaVersion" in value)) {
    return migrateSessionRecord(value);
  }
  if (value.schemaVersion !== SESSION_SCHEMA_VERSION) {
    throw new Error(`Unsupported session schema version ${String(value.schemaVersion)}.`);
  }
  // Version-2 records from before annotations existed are completed with an empty history.
  return isSessionProvenance(value) ? migrateSessionRecord(value as unknown as SavedSession) : null;
}

function isSessionProvenance(value: Record<string, unknown>) {
  if (
    !(
      isSessionContext(value.context) &&
      Array.isArray(value.recordings) &&
      value.recordings.every(isRecordingDescriptor) &&
      isAnalysisRunIdentity(value.analysis) &&
      Array.isArray(value.priorAnalyses) &&
      value.priorAnalyses.every(
        (run) =>
          isAnalysisRunIdentity(run) && isAnalysisReport((run as { report: unknown }).report),
      )
    )
  ) {
    return false;
  }
  // Capture descriptors belong to this session, and every analysis run is recorded once.
  const runIds = [value.analysis, ...value.priorAnalyses].map((run) => (run as { id: string }).id);
  return (
    value.recordings.every((recording) => recording.sessionId === value.id) &&
    new Set(runIds).size === runIds.length &&
    isOptionalValidation(value.validation) &&
    isOptionalReviewCopy(value.reviewCopy) &&
    isTranscriptHistory(value) &&
    isAnnotationHistory(
      value.annotations,
      // A review copy holds revisions made against the origin's analysis runs, which it lacks.
      value.reviewCopy === undefined ? runIds : null,
      // An annotation describes the transcript revision that was current when it was made.
      new Set(transcriptObservationIds(value as unknown as SavedSession)),
    )
  );
}

/** Optional transcript revisions: well-formed, each recorded once. */
function isTranscriptHistory(value: Record<string, unknown>) {
  if (value.transcript === undefined && value.priorTranscripts === undefined) {
    return true;
  }
  const prior = value.priorTranscripts ?? [];
  if (
    !isTranscriptRevisionIdentity(value.transcript) ||
    !Array.isArray(prior) ||
    !prior.every(
      (revision) =>
        isTranscriptRevisionIdentity(revision) &&
        Array.isArray(revision.segments) &&
        revision.segments.every(isTranscriptSegment),
    )
  ) {
    return false;
  }
  const ids = [...prior, value.transcript].map((revision) => (revision as { id: string }).id);
  return new Set(ids).size === ids.length;
}

function isTranscriptRevisionIdentity(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.createdAt === null || isValidDateString(value.createdAt)) &&
    (value.kind === "provisional" || value.kind === "reference") &&
    (value.provenance === null || isTranscriptProvenance(value.provenance)) &&
    (value.supersedes === null || typeof value.supersedes === "string")
  );
}

function isTranscriptProvenance(value: unknown) {
  return (
    isRecord(value) &&
    TRANSCRIPTION_ENGINES.some((engine) => engine.id === value.engine) &&
    typeof value.model === "string" &&
    typeof value.language === "string" &&
    (value.detectedLanguage === null || typeof value.detectedLanguage === "string") &&
    isRecord(value.preprocessing) &&
    Array.isArray(value.limitations) &&
    value.limitations.every((limitation) => typeof limitation === "string") &&
    (value.compute === undefined ||
      (isRecord(value.compute) &&
        (value.compute.backend === "nativeWhisperx" || value.compute.backend === "whisperCpp") &&
        (value.compute.device === "cuda" || value.compute.device === "cpu")))
  );
}

/** Optional on older version-2 records; when present, ids are unique and references resolve. */
function isAnnotationHistory(value: unknown, runIdList: string[] | null, inputIds: Set<string>) {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value) || !value.every(isAnnotationRevision)) {
    return false;
  }
  // One pass: ids are unique, only an earlier revision can be replaced (self-references and
  // cycles would hide every revision), and each revision describes this session's observation.
  const earlier = new Set<string>();
  const runIds = runIdList && new Set(runIdList);
  for (const revision of value) {
    const id = revision.id as string;
    const adjudicates = revision.adjudicates as string[] | undefined;
    if (
      earlier.has(id) ||
      (revision.supersedes !== null && !earlier.has(revision.supersedes as string)) ||
      (runIds !== null &&
        revision.basedOnRunId !== null &&
        !runIds.has(revision.basedOnRunId as string)) ||
      (adjudicates !== undefined && !adjudicates.every((cited) => earlier.has(cited))) ||
      !inputIds.has(revision.inputId as string)
    ) {
      return false;
    }
    earlier.add(id);
  }
  return true;
}

function isAnnotationRevision(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isValidDateString(value.createdAt) &&
    isRecord(value.author) &&
    (value.author.role === "self" ||
      value.author.role === "clinician" ||
      value.author.role === "researcher") &&
    isOptionalString(value.author.id) &&
    (value.basedOnRunId === null || typeof value.basedOnRunId === "string") &&
    typeof value.inputId === "string" &&
    Array.isArray(value.events) &&
    value.events.every(isAnnotatedEvent) &&
    (value.status === "draft" || value.status === "accepted") &&
    (value.supersedes === null || typeof value.supersedes === "string") &&
    (value.adjudicates === undefined ||
      (Array.isArray(value.adjudicates) &&
        value.adjudicates.length === 2 &&
        value.adjudicates.every((id) => typeof id === "string" && id.length > 0))) &&
    (value.adjudication === undefined ||
      (value.adjudicates !== undefined && isAdjudicationRecord(value.adjudication)))
  );
}

function isAnnotationLabel(value: unknown) {
  return (
    isStutterKind(value) || value === "noSpeech" || value === "overlap" || value === "unusable"
  );
}

function isAdjudicationRecord(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.qualification === "string" &&
    value.qualification.length > 0 &&
    typeof value.rule === "string" &&
    Array.isArray(value.decisions) &&
    value.decisions.every(
      (decision) =>
        isRecord(decision) &&
        typeof decision.item === "string" &&
        ["first", "second", "adjusted", "noEvent", "uncertain"].includes(
          decision.outcome as string,
        ) &&
        (decision.outcome === "adjusted"
          ? isAnnotatedEvent(decision.event)
          : decision.event === undefined),
    )
  );
}

function isRater(value: unknown) {
  return (
    isRecord(value) &&
    (value.role === "self" || value.role === "clinician" || value.role === "researcher") &&
    isOptionalString(value.id)
  );
}

function isOptionalValidation(value: unknown) {
  return (
    value === undefined ||
    (isRecord(value) &&
      isValidDateString(value.declaredAt) &&
      Array.isArray(value.raters) &&
      value.raters.length === 2 &&
      value.raters.every(isRater))
  );
}

function isOptionalReviewCopy(value: unknown) {
  return (
    value === undefined ||
    (isRecord(value) && isValidDateString(value.exportedAt) && isValidDateString(value.importedAt))
  );
}

function isAnnotatedEvent(value: unknown) {
  return (
    isRecord(value) &&
    (isStutterKind(value.kind) ||
      value.kind === "noSpeech" ||
      value.kind === "overlap" ||
      value.kind === "unusable") &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    (value.certainty === "certain" || value.certainty === "possible") &&
    isOptionalString(value.note) &&
    (value.candidateLabels === undefined ||
      (Array.isArray(value.candidateLabels) &&
        value.candidateLabels.length === 2 &&
        value.candidateLabels.every(isAnnotationLabel)))
  );
}

function isSessionContext(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.spokenLanguage === "string" &&
    (value.task === null ||
      (isRecord(value.task) &&
        SPEAKING_TASK_KINDS.has(value.task.kind as string) &&
        typeof value.task.trained === "boolean" &&
        (value.task.description === undefined || typeof value.task.description === "string"))) &&
    (value.condition === null ||
      (isRecord(value.condition) &&
        (value.condition.kind === "unassisted" ||
          (value.condition.kind === "assisted" &&
            typeof value.condition.aidId === "string" &&
            isAssistanceSettings(value.condition.settings)))))
  );
}

function isAssistanceSettings(value: unknown) {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.values(value).every(
        (setting) =>
          typeof setting === "string" ||
          typeof setting === "boolean" ||
          (typeof setting === "number" && Number.isFinite(setting)),
      ))
  );
}

export function isRecordingDescriptor(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.runId === "string" &&
    (value.origin === "browser" ||
      value.origin === "mobile" ||
      value.origin === "desktop" ||
      value.origin === "import") &&
    (value.role === "appInput" || value.role === "interventionOutput") &&
    isFiniteNumber(value.sampleRate) &&
    value.sampleRate > 0 &&
    Number.isInteger(value.channelCount) &&
    (value.channelCount as number) > 0 &&
    isOptionalString(value.deviceRoute) &&
    isFiniteNumber(value.startOffsetSeconds) &&
    isRecord(value.preprocessing) &&
    isPreprocessingSetting(value.preprocessing.echoCancellation) &&
    isPreprocessingSetting(value.preprocessing.noiseSuppression) &&
    isPreprocessingSetting(value.preprocessing.autoGainControl) &&
    Array.isArray(value.discontinuities) &&
    value.discontinuities.every(isCaptureInterval) &&
    (value.speakerAssessment === "singleSpeakerDeclared" ||
      value.speakerAssessment === "unknown" ||
      value.speakerAssessment === "overlapDetected") &&
    (value.otherParticipants === undefined ||
      isOtherParticipantsConfirmation(value.otherParticipants))
  );
}

function isPreprocessingSetting(value: unknown) {
  return (
    isRecord(value) &&
    (value.requested === undefined || typeof value.requested === "boolean") &&
    (value.applied === undefined || typeof value.applied === "boolean")
  );
}

function isCaptureInterval(value: unknown) {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    (value.reason === "dropout" ||
      value.reason === "interrupted" ||
      value.reason === "routeChange" ||
      value.reason === "paused")
  );
}

export function isAnalysisRunIdentity(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.createdAt === null || isValidDateString(value.createdAt)) &&
    (value.analyzer === null || isAnalyzerIdentity(value.analyzer)) &&
    typeof value.inputId === "string" &&
    (value.usedAudio === null || typeof value.usedAudio === "boolean") &&
    (value.audioId === null || typeof value.audioId === "string") &&
    (value.transcription === undefined ||
      value.transcription === null ||
      isTranscriptionModelIdentity(value.transcription))
  );
}

export function isTranscriptionModelIdentity(value: unknown) {
  return (
    isRecord(value) &&
    TRANSCRIPTION_ENGINES.some((engine) => engine.id === value.engine) &&
    typeof value.model === "string" &&
    value.model.length > 0
  );
}

function isAnalyzerIdentity(value: unknown) {
  return (
    isRecord(value) &&
    (value.producer === "onDevice" ||
      value.producer === "computeServer" ||
      value.producer === "desktopNative") &&
    typeof value.algorithm === "string" &&
    (value.version === null || typeof value.version === "string")
  );
}

function isLegacySession(value: unknown): value is LegacySessionRecord & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    isValidDateString(value.startedAt) &&
    Array.isArray(value.segments) &&
    value.segments.every(isTranscriptSegment) &&
    Array.isArray(value.pauses) &&
    value.pauses.every(isPauseSpan) &&
    isAnalysisReport(value.report)
  );
}

export function isTranscriptSegment(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    typeof value.isFinal === "boolean" &&
    isOptionalFiniteNumber(value.confidence) &&
    isOptionalString(value.speakerId) &&
    isOptionalString(value.speakerLabel) &&
    isOptionalFiniteNumber(value.speakerScore) &&
    (value.alignment === undefined || value.alignment === "unaligned")
  );
}

export function isPauseSpan(value: unknown) {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    isOptionalString(value.afterText)
  );
}

export function isAnalysisReport(value: unknown) {
  return (
    isRecord(value) &&
    isOptionalDateString(value.sessionStartedAt) &&
    isNonNegativeNumber(value.totalDurationSeconds) &&
    isNonNegativeNumber(value.wordCount) &&
    isNonNegativeNumber(value.stutterCount) &&
    isNonNegativeNumber(value.stuttersPerMinute) &&
    isSeverity(value.severity) &&
    isOptionalObject(value.speechStats, isSpeechStats) &&
    isOptionalObject(value.blockerStats, isBlockerStats) &&
    isOptionalArray(value.chunks, isChunkAnalysis) &&
    Array.isArray(value.events) &&
    value.events.every(isStutterEvent) &&
    isByKind(value.byKind) &&
    isOptionalObject(value.acousticStats, isAcousticStats) &&
    (value.captureQuality === undefined || isRunCaptureQuality(value.captureQuality)) &&
    (value.voiceActivity === undefined || isVoiceActivityEvidence(value.voiceActivity))
  );
}

function isSpeechStats(value: Record<string, unknown>) {
  return (
    isNonNegativeNumber(value.speakingDurationSeconds) &&
    isNonNegativeNumber(value.pauseDurationSeconds) &&
    isNonNegativeNumber(value.wordsPerMinute) &&
    isNonNegativeNumber(value.articulationRateWpm) &&
    isNonNegativeNumber(value.meanChunkWords) &&
    isNonNegativeNumber(value.meanChunkDurationSeconds) &&
    isNonNegativeNumber(value.eventDensityPer100Words) &&
    isPercentage(value.fluencyPercentage)
  );
}

function isBlockerStats(value: Record<string, unknown>) {
  return (
    isNonNegativeNumber(value.blockCount) &&
    isNonNegativeNumber(value.totalBlockSeconds) &&
    isNonNegativeNumber(value.averageBlockSeconds) &&
    isNonNegativeNumber(value.longestBlockSeconds) &&
    isNonNegativeNumber(value.blocksPerMinute) &&
    isPercentage(value.blockedTimePercentage)
  );
}

function isChunkAnalysis(value: unknown) {
  return (
    isRecord(value) &&
    Number.isInteger(value.index) &&
    isNonNegativeNumber(value.index) &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    isNonNegativeNumber(value.durationSeconds) &&
    typeof value.text === "string" &&
    isNonNegativeNumber(value.wordCount) &&
    isNonNegativeNumber(value.stutterCount) &&
    isNonNegativeNumber(value.blockCount) &&
    isNonNegativeNumber(value.fillerCount) &&
    isNonNegativeNumber(value.wordsPerMinute) &&
    isNonNegativeNumber(value.silentPauseSeconds) &&
    isOptionalNullableFiniteNumber(value.averageConfidence)
  );
}

function isStutterEvent(value: unknown) {
  return (
    isRecord(value) &&
    isStutterKind(value.kind) &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    typeof value.text === "string" &&
    typeof value.detail === "string" &&
    isFiniteNumber(value.confidence) &&
    isEventSource(value.source) &&
    isOptionalObject(value.acousticEvidence, isAcousticEvidence)
  );
}

function isAcousticEvidence(value: Record<string, unknown>) {
  return (
    isOptionalFiniteNumber(value.energyRms) &&
    isOptionalFiniteNumber(value.silenceSeconds) &&
    isOptionalFiniteNumber(value.onsetCount) &&
    isOptionalFiniteNumber(value.onsetRate) &&
    isOptionalNullableFiniteNumber(value.pitchMeanHz) &&
    isOptionalNullableFiniteNumber(value.pitchStability) &&
    isOptionalFiniteNumber(value.spectralCentroidHz) &&
    isOptionalFiniteNumber(value.zeroCrossingRate)
  );
}

function isAcousticStats(value: Record<string, unknown>) {
  return (
    isNonNegativeNumber(value.analyzedDurationSeconds) &&
    isNonNegativeNumber(value.speechDurationSeconds) &&
    isNonNegativeNumber(value.silenceDurationSeconds) &&
    isNonNegativeNumber(value.voiceActivityRatio) &&
    isNonNegativeNumber(value.onsetCount) &&
    isNonNegativeNumber(value.meanOnsetRate) &&
    isNonNegativeNumber(value.meanRms) &&
    isNonNegativeNumber(value.noiseFloorRms)
  );
}

function isByKind(value: unknown) {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([kind, count]) => isStutterKind(kind) && isNonNegativeNumber(count),
    )
  );
}

function isSeverity(value: unknown) {
  return value === "none" || value === "mild" || value === "moderate" || value === "high";
}

function isStutterKind(value: unknown) {
  return (
    value === "wordRepetition" ||
    value === "soundRepetition" ||
    value === "prolongation" ||
    value === "block" ||
    value === "filler"
  );
}

function isEventSource(value: unknown) {
  return value == null || value === "transcript" || value === "acoustic" || value === "fused";
}

function isOptionalArray(value: unknown, predicate: (item: unknown) => boolean) {
  return value == null || (Array.isArray(value) && value.every(predicate));
}

function isOptionalObject(value: unknown, predicate: (item: Record<string, unknown>) => boolean) {
  return value == null || (isRecord(value) && predicate(value));
}

function isOptionalString(value: unknown) {
  return value == null || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown) {
  return value == null || isFiniteNumber(value);
}

function isOptionalNullableFiniteNumber(value: unknown) {
  return value == null || isFiniteNumber(value);
}

function isOptionalDateString(value: unknown) {
  return value == null || isValidDateString(value);
}

export function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPercentage(value: unknown) {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
