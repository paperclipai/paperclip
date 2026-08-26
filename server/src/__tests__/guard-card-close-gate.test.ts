import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  evaluateGuardCardClose,
  findGuardCloseWaiver,
  parseGuardCardTitle,
} from "../services/guard-card-close-gate.js";

// TSMC-21870. The behaviour under test is the one the fleet actually exhibited:
// ~40 [GUARD] cards closed `done` in 36h while every guard stayed red, proven by
// streak counters that RISE across successive cards (channel-asset-completeness
// went 1→2→3→4→5→9→10 across seven `done` cards in ten hours). Each of these tests
// FAILS against the pre-fix code, which had no guard-card branch at all.

function writeState(entries: Record<string, unknown>, ageMs = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-state-"));
  const file = path.join(dir, "guard-bus-state.json");
  writeFileSync(file, JSON.stringify(entries));
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(file, when, when);
  }
  return file;
}

const RED_CARD = "[GUARD] channel-asset-completeness red for 10 consecutive run(s)";

describe("parseGuardCardTitle", () => {
  it("extracts the guard name from a real guard card title", () => {
    expect(parseGuardCardTitle(RED_CARD)).toBe("channel-asset-completeness");
    expect(parseGuardCardTitle("[GUARD] stranded-recovery red for 401 consecutive run(s)"))
      .toBe("stranded-recovery");
  });

  it("ignores ordinary cards, including ones that merely mention a guard", () => {
    expect(parseGuardCardTitle("Unblock: the guard-delivery card needs an owner")).toBeNull();
    expect(parseGuardCardTitle("[PLATFORM][P0] guard cards can be closed while red")).toBeNull();
    expect(parseGuardCardTitle(null)).toBeNull();
  });
});

describe("findGuardCloseWaiver", () => {
  it("accepts a waiver with a reason, in either idiom", () => {
    expect(findGuardCloseWaiver(["no-guard-close: superseded by TSMC-21650"]))
      .toBe("superseded by TSMC-21650");
    expect(findGuardCloseWaiver([null, "guard still red: owner is on the fleet-wide fix"]))
      .toBe("owner is on the fleet-wide fix");
  });

  it("refuses a bare marker with no reason — an empty waiver is not a waiver", () => {
    expect(findGuardCloseWaiver(["no-guard-close:"])).toBeNull();
    expect(findGuardCloseWaiver(["no-guard-close:    "])).toBeNull();
  });
});

describe("evaluateGuardCardClose", () => {
  it("REFUSES done while the guard is red — the treadmill's entry point", async () => {
    const statePath = writeState({
      "channel-asset-completeness": { streak: 10, issue: "TSMC-21857" },
    });
    const result = await evaluateGuardCardClose({
      issue: { title: RED_CARD },
      nextStatus: "done",
      statePath,
    });
    expect(result.outcome).toBe("red");
    if (result.outcome === "red") {
      expect(result.guardName).toBe("channel-asset-completeness");
      expect(result.streak).toBe(10);
      expect(result.cardOfRecord).toBe("TSMC-21857");
    }
  });

  it("REFUSES cancelled too — silencing must not just switch verbs", async () => {
    const statePath = writeState({ "channel-asset-completeness": { streak: 10 } });
    const result = await evaluateGuardCardClose({
      issue: { title: RED_CARD },
      nextStatus: "cancelled",
      statePath,
    });
    expect(result.outcome).toBe("red");
  });

  it("ALLOWS the close once the guard is green — guard-bus's own close still works", async () => {
    const statePath = writeState({ "channel-asset-completeness": { streak: 0, issue: null } });
    const result = await evaluateGuardCardClose({
      issue: { title: RED_CARD },
      nextStatus: "done",
      statePath,
    });
    expect(result.outcome).toBe("green");
  });

  it("ALLOWS the close with an explicit waiver, and records the reason", async () => {
    const statePath = writeState({ "channel-asset-completeness": { streak: 10 } });
    const result = await evaluateGuardCardClose({
      issue: { title: RED_CARD },
      nextStatus: "done",
      waiverTexts: ["no-guard-close: rolled into TSMC-21870"],
      statePath,
    });
    expect(result.outcome).toBe("waived");
    if (result.outcome === "waived") expect(result.reason).toBe("rolled into TSMC-21870");
  });

  it("does not gate ordinary cards", async () => {
    const statePath = writeState({ "channel-asset-completeness": { streak: 10 } });
    const result = await evaluateGuardCardClose({
      issue: { title: "Unblock: CTO must restore the dispatcher" },
      nextStatus: "done",
      statePath,
    });
    expect(result.outcome).toBe("not_a_guard_card");
  });

  it("does not gate a transition that is not a close", async () => {
    const statePath = writeState({ "channel-asset-completeness": { streak: 10 } });
    const result = await evaluateGuardCardClose({
      issue: { title: RED_CARD },
      nextStatus: "in_review",
      statePath,
    });
    expect(result.outcome).toBe("not_a_guard_card");
  });

  it("FAILS OPEN when guard-bus state is stale — a dead bus must not wedge the board", async () => {
    const statePath = writeState(
      { "channel-asset-completeness": { streak: 10 } },
      4 * 60 * 60 * 1000,
    );
    const result = await evaluateGuardCardClose({
      issue: { title: RED_CARD },
      nextStatus: "done",
      statePath,
    });
    expect(result.outcome).toBe("stale");
  });

  it("FAILS OPEN when the state file is missing entirely", async () => {
    const result = await evaluateGuardCardClose({
      issue: { title: RED_CARD },
      nextStatus: "done",
      statePath: path.join(tmpdir(), "definitely-not-here", "guard-bus-state.json"),
    });
    expect(result.outcome).toBe("stale");
  });

  it("reports an unknown guard rather than guessing", async () => {
    const statePath = writeState({ "some-other-guard": { streak: 3 } });
    const result = await evaluateGuardCardClose({
      issue: { title: RED_CARD },
      nextStatus: "done",
      statePath,
    });
    expect(result.outcome).toBe("unknown_guard");
  });

  it("reproduces the observed treadmill: every close in the 1→10 sequence is refused", async () => {
    // The seven real cards, at the streak each carried when it was closed `done`.
    for (const streak of [1, 2, 3, 4, 5, 9, 10]) {
      const statePath = writeState({ "channel-asset-completeness": { streak } });
      const result = await evaluateGuardCardClose({
        issue: { title: `[GUARD] channel-asset-completeness red for ${streak} consecutive run(s)` },
        nextStatus: "done",
        statePath,
      });
      expect(result.outcome, `streak ${streak} must be refused`).toBe("red");
    }
  });
});

// --- integration: the gate must live where BOTH close paths converge --------
// assertIssueCloseEvidenceSatisfied is called by routes/issues.ts (PATCH) and by
// heartbeat.ts (PAPERCLIP_DISPOSITION). Gating only the route is the hole
// TSMC-21479/21607 already paid for; these assert the shared function refuses.
import { assertIssueCloseEvidenceSatisfied } from "../services/issue-close-evidence.js";

const noopSvc = {
  listAttachments: async () => [],
  listComments: async () => [],
};
const noopWorkProducts = { listForIssue: async () => [] };
const noopDocuments = { listIssueDocuments: async () => [] };

describe("assertIssueCloseEvidenceSatisfied — guard cards", () => {
  const redState = () => writeState({ "channel-asset-completeness": { streak: 10, issue: "TSMC-21857" } });
  const guardIssue = { id: "issue-1", companyId: "co-1", title: RED_CARD };

  it("refuses done on a red guard card (heartbeat + route share this call)", async () => {
    await expect(assertIssueCloseEvidenceSatisfied({
      issue: guardIssue,
      nextStatus: "done",
      svc: noopSvc,
      workProductsSvc: noopWorkProducts,
      documentsSvc: noopDocuments,
      guardStatePath: redState(),
    })).rejects.toThrow(/still RED/i);
  });

  it("refuses cancelled on a red guard card", async () => {
    await expect(assertIssueCloseEvidenceSatisfied({
      issue: guardIssue,
      nextStatus: "cancelled",
      svc: noopSvc,
      workProductsSvc: noopWorkProducts,
      documentsSvc: noopDocuments,
      guardStatePath: redState(),
    })).rejects.toThrow(/still RED/i);
  });

  it("accepts a waiver written in the SAME request that closes the card", async () => {
    await expect(assertIssueCloseEvidenceSatisfied({
      issue: guardIssue,
      nextStatus: "done",
      svc: noopSvc,
      workProductsSvc: noopWorkProducts,
      documentsSvc: noopDocuments,
      guardStatePath: redState(),
      closingCommentBody: "no-guard-close: superseded by TSMC-21870",
    })).resolves.toBeUndefined();
  });

  it("accepts a waiver already posted as a comment", async () => {
    await expect(assertIssueCloseEvidenceSatisfied({
      issue: guardIssue,
      nextStatus: "done",
      svc: {
        listAttachments: async () => [],
        listComments: async () => [{ body: "guard still red: owner is on the fleet fix", createdAt: new Date(), authorType: "user" }],
      },
      workProductsSvc: noopWorkProducts,
      documentsSvc: noopDocuments,
      guardStatePath: redState(),
    })).resolves.toBeUndefined();
  });

  it("leaves non-guard cards entirely alone", async () => {
    await expect(assertIssueCloseEvidenceSatisfied({
      issue: { id: "issue-2", companyId: "co-1", title: "Unblock: restore the dispatcher" },
      nextStatus: "done",
      svc: noopSvc,
      workProductsSvc: noopWorkProducts,
      documentsSvc: noopDocuments,
      guardStatePath: redState(),
    })).resolves.toBeUndefined();
  });
});
