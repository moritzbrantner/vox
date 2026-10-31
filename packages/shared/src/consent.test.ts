import { describe, expect, test } from "bun:test";

import {
  canStartWithParticipants,
  CONSENT_PURPOSES,
  type ConsentDecision,
  isOtherParticipantsConfirmation,
  OTHER_PARTICIPANTS_STATEMENT,
  participantsConfirmationForStart,
  sessionParticipantsConfirmation,
  ConsentRequiredError,
  currentConsent,
  EMPTY_CONSENT_LEDGER,
  hasConsent,
  parseConsentLedger,
  recordConsent,
  requireConsent,
  withdrawOtherScopes,
} from "./consent";

const server = "https://compute.example.com";

describe("consent ledger", () => {
  test("denies every purpose by default", () => {
    for (const purpose of CONSENT_PURPOSES) {
      expect(hasConsent(EMPTY_CONSENT_LEDGER, purpose)).toBe(false);
      expect(() => requireConsent(EMPTY_CONSENT_LEDGER, purpose)).toThrow(ConsentRequiredError);
    }
  });

  test("grants apply only to the exact purpose and scope", () => {
    const ledger = recordConsent(EMPTY_CONSENT_LEDGER, {
      purpose: "remoteAnalysis",
      granted: true,
      scope: server,
    });

    expect(hasConsent(ledger, "remoteAnalysis", server)).toBe(true);
    expect(hasConsent(ledger, "remoteAnalysis", "https://other.example.com")).toBe(false);
    expect(hasConsent(ledger, "researchContribution", server)).toBe(false);
    expect(hasConsent(ledger, "modelTraining")).toBe(false);
  });

  test("revocation is appended and wins for future checks without erasing history", () => {
    const granted = recordConsent(EMPTY_CONSENT_LEDGER, {
      purpose: "clinicianSharing",
      granted: true,
      at: new Date("2026-10-01T00:00:00.000Z"),
    });
    const revoked = recordConsent(granted, {
      purpose: "clinicianSharing",
      granted: false,
      at: new Date("2026-10-02T00:00:00.000Z"),
    });

    expect(hasConsent(revoked, "clinicianSharing")).toBe(false);
    expect(currentConsent(revoked, "clinicianSharing")?.at).toBe("2026-10-02T00:00:00.000Z");
    expect(revoked).toHaveLength(2);
    expect(granted).toHaveLength(1);
  });

  test("explicit denial is recorded and stays a denial", () => {
    const ledger = recordConsent(EMPTY_CONSENT_LEDGER, {
      purpose: "modelTraining",
      granted: false,
    });
    expect(currentConsent(ledger, "modelTraining")?.granted).toBe(false);
    expect(() => requireConsent(ledger, "modelTraining")).toThrow("modelTraining needs consent");
  });

  test("rejects the whole ledger when any entry is malformed", () => {
    const grant: ConsentDecision = {
      purpose: "remoteAnalysis",
      granted: true,
      at: "2026-10-01T00:00:00.000Z",
      scope: server,
    };
    expect(parseConsentLedger([grant])).toEqual([grant]);
    // A corrupted withdrawal must not let the older grant resurface.
    for (const corrupt of [
      { purpose: "remoteAnalysis", granted: false, at: "not a date", scope: server },
      { purpose: "remoteAnalysis", granted: false, at: "2026-10-02T00:00:00.000Z" },
      { purpose: "remoteAnalysis", granted: false, at: "2026-10-02T00:00:00.000Z", scope: "" },
      { purpose: "clinicianSharing", granted: false, at: "2026-10-02T00:00:00.000Z", scope: "x" },
      {
        purpose: "remoteAnalysis",
        granted: false,
        at: "2026-10-02T00:00:00.000Z",
        scope: "ftp://x",
      },
      { purpose: "everything", granted: true, at: "2026-10-01T00:00:00.000Z", scope: "" },
      { purpose: "modelTraining", granted: "yes", at: "2026-10-01T00:00:00.000Z", scope: "" },
      null,
    ]) {
      expect(parseConsentLedger([grant, corrupt])).toBeNull();
    }
    expect(parseConsentLedger({ not: "an array" })).toBeNull();
  });

  test("withdraws grants for other scopes of the same purpose only", () => {
    let ledger = recordConsent(EMPTY_CONSENT_LEDGER, {
      purpose: "remoteAnalysis",
      granted: true,
      scope: "https://a.example.com",
    });
    ledger = recordConsent(ledger, { purpose: "clinicianSharing", granted: true });
    const moved = withdrawOtherScopes(ledger, "remoteAnalysis", "https://b.example.com");

    expect(hasConsent(moved, "remoteAnalysis", "https://a.example.com")).toBe(false);
    expect(hasConsent(moved, "clinicianSharing")).toBe(true);
    expect(withdrawOtherScopes(moved, "remoteAnalysis", "https://b.example.com")).toBe(moved);
  });

  test("requires an http(s) server URL as the remote-analysis scope", () => {
    expect(() =>
      recordConsent(EMPTY_CONSENT_LEDGER, { purpose: "remoteAnalysis", granted: true }),
    ).toThrow("http(s) server URL");
    expect(() =>
      recordConsent(EMPTY_CONSENT_LEDGER, { purpose: "modelTraining", granted: false }),
    ).not.toThrow();
    expect(() =>
      recordConsent(EMPTY_CONSENT_LEDGER, { purpose: "modelTraining", granted: true, scope: "x" }),
    ).toThrow("not scoped");
  });

  test("rejects recording an unknown purpose", () => {
    expect(() =>
      recordConsent(EMPTY_CONSENT_LEDGER, { purpose: "recording" as never, granted: true }),
    ).toThrow("Unknown consent purpose");
  });
});

describe("recording other participants", () => {
  const at = new Date("2026-10-31T10:00:00.000Z");

  test("recording only the user needs no confirmation and stores none", () => {
    const solo = { othersRecorded: false, othersAgreed: false };
    expect(canStartWithParticipants(solo)).toBe(true);
    expect(participantsConfirmationForStart(solo, at)).toBeNull();
  });

  test("a session that records others cannot start until the user confirms", () => {
    const unconfirmed = { othersRecorded: true, othersAgreed: false };
    expect(canStartWithParticipants(unconfirmed)).toBe(false);
    expect(() => participantsConfirmationForStart(unconfirmed, at)).toThrow("has agreed");
  });

  test("a confirmed start records when and what was confirmed", () => {
    const confirmation = participantsConfirmationForStart(
      { othersRecorded: true, othersAgreed: true },
      at,
    );
    expect(confirmation).toEqual({
      confirmedAt: "2026-10-31T10:00:00.000Z",
      statement: OTHER_PARTICIPANTS_STATEMENT,
    });
    expect(isOtherParticipantsConfirmation(confirmation)).toBe(true);
    expect(
      sessionParticipantsConfirmation({ recordings: [{}, { otherParticipants: confirmation! }] }),
    ).toBe(confirmation);
    expect(sessionParticipantsConfirmation({ recordings: [{}] })).toBeNull();
  });

  test("rejects malformed stored confirmations", () => {
    expect(isOtherParticipantsConfirmation({ confirmedAt: "never", statement: "x" })).toBe(false);
    expect(isOtherParticipantsConfirmation({ confirmedAt: at.toISOString(), statement: "" })).toBe(
      false,
    );
  });
});
