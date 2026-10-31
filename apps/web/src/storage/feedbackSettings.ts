import {
  type AuditoryFeedbackSettings,
  DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
} from "../audio/auditoryFeedback";
import { clampLabSettings } from "../audio/feedbackControls";
import { appStorage } from "./protectedStorage";

export const FEEDBACK_SETTINGS_KEY = "stutter-tracker:auditory-feedback-settings";

/** Restores the last lab settings exactly, clamped to the lab ranges; defaults when absent. */
export function loadFeedbackSettings(storage?: Storage): AuditoryFeedbackSettings {
  try {
    // Resolved inside the guard: reading `localStorage` itself throws where storage is blocked.
    const target = storage ?? appStorage();
    const parsed = JSON.parse(target.getItem(FEEDBACK_SETTINGS_KEY) ?? "null") as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_AUDITORY_FEEDBACK_SETTINGS;
    }
    return clampLabSettings({
      ...DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
      ...pickNumbers(parsed as Record<string, unknown>),
    });
  } catch {
    return DEFAULT_AUDITORY_FEEDBACK_SETTINGS;
  }
}

export function saveFeedbackSettings(settings: AuditoryFeedbackSettings, storage?: Storage) {
  try {
    (storage ?? appStorage()).setItem(FEEDBACK_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: settings last for this page only.
  }
}

function pickNumbers(value: Record<string, unknown>): Partial<AuditoryFeedbackSettings> {
  const keys = Object.keys(
    DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
  ) as (keyof AuditoryFeedbackSettings)[];
  return Object.fromEntries(
    keys.filter((key) => typeof value[key] === "number").map((key) => [key, value[key]]),
  );
}
