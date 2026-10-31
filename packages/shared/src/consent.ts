// Consent ledger for data that leaves the device. On-device recording needs no entry: pressing
// Record is the consent (owner decision on #54). Every purpose here is denied until granted.

export type ConsentPurpose =
  | "remoteAnalysis"
  | "clinicianSharing"
  | "researchContribution"
  | "modelTraining";

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  "remoteAnalysis",
  "clinicianSharing",
  "researchContribution",
  "modelTraining",
];

export type ConsentDecision = {
  purpose: ConsentPurpose;
  granted: boolean;
  /** When the decision was made; decisions migrated from older storage use the migration time. */
  at: string;
  /** What the decision covers, e.g. the exact server URL for remote analysis. */
  scope: string;
};

/** Append-only: a revocation is a new entry, so history shows what was allowed when. */
export type ConsentLedger = readonly ConsentDecision[];

export const EMPTY_CONSENT_LEDGER: ConsentLedger = [];

export class ConsentRequiredError extends Error {
  constructor(
    readonly purpose: ConsentPurpose,
    readonly scope: string,
  ) {
    super(`${purpose} needs consent${scope ? ` for ${scope}` : ""}`);
  }
}

export function recordConsent(
  ledger: ConsentLedger,
  decision: { purpose: ConsentPurpose; granted: boolean; scope?: string; at?: Date },
): ConsentLedger {
  if (!CONSENT_PURPOSES.includes(decision.purpose)) {
    throw new Error(`Unknown consent purpose ${String(decision.purpose)}.`);
  }
  if (!isValidScope(decision.purpose, decision.scope ?? "")) {
    throw new Error(
      decision.purpose === "remoteAnalysis"
        ? "Remote analysis consent needs an http(s) server URL as its scope."
        : `${decision.purpose} consent is not scoped.`,
    );
  }
  return [
    ...ledger,
    {
      purpose: decision.purpose,
      granted: decision.granted,
      at: (decision.at ?? new Date()).toISOString(),
      scope: decision.scope ?? "",
    },
  ];
}

/**
 * Appends a withdrawal for every currently granted scope of `purpose` except `keepScope`, e.g.
 * when consent moves to another server, so returning to an earlier one needs consent again.
 */
export function withdrawOtherScopes(
  ledger: ConsentLedger,
  purpose: ConsentPurpose,
  keepScope: string,
  at?: Date,
): ConsentLedger {
  const scopes = new Set(
    ledger
      .filter((entry) => entry.purpose === purpose && entry.scope !== keepScope)
      .map((entry) => entry.scope),
  );
  let next = ledger;
  for (const scope of scopes) {
    if (hasConsent(next, purpose, scope)) {
      next = recordConsent(next, { purpose, granted: false, scope, at });
    }
  }
  return next;
}

/** The latest decision for this purpose and exact scope; none means denied. */
export function currentConsent(
  ledger: ConsentLedger,
  purpose: ConsentPurpose,
  scope = "",
): ConsentDecision | null {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const decision = ledger[index];
    if (decision.purpose === purpose && decision.scope === scope) {
      return decision;
    }
  }
  return null;
}

export function hasConsent(ledger: ConsentLedger, purpose: ConsentPurpose, scope = "") {
  return currentConsent(ledger, purpose, scope)?.granted === true;
}

/** Throws unless the latest decision for exactly this purpose and scope is a grant. */
export function requireConsent(ledger: ConsentLedger, purpose: ConsentPurpose, scope = "") {
  if (!hasConsent(ledger, purpose, scope)) {
    throw new ConsentRequiredError(purpose, scope);
  }
}

/**
 * Reads a ledger from untrusted storage. Any malformed entry makes the whole ledger unreadable
 * (null): dropping just that entry could expose an older grant that a corrupted withdrawal
 * superseded. Callers treat null as "no consent".
 */
export function parseConsentLedger(value: unknown): ConsentLedger | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every(isConsentDecision) ? value : null;
}

function isConsentDecision(entry: unknown): entry is ConsentDecision {
  return (
    typeof entry === "object" &&
    entry !== null &&
    CONSENT_PURPOSES.includes((entry as ConsentDecision).purpose) &&
    typeof (entry as ConsentDecision).granted === "boolean" &&
    typeof (entry as ConsentDecision).at === "string" &&
    Number.isFinite(Date.parse((entry as ConsentDecision).at)) &&
    typeof (entry as ConsentDecision).scope === "string" &&
    isValidScope((entry as ConsentDecision).purpose, (entry as ConsentDecision).scope)
  );
}

/**
 * Remote analysis is always scoped to one http(s) server; the other purposes are unscoped, so a
 * non-empty scope there is corruption that could otherwise hide a withdrawal.
 */
function isValidScope(purpose: ConsentPurpose, scope: string) {
  if (purpose !== "remoteAnalysis") {
    return scope === "";
  }
  try {
    const url = new URL(scope);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Recording other people (#66, #151). Pressing Record covers recording the user alone, but a
// session that knowingly records others starts only after the user lists each other person and
// confirms, one by one, that they agreed. The confirmations are stored on that capture's
// descriptor, so they belong to one session and are never carried over to the next.

/** One other person's recorded agreement, as stored with the capture. */
export type ParticipantConfirmation = {
  /** The short label or name the user gave this person. */
  label: string;
  /** When the user confirmed this person's agreement. */
  confirmedAt: string;
  /** The statement the user confirmed, so the record says what was confirmed. */
  statement: string;
};

/** A person the user listed before recording; `confirmedAt` is null until confirmed. */
export type DeclaredParticipant = {
  id: string;
  label: string;
  confirmedAt: string | null;
};

/** What the user declared before pressing Record. */
export type ParticipantsDeclaration = {
  /** The session will knowingly record people other than the user. */
  othersRecorded: boolean;
  /** Each other person, with their confirmation for this session. */
  participants: readonly DeclaredParticipant[];
};

/** Label given to a confirmation saved before consent was per participant. */
export const LEGACY_PARTICIPANTS_LABEL = "Everyone else (before per-participant consent)";

export const OTHER_PARTICIPANTS_REQUIRED_MESSAGE =
  "Add each other person and confirm they agreed before you start.";

/** The statement the user confirms for one participant. */
export function participantStatement(label: string) {
  return `${label} has agreed to be recorded.`;
}

/** Appends an unconfirmed participant. Blank and already-listed labels are ignored. */
export function addParticipant(
  participants: readonly DeclaredParticipant[],
  label: string,
  id: string,
): DeclaredParticipant[] {
  const trimmed = label.trim();
  const taken = participants.some(
    (participant) => participant.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (!trimmed || taken) return [...participants];
  return [...participants, { id, label: trimmed, confirmedAt: null }];
}

/** Confirms (with the time) or unconfirms one participant. */
export function confirmParticipant(
  participants: readonly DeclaredParticipant[],
  id: string,
  confirmed: boolean,
  at: Date = new Date(),
): DeclaredParticipant[] {
  return participants.map((participant) =>
    participant.id === id
      ? { ...participant, confirmedAt: confirmed ? at.toISOString() : null }
      : participant,
  );
}

export function removeParticipant(
  participants: readonly DeclaredParticipant[],
  id: string,
): DeclaredParticipant[] {
  return participants.filter((participant) => participant.id !== id);
}

/** Recording may start once at least one other person is listed and every one is confirmed. */
export function canStartWithParticipants(declaration: ParticipantsDeclaration) {
  return (
    !declaration.othersRecorded ||
    (declaration.participants.length > 0 &&
      declaration.participants.every((participant) => participant.confirmedAt !== null))
  );
}

/**
 * The confirmations to store with a capture that is starting: null when only the user is
 * recorded. Throws when anyone listed is unconfirmed, so such a session cannot start.
 */
export function participantsConfirmationForStart(
  declaration: ParticipantsDeclaration,
): ParticipantConfirmation[] | null {
  if (!declaration.othersRecorded) return null;
  if (!canStartWithParticipants(declaration)) throw new Error(OTHER_PARTICIPANTS_REQUIRED_MESSAGE);
  return declaration.participants.map((participant) => ({
    label: participant.label,
    confirmedAt: participant.confirmedAt!,
    statement: participantStatement(participant.label),
  }));
}

/** The confirmations stored with a session's capture; null when it recorded no one else. */
export function sessionParticipants(session: {
  recordings: readonly { otherParticipants?: readonly ParticipantConfirmation[] }[];
}): readonly ParticipantConfirmation[] | null {
  return (
    session.recordings.find((recording) => recording.otherParticipants?.length)
      ?.otherParticipants ?? null
  );
}

/**
 * One line for review and export, e.g. "Other people recorded: Robin (agreed …), Sam (agreed …)".
 * `participants` is null when the session declared no one else.
 */
export function describeParticipants(
  participants: readonly { label: string; confirmedAt: string }[] | null,
  formatTime: (iso: string) => string = (iso) => iso,
) {
  if (!participants?.length) return "No other people declared";
  const each = participants.map(
    (participant) => `${participant.label} (agreed ${formatTime(participant.confirmedAt)})`,
  );
  return `Other people recorded: ${each.join(", ")}`;
}

export function isParticipantConfirmation(value: unknown): value is ParticipantConfirmation {
  return (
    isLegacyConfirmation(value) &&
    typeof (value as ParticipantConfirmation).label === "string" &&
    (value as ParticipantConfirmation).label.trim().length > 0
  );
}

/**
 * Reads stored confirmations: a non-empty list, or the single confirmation saved before consent
 * was per participant, which becomes one entry labelled `LEGACY_PARTICIPANTS_LABEL`. Null when
 * malformed.
 */
export function parseOtherParticipants(value: unknown): ParticipantConfirmation[] | null {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isParticipantConfirmation) ? value : null;
  }
  if (!isLegacyConfirmation(value)) return null;
  return [
    {
      label: LEGACY_PARTICIPANTS_LABEL,
      confirmedAt: value.confirmedAt,
      statement: value.statement,
    },
  ];
}

/** Lifts a stored descriptor's single legacy confirmation into the per-participant list. */
export function migrateRecordingParticipants<T extends { otherParticipants?: unknown }>(
  recording: T,
): Omit<T, "otherParticipants"> & { otherParticipants?: ParticipantConfirmation[] } {
  if (recording.otherParticipants === undefined || Array.isArray(recording.otherParticipants)) {
    return recording as T & { otherParticipants?: ParticipantConfirmation[] };
  }
  const migrated = parseOtherParticipants(recording.otherParticipants);
  if (!migrated) throw new Error("Stored participant confirmation is malformed.");
  return { ...recording, otherParticipants: migrated };
}

function isLegacyConfirmation(value: unknown): value is { confirmedAt: string; statement: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ParticipantConfirmation).confirmedAt === "string" &&
    Number.isFinite(Date.parse((value as ParticipantConfirmation).confirmedAt)) &&
    typeof (value as ParticipantConfirmation).statement === "string" &&
    (value as ParticipantConfirmation).statement.length > 0
  );
}
