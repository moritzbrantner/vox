// Outcome schema for intended-use decision record v0.1 (docs/intended-use.md).
// Outcomes are reported per measure; there is deliberately no combined severity score.

/** Speech-analysis languages in rollout order. None is validated yet. */
export const SPEECH_LANGUAGE_ROLLOUT = [
  { code: "en", stage: "first", validated: false },
  { code: "de", stage: "later", validated: false },
  { code: "es", stage: "later", validated: false },
] as const;

/**
 * "available": works the same in every language (nothing language-specific to evaluate);
 * "evaluated": has evaluation evidence for this language; "notEvaluated": runs, unmeasured.
 */
export type CapabilityStatus = "available" | "evaluated" | "notEvaluated" | "notAvailable";

export type LanguageCapabilities = {
  recordingAndReview: CapabilityStatus;
  transcription: CapabilityStatus;
  eventDetection: CapabilityStatus;
  reviewedPractice: CapabilityStatus;
  /** What the statuses mean for this language. */
  note: string;
};

/**
 * Published per-language capability matrix (vox#28). A capability is "evaluated" only with
 * evaluation evidence for that language; a translated interface or a multilingual model is not.
 */
export const LANGUAGE_CAPABILITIES: Record<"en" | "de" | "es", LanguageCapabilities> = {
  en: {
    recordingAndReview: "available",
    transcription: "notEvaluated",
    eventDetection: "notEvaluated",
    reviewedPractice: "notAvailable",
    note: "First language. Transcription and event detection run but have no disfluency-specific evaluation yet; no clinician-reviewed practice exists.",
  },
  de: {
    recordingAndReview: "available",
    transcription: "notEvaluated",
    eventDetection: "notEvaluated",
    reviewedPractice: "notAvailable",
    note: "Later language. Event detection uses rules written for English plus a few German fillers; results are not validated for German.",
  },
  es: {
    recordingAndReview: "available",
    transcription: "notEvaluated",
    eventDetection: "notEvaluated",
    reviewedPractice: "notAvailable",
    note: "Later language. Browser speech recognition is not offered for Spanish; Whisper models can transcribe it. Event detection is not validated for Spanish.",
  },
};

/** Capabilities of a spoken language; other and unknown languages have none evaluated. */
export function languageCapabilities(tag: SpokenLanguage): LanguageCapabilities {
  const language = canonicalSpokenLanguage(tag);
  return (
    LANGUAGE_CAPABILITIES[language as keyof typeof LANGUAGE_CAPABILITIES] ?? {
      recordingAndReview: "available",
      transcription: "notEvaluated",
      eventDetection: "notAvailable",
      reviewedPractice: "notAvailable",
      note:
        language === UNKNOWN_SPOKEN_LANGUAGE
          ? "The spoken language is not recorded, so no language-specific result applies."
          : "Not in the rollout. Recording and manual review work; automated results are not interpreted for this language.",
    }
  );
}

/** BCP-47 primary language subtag of the recorded speech, or "unknown". Never the UI language. */
export type SpokenLanguage = string;
export const UNKNOWN_SPOKEN_LANGUAGE = "unknown";

export type SpeechLanguageSupport = "first" | "later" | "unsupported" | "unknown";

export function speechLanguageSupport(tag: SpokenLanguage): SpeechLanguageSupport {
  const language = canonicalSpokenLanguage(tag);
  if (language === UNKNOWN_SPOKEN_LANGUAGE) return "unknown";
  const entry = SPEECH_LANGUAGE_ROLLOUT.find((candidate) => candidate.code === language);
  return entry ? entry.stage : "unsupported";
}

/**
 * The spoken language is recorded explicitly per session. The interface language is
 * accepted only to make the separation visible: it is never used as a fallback.
 */
export function resolveSpokenLanguage(input: {
  declaredSpokenLanguage?: string | null;
  interfaceLanguage?: string | null;
}): SpokenLanguage {
  return canonicalSpokenLanguage(input.declaredSpokenLanguage);
}

/** Lowercased primary BCP-47 subtag ("en-US" -> "en"); blank or malformed becomes "unknown". */
export function canonicalSpokenLanguage(tag: string | null | undefined): SpokenLanguage {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(primary) ? primary : UNKNOWN_SPOKEN_LANGUAGE;
}

export type BenefitHorizon = "duringAssistance" | "transfer" | "maintenance";

export type OutcomeMeasure =
  | "communicationGoal"
  | "effort"
  | "naturalness"
  | "participation"
  | "eventBurden"
  | "eventDuration";

export type OutcomeSource = "observed" | "selfReported" | "clinicianRated";

export type AssistanceCondition =
  | { kind: "unassisted" }
  | { kind: "assisted"; aidId: string; settings?: Record<string, number | string | boolean> };

export type SpeakingTask = {
  kind: "reading" | "monologue" | "conversation" | "phoneCall" | "presentation" | "other";
  /** Whether this task was practised; untrained tasks measure transfer. */
  trained: boolean;
  description?: string;
};

export type OutcomeScale = {
  min: number;
  max: number;
  /** "lower" for effort/discomfort, event burden and duration. */
  betterDirection: "higher" | "lower";
  /** "events" means a count over the sample; it is compared as events per minute. */
  unit?: string;
  /** Validated instruments are only referenced by id after licensing review; never by text. */
  instrumentId?: string;
};

export type OutcomeObservation = {
  id: string;
  sessionId?: string;
  recordedAt: string;
  measure: OutcomeMeasure;
  source: OutcomeSource;
  value: number;
  scale: OutcomeScale;
  condition: AssistanceCondition;
  horizon: BenefitHorizon;
  task: SpeakingTask;
  spokenLanguage: SpokenLanguage;
  sampleDurationSeconds: number;
  /**
   * Capture-quality state of the session an observed measure was derived from. Observed values
   * from a capture whose quality is "unknown" are not scores and are left out of comparisons.
   */
  captureQuality?: "usable" | "unknown" | "unmeasured";
};

export type OutcomeChange = "better" | "worse" | "noClearChange" | "insufficientData";

export type OutcomeComparison = {
  measure: OutcomeMeasure;
  source: OutcomeSource;
  horizon: BenefitHorizon;
  condition: AssistanceCondition;
  spokenLanguage: SpokenLanguage;
  task: SpeakingTask;
  scale: OutcomeScale;
  /** Unit of baseline/latest: "events/min" for count scales (normalized by sample duration). */
  valueUnit?: string;
  baseline?: number;
  latest?: number;
  observationCount: number;
  change: OutcomeChange;
  statement: string;
};

export type OutcomeReport = {
  comparisons: OutcomeComparison[];
  /** Observations left out because their timestamp or sample duration is invalid. */
  excludedObservationIds: string[];
  /** Observed values left out because their capture quality is unknown. */
  unknownCaptureObservationIds: string[];
  limitations: string[];
};

export const OUTCOME_REPORT_LIMITATIONS = [
  "This app has not demonstrated a cure or treatment efficacy.",
  "Changes can come from the task, the day, recording quality or analysis versions, not only from practice or an aid.",
  "Self-ratings are personal observations, not validated clinical measures.",
] as const;

const MEASURE_LABELS: Record<OutcomeMeasure, string> = {
  communicationGoal: "Communication goal",
  effort: "Speaking effort",
  naturalness: "Naturalness",
  participation: "Participation",
  eventBurden: "Event burden",
  eventDuration: "Event duration",
};

/**
 * Compares the earliest and latest observation inside groups that share measure, source,
 * horizon, condition (aid and settings), spoken language, task (kind and trained) and scale.
 * Groups are never mixed, so a different aid, language, task, trained-vs-transfer task or
 * scale cannot masquerade as improvement.
 * `minimumChangeFraction` is the share of the scale range treated as no clear change.
 */
export function summarizeOutcomes(
  observations: OutcomeObservation[],
  options: { minimumChangeFraction?: number } = {},
): OutcomeReport {
  const threshold = options.minimumChangeFraction ?? 0.1;
  const groups = new Map<string, OutcomeObservation[]>();
  const excludedObservationIds: string[] = [];
  const unknownCaptureObservationIds: string[] = [];
  for (const observation of observations) {
    // Self- and clinician ratings do not depend on the recording; observed values do.
    if (observation.source === "observed" && observation.captureQuality === "unknown") {
      unknownCaptureObservationIds.push(observation.id);
      continue;
    }
    const countBased = observation.scale.unit === "events";
    if (
      !Number.isFinite(Date.parse(observation.recordedAt)) ||
      !Number.isFinite(observation.value) ||
      (countBased &&
        (observation.value < 0 ||
          !Number.isFinite(observation.sampleDurationSeconds) ||
          observation.sampleDurationSeconds <= 0))
    ) {
      excludedObservationIds.push(observation.id);
      continue;
    }
    const { condition, scale, task } = observation;
    const key = JSON.stringify([
      observation.measure,
      observation.source,
      observation.horizon,
      condition.kind,
      condition.kind === "assisted" ? condition.aidId : null,
      condition.kind === "assisted" ? sortedEntries(condition.settings) : null,
      canonicalSpokenLanguage(observation.spokenLanguage),
      task.kind,
      task.trained,
      scale.min,
      scale.max,
      scale.betterDirection,
      scale.unit ?? null,
      scale.instrumentId ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }

  const comparisons = [...groups.values()].map((group): OutcomeComparison => {
    const ordered = [...group].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const base = {
      measure: first.measure,
      source: first.source,
      horizon: first.horizon,
      condition: first.condition,
      spokenLanguage: canonicalSpokenLanguage(first.spokenLanguage),
      task: first.task,
      scale: first.scale,
      observationCount: ordered.length,
    };
    const conditionLabel =
      first.condition.kind === "assisted" ? `assisted: ${first.condition.aidId}` : "unassisted";
    const taskLabel = `${first.task.trained ? "trained" : "untrained"} ${first.task.kind}`;
    const label = `${MEASURE_LABELS[first.measure]} (${first.source}, ${conditionLabel}, ${taskLabel}, ${base.spokenLanguage})`;
    const countBased = first.scale.unit === "events";
    const comparable = (observation: OutcomeObservation) =>
      countBased
        ? round2(observation.value / (observation.sampleDurationSeconds / 60))
        : observation.value;
    if (ordered.length < 2) {
      return {
        ...base,
        valueUnit: countBased ? "events/min" : first.scale.unit,
        latest: comparable(last),
        change: "insufficientData",
        statement: `${label}: only one observation, no comparison yet.`,
      };
    }
    const baseline = comparable(first);
    const latest = comparable(last);
    // Rates have no fixed range, so a change is judged relative to the larger rate.
    const range = Math.max(
      countBased
        ? Math.max(Math.abs(baseline), Math.abs(latest))
        : first.scale.max - first.scale.min,
      Number.EPSILON,
    );
    const delta = latest - baseline;
    const improvement = first.scale.betterDirection === "higher" ? delta : -delta;
    const change: OutcomeChange =
      Math.abs(delta) / range < threshold ? "noClearChange" : improvement > 0 ? "better" : "worse";
    const wording = {
      better: "better than",
      worse: "worse than",
      noClearChange: "no clear change from",
      insufficientData: "",
    }[change];
    return {
      ...base,
      valueUnit: countBased ? "events/min" : first.scale.unit,
      baseline,
      latest,
      change,
      statement: `${label}: ${latest}${countBased ? " events/min" : ""} is ${wording} the first observation ${baseline} across ${ordered.length} observations.`,
    };
  });

  const limitations: string[] = [...OUTCOME_REPORT_LIMITATIONS];
  if (unknownCaptureObservationIds.length) {
    const count = unknownCaptureObservationIds.length;
    limitations.push(
      `${count} observed value${count === 1 ? " was" : "s were"} left out because the capture quality was unknown.`,
    );
  }
  return { comparisons, excludedObservationIds, unknownCaptureObservationIds, limitations };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function sortedEntries(settings: Record<string, unknown> | undefined) {
  return Object.entries(settings ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

/** Plain-language limits and signposting for help/onboarding surfaces. */
export const INTENDED_USE_NOTICE = {
  scope:
    "Stutter Tracker helps you record and review your own speech. It is not a diagnosis, treatment or cure.",
  signposting:
    "For assessment or therapy, talk to a speech-language therapist who specialises in stuttering. Seek prompt professional assessment if stuttering started recently or in a child.",
  stop: "Stop any exercise or feedback that causes discomfort, distress or makes speaking harder.",
} as const;
