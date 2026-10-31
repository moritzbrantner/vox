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

// Recording other people (#66). Pressing Record covers recording the user alone, but a session
// that knowingly records others starts only after the user confirms, for that session, that
// everyone else recorded agreed. The confirmation is stored on that capture's descriptor, so it
// belongs to one session and is never carried over to the next.

/** The statement the user confirms; stored with the confirmation so the record says what was confirmed. */
export const OTHER_PARTICIPANTS_STATEMENT =
  "Everyone else in this recording has agreed to be recorded.";

export type OtherParticipantsConfirmation = {
  confirmedAt: string;
  statement: string;
};

/** What the user declared before pressing Record. */
export type ParticipantsDeclaration = {
  /** The session will knowingly record people other than the user. */
  othersRecorded: boolean;
  /** The user ticked the agreement confirmation for this session. */
  othersAgreed: boolean;
};

export const OTHER_PARTICIPANTS_REQUIRED_MESSAGE =
  "Confirm that everyone else in the recording has agreed before you start.";

/** Whether recording may start under this declaration. */
export function canStartWithParticipants(declaration: ParticipantsDeclaration) {
  return !declaration.othersRecorded || declaration.othersAgreed;
}

/**
 * The confirmation to store with a capture that is starting: null when only the user is recorded.
 * Throws when others are recorded without confirmation, so such a session cannot start.
 */
export function participantsConfirmationForStart(
  declaration: ParticipantsDeclaration,
  at: Date = new Date(),
): OtherParticipantsConfirmation | null {
  if (!declaration.othersRecorded) return null;
  if (!declaration.othersAgreed) throw new Error(OTHER_PARTICIPANTS_REQUIRED_MESSAGE);
  return { confirmedAt: at.toISOString(), statement: OTHER_PARTICIPANTS_STATEMENT };
}

/** The confirmation stored with a session's capture; null when it recorded no one else. */
export function sessionParticipantsConfirmation(session: {
  recordings: readonly { otherParticipants?: OtherParticipantsConfirmation }[];
}): OtherParticipantsConfirmation | null {
  return (
    session.recordings.find((recording) => recording.otherParticipants)?.otherParticipants ?? null
  );
}

/**
 * One line for review and export, e.g. "Other people recorded; their agreement confirmed …".
 * `confirmedAt` is null when the session declared no one else.
 */
export function describeParticipants(
  confirmedAt: string | null,
  formatTime: (iso: string) => string = (iso) => iso,
) {
  return confirmedAt
    ? `Other people recorded; their agreement confirmed ${formatTime(confirmedAt)}`
    : "No other people declared";
}

export function isOtherParticipantsConfirmation(
  value: unknown,
): value is OtherParticipantsConfirmation {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OtherParticipantsConfirmation).confirmedAt === "string" &&
    Number.isFinite(Date.parse((value as OtherParticipantsConfirmation).confirmedAt)) &&
    typeof (value as OtherParticipantsConfirmation).statement === "string" &&
    (value as OtherParticipantsConfirmation).statement.length > 0
  );
}
