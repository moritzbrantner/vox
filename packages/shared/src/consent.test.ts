import { describe, expect, test } from "bun:test";

import {
  addParticipant,
  canStartWithParticipants,
  confirmParticipant,
  CONSENT_PURPOSES,
  type ConsentDecision,
  describeParticipants,
  LEGACY_PARTICIPANTS_LABEL,
  migrateRecordingParticipants,
  parseOtherParticipants,
  participantsConfirmationForStart,
  removeParticipant,
  sessionParticipants,
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
  const robinAt = new Date("2026-10-31T10:00:00.000Z");
  const samAt = new Date("2026-10-31T10:01:00.000Z");

  test("recording only the user needs no confirmation and stores none", () => {
    const solo = { othersRecorded: false, participants: [] };
    expect(canStartWithParticipants(solo)).toBe(true);
    expect(participantsConfirmationForStart(solo)).toBeNull();
  });

  test("recording others needs at least one listed participant", () => {
    const nobody = { othersRecorded: true, participants: [] };
    expect(canStartWithParticipants(nobody)).toBe(false);
    expect(() => participantsConfirmationForStart(nobody)).toThrow("Add each other person");
  });

  test("every listed participant must be confirmed, and adding one re-blocks", () => {
    let participants = addParticipant([], " Robin ", "p1");
    expect(participants).toEqual([{ id: "p1", label: "Robin", confirmedAt: null }]);
    expect(canStartWithParticipants({ othersRecorded: true, participants })).toBe(false);

    participants = confirmParticipant(participants, "p1", true, robinAt);
    expect(canStartWithParticipants({ othersRecorded: true, participants })).toBe(true);

    participants = addParticipant(participants, "Sam", "p2");
    expect(canStartWithParticipants({ othersRecorded: true, participants })).toBe(false);
    participants = confirmParticipant(participants, "p2", true, samAt);
    expect(canStartWithParticipants({ othersRecorded: true, participants })).toBe(true);

    expect(
      canStartWithParticipants({
        othersRecorded: true,
        participants: confirmParticipant(participants, "p1", false),
      }),
    ).toBe(false);
    expect(removeParticipant(participants, "p2").map((participant) => participant.id)).toEqual([
      "p1",
    ]);
  });

  test("ignores blank and already-listed labels", () => {
    const participants = addParticipant([], "Robin", "p1");
    expect(addParticipant(participants, "  ", "p2")).toEqual(participants);
    expect(addParticipant(participants, "robin", "p2")).toEqual(participants);
  });

  test("a confirmed start stores each participant with their own confirmation time", () => {
    let participants = addParticipant(addParticipant([], "Robin", "p1"), "Sam", "p2");
    participants = confirmParticipant(participants, "p1", true, robinAt);
    participants = confirmParticipant(participants, "p2", true, samAt);
    const confirmations = participantsConfirmationForStart({ othersRecorded: true, participants });
    expect(confirmations).toEqual([
      {
        label: "Robin",
        confirmedAt: "2026-10-31T10:00:00.000Z",
        statement: "Robin has agreed to be recorded.",
      },
      {
        label: "Sam",
        confirmedAt: "2026-10-31T10:01:00.000Z",
        statement: "Sam has agreed to be recorded.",
      },
    ]);
    expect(parseOtherParticipants(confirmations)).toEqual(confirmations!);
    expect(sessionParticipants({ recordings: [{}, { otherParticipants: confirmations! }] })).toBe(
      confirmations,
    );
    expect(sessionParticipants({ recordings: [{}] })).toBeNull();
    expect(describeParticipants(confirmations)).toBe(
      "Other people recorded: Robin (agreed 2026-10-31T10:00:00.000Z), Sam (agreed 2026-10-31T10:01:00.000Z)",
    );
    expect(describeParticipants(null)).toBe("No other people declared");
  });

  test("migrates a single pre-#151 confirmation to one legacy entry", () => {
    const legacy = {
      confirmedAt: "2026-10-30T09:00:00.000Z",
      statement: "Everyone else in this recording has agreed to be recorded.",
    };
    const migrated = migrateRecordingParticipants({ runId: "r", otherParticipants: legacy });
    expect(migrated.otherParticipants).toEqual([{ label: LEGACY_PARTICIPANTS_LABEL, ...legacy }]);
    const current = { runId: "r", otherParticipants: migrated.otherParticipants };
    expect(migrateRecordingParticipants(current)).toBe(current);
    const bare: { runId: string; otherParticipants?: unknown } = { runId: "r" };
    expect(migrateRecordingParticipants(bare) as unknown).toBe(bare);
  });

  test("rejects malformed stored confirmations", () => {
    const valid = { label: "Robin", confirmedAt: robinAt.toISOString(), statement: "x" };
    expect(parseOtherParticipants([])).toBeNull();
    expect(parseOtherParticipants([{ ...valid, label: " " }])).toBeNull();
    expect(parseOtherParticipants([{ ...valid, confirmedAt: "never" }])).toBeNull();
    expect(parseOtherParticipants([{ ...valid, statement: "" }])).toBeNull();
    expect(parseOtherParticipants({ confirmedAt: "never", statement: "x" })).toBeNull();
    expect(() =>
      migrateRecordingParticipants({ otherParticipants: { confirmedAt: "never" } }),
    ).toThrow("malformed");
  });
});
