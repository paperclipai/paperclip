import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertIssueCloseEvidenceSatisfied } from "../services/issue-close-evidence.js";

// TSMC-21479. The close-evidence gate lived ONLY on the HTTP route, so
// `PATCH /issues/:id {status:"done"}` was checked while the heartbeat
// disposition path — an agent stating `PAPERCLIP_DISPOSITION: done` — was not.
// Every hollow close took the ungated door. Five fabricated or hollow closes
// were recorded in the 24h to 2026-08-25 (TSMC-21479, TSMC-21480, TSMC-21391,
// TSMC-21280, DP-4759); voiding them by hand did not hold, because a rule
// written on a card is a request and this is the enforcement.

const emptySvcs = {
  svc: {
    listAttachments: async () => [],
    listComments: async () => [],
  },
  workProductsSvc: { listForIssue: async () => [] },
  documentsSvc: { listIssueDocuments: async () => [] },
};

const exemptIssue = {
  id: "issue-1",
  companyId: "company-1",
  title: "Some work",
  labels: [],
  // No close contract: isolates the active-run rule from contract-evidence rules.
  closeContract: null,
  executionRunId: null,
};

describe("close-evidence gate is importable from the service layer (TSMC-21479)", () => {
  // Before the extraction this symbol was module-private to routes/issues.ts,
  // so the heartbeat could not call it and this import did not resolve.
  it("is exported so both the route and the heartbeat can call ONE implementation", () => {
    expect(typeof assertIssueCloseEvidenceSatisfied).toBe("function");
  });

  it("refuses done while ANOTHER execution run on the issue is still active", async () => {
    await expect(assertIssueCloseEvidenceSatisfied({
      issue: exemptIssue as never,
      nextStatus: "done",
      ...emptySvcs,
      issueRun: { id: "other-run", status: "running", startedAt: new Date(), createdAt: new Date() },
      actorRunId: "actor-run",
    } as never)).rejects.toThrow();
  });

  it("does NOT self-block: the stating run may close its own issue", async () => {
    await expect(assertIssueCloseEvidenceSatisfied({
      issue: exemptIssue as never,
      nextStatus: "done",
      ...emptySvcs,
      issueRun: { id: "actor-run", status: "running", startedAt: new Date(), createdAt: new Date() },
      actorRunId: "actor-run",
    } as never)).resolves.toBeUndefined();
  });

  it("no-ops for cancelled, so cancellation behaviour is unchanged", async () => {
    await expect(assertIssueCloseEvidenceSatisfied({
      issue: exemptIssue as never,
      nextStatus: "cancelled",
      ...emptySvcs,
      issueRun: { id: "other-run", status: "running", startedAt: new Date(), createdAt: new Date() },
      actorRunId: "actor-run",
    } as never)).resolves.toBeUndefined();
  });
});

describe("the heartbeat disposition path is wired to the gate (TSMC-21479)", () => {
  // A wiring assertion, deliberately labelled as such: the behavioural tests
  // above prove the gate refuses, but they cannot prove the heartbeat CALLS it.
  // Reading the served source is the available binding check. TSKB0055 K45 is
  // the reason this is stated plainly rather than dressed up as behaviour.
  const heartbeatSrc = readFileSync(
    fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
    "utf8",
  );

  it("calls assertIssueCloseEvidenceSatisfied before applying a stated done/cancelled", () => {
    const dispositionBlock = heartbeatSrc.slice(
      heartbeatSrc.indexOf('if (statedStatus === "done" || statedStatus === "cancelled") {'),
    ).slice(0, 4000);
    expect(dispositionBlock).toContain("assertIssueCloseEvidenceSatisfied(");
    // the apply must be on the else branch of the refusal, not unconditional
    expect(dispositionBlock).toContain("if (closeGateRefusal) {");
    expect(dispositionBlock).toContain("issue.disposition_refused_close_evidence");
  });

  it("no longer carries the TODO that stood in for the gate", () => {
    expect(heartbeatSrc).not.toContain("TODO(TSMC-21479)");
  });
});
