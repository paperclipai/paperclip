import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { createDeliveryDoneGate, type DeliveryGateIssue } from "./done-gate.js";
import {
  deliveryReconciliationWriteSchema,
  deliverySubmitActionSchema,
} from "@paperclipai/shared/validators/delivery";
import {
  evaluateDeliveryRequirements,
  isCheckSuccessful,
  isMaterialPolicyScopeChange,
  parseGitHubRepositoryUrl,
  type DeliveryEvidence,
} from "./policy.js";
import { isMergeIncluded, summarizeReviews } from "./github-client.js";
import { nextAcceptanceState } from "./reconciler.js";
import { assertPublicationCapabilityBinding } from "./publication-capability.js";
import { deriveDeliveryPhase, readUnitMetadata, type DeliveryUnitRow } from "./units.js";
import { parseMcpToolPayload } from "./greptile.js";

const noDatabase = {} as unknown as Db;

function issue(overrides: Partial<DeliveryGateIssue>): DeliveryGateIssue {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    parentId: null,
    status: "in_review",
    deliveryKind: null,
    deliveryDisposition: null,
    ...overrides,
  } as DeliveryGateIssue;
}

function unit(overrides: Partial<DeliveryUnitRow>): DeliveryUnitRow {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    companyId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    repositoryId: "55555555-5555-4555-8555-555555555555",
    primaryIssueId: "11111111-1111-4111-8111-111111111111",
    targetBranch: "main",
    sourceBranch: "delivery/x",
    baseSha: null,
    headSha: "a".repeat(40),
    acceptedHeadSha: "a".repeat(40),
    mergedSha: null,
    mergeCommitSha: null,
    status: "in_review",
    candidateGeneration: 1,
    artifactReady: true,
    prNumber: 7,
    prUrl: "https://github.com/acme/widget/pull/7",
    mergeMethod: "squash",
    ownerAgentId: null,
    priority: "medium",
    blocker: null,
    nextAction: null,
    nextActionAt: null,
    readyAt: null,
    queueEnteredAt: null,
    mergeRequestedAt: null,
    mergeAttemptCount: 0,
    repairAttemptCount: 0,
    lastReconciledAt: null,
    lastEventAt: null,
    pausedAt: null,
    cancelledAt: null,
    mergedAt: null,
    metadata: {},
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  } as DeliveryUnitRow;
}

const HEAD = "b".repeat(40);
const OLD_HEAD = "c".repeat(40);

function evidence(overrides: Partial<DeliveryEvidence> = {}): DeliveryEvidence {
  return {
    headSha: HEAD,
    checks: [],
    reviewStatus: "approved",
    reviewHeadSha: HEAD,
    approvals: [{ login: "reviewer", commitSha: HEAD }],
    prAuthorLogin: "author",
    blockingFindings: 0,
    ...overrides,
  };
}

function requirements(overrides: Partial<Parameters<typeof evaluateDeliveryRequirements>[0]> = {}) {
  return evaluateDeliveryRequirements({
    requireIndependentApproval: true,
    requireGreptile: false,
    requiredChecks: [],
    evidence: evidence(),
    ...overrides,
  });
}

describe("delivery Done gate", () => {
  const gate = createDeliveryDoneGate(noDatabase);

  it("refuses ready_to_merge and merging from any caller without controller context", async () => {
    for (const nextStatus of ["ready_to_merge", "merging"]) {
      await expect(gate.assertStatusWriteAllowed({
        companyId: issue({}).companyId,
        issue: issue({ status: "in_review" }),
        nextStatus,
      })).rejects.toMatchObject({ status: 409 });
    }
  });

  it("does not gate ordinary status transitions", async () => {
    await expect(gate.assertStatusWriteAllowed({
      companyId: issue({}).companyId,
      issue: issue({ status: "todo" }),
      nextStatus: "in_progress",
    })).resolves.toBeUndefined();
  });

  it("requires an explicit disposition before a non-code issue can complete", async () => {
    const decision = await gate.evaluateDone({
      companyId: issue({}).companyId,
      issue: issue({ deliveryKind: "non_code", deliveryDisposition: null }),
    });
    expect(decision).toMatchObject({ allowed: false, reasonCode: "delivery_disposition_required" });
  });

});

describe("review summarization", () => {
  it("lets a later dismissal or change request supersede an approval", () => {
    const dismissed = summarizeReviews([
      { state: "APPROVED", login: "reviewer", submittedAt: "2026-09-01T00:00:00Z", commitSha: HEAD },
      { state: "DISMISSED", login: "reviewer", submittedAt: "2026-09-02T00:00:00Z", commitSha: HEAD },
    ]);
    expect(dismissed.approvals).toEqual([]);
    expect(dismissed.approvedHeadSha).toBeNull();

    const changed = summarizeReviews([
      { state: "APPROVED", login: "reviewer", submittedAt: "2026-09-01T00:00:00Z", commitSha: HEAD },
      { state: "CHANGES_REQUESTED", login: "reviewer", submittedAt: "2026-09-02T00:00:00Z", commitSha: HEAD },
    ]);
    expect(changed.status).toBe("changes_requested");
    expect(changed.blockingFindings).toBe(1);
    expect(changed.approvals).toEqual([]);
  });

  it("links each approval to the commit that reviewer approved", () => {
    const summary = summarizeReviews([
      { state: "APPROVED", login: "old-reviewer", submittedAt: "2026-09-01T00:00:00Z", commitSha: OLD_HEAD },
      { state: "APPROVED", login: "new-reviewer", submittedAt: "2026-09-02T00:00:00Z", commitSha: HEAD },
      { state: "COMMENTED", login: "new-reviewer", submittedAt: "2026-09-03T00:00:00Z", commitSha: HEAD },
    ]);
    expect(summary.approvals).toEqual([
      { login: "old-reviewer", commitSha: OLD_HEAD },
      { login: "new-reviewer", commitSha: HEAD },
    ]);
    expect(summary.approvedHeadSha).toBe(HEAD);
    expect(summary.status).toBe("approved");
  });
});

describe("delivery requirements", () => {
  it("blocks when authoritative checks or reviews could not be read", () => {
    expect(requirements({ evidence: evidence({ checks: null }) }))
      .toMatchObject({ reasonCode: "provider_unknown" });
    expect(requirements({ evidence: evidence({ reviewStatus: null }) }))
      .toMatchObject({ reasonCode: "provider_unknown" });
    expect(requirements({ evidence: evidence({ approvals: null }) }))
      .toMatchObject({ reasonCode: "provider_unknown" });
  });

  it("fails closed when the pull request author identity is unknown", () => {
    expect(requirements({ evidence: evidence({ prAuthorLogin: null }) }))
      .toMatchObject({ reasonCode: "provider_unknown" });
  });

  it("accepts an independent approval of the exact head", () => {
    expect(requirements()).toBeNull();
  });

  it("rejects self-approval of the exact head as a missing approval, not a blocking finding", () => {
    expect(requirements({ evidence: evidence({ approvals: [{ login: "author", commitSha: HEAD }] }) }))
      .toMatchObject({ reasonCode: "review_approval_required" });
  });

  it("rejects an independent approval recorded for a different head", () => {
    expect(requirements({ evidence: evidence({ approvals: [{ login: "reviewer", commitSha: OLD_HEAD }] }) }))
      .toMatchObject({ reasonCode: "review_approval_required" });
  });

  it("still requires an exact-head approval when independent approval is not required", () => {
    expect(requirements({
      requireIndependentApproval: false,
      evidence: evidence({ reviewStatus: "approved", reviewHeadSha: OLD_HEAD }),
    })).toMatchObject({ reasonCode: "review_head_stale" });
    expect(requirements({
      requireIndependentApproval: false,
      evidence: evidence({ approvals: [] }),
    })).toBeNull();
  });

  it("blocks failing and missing required checks", () => {
    expect(requirements({
      requiredChecks: ["gate"],
      evidence: evidence({ checks: [{ name: "gate", status: "failure", url: null }] }),
    })).toMatchObject({ reasonCode: "checks_failing" });
    expect(requirements({
      requiredChecks: ["gate"],
      evidence: evidence({ checks: [] }),
    })).toMatchObject({ reasonCode: "checks_pending" });
  });
});

describe("acceptance transition", () => {
  it("grants acceptance only when requirements pass for the current head", () => {
    expect(nextAcceptanceState({ acceptedHeadSha: null, remoteHeadSha: HEAD, requirementsMet: true }))
      .toEqual({ acceptedHeadSha: HEAD, action: "accept" });
    expect(nextAcceptanceState({ acceptedHeadSha: null, remoteHeadSha: HEAD, requirementsMet: false }))
      .toEqual({ acceptedHeadSha: null, action: "none" });
  });

  it("withdraws acceptance when requirements regress on the accepted head", () => {
    expect(nextAcceptanceState({ acceptedHeadSha: HEAD, remoteHeadSha: HEAD, requirementsMet: false }))
      .toEqual({ acceptedHeadSha: null, action: "revoke" });
  });

  it("re-accepts the same head automatically after a repair", () => {
    const revoked = nextAcceptanceState({ acceptedHeadSha: HEAD, remoteHeadSha: HEAD, requirementsMet: false });
    const recovered = nextAcceptanceState({
      acceptedHeadSha: revoked.acceptedHeadSha,
      remoteHeadSha: HEAD,
      requirementsMet: true,
    });
    expect(recovered).toEqual({ acceptedHeadSha: HEAD, action: "accept" });
  });

  it("requires re-acceptance when the remote head changes", () => {
    expect(nextAcceptanceState({ acceptedHeadSha: OLD_HEAD, remoteHeadSha: HEAD, requirementsMet: true }))
      .toEqual({ acceptedHeadSha: HEAD, action: "accept" });
  });

  it("withdraws acceptance when the remote head is unknown", () => {
    expect(nextAcceptanceState({ acceptedHeadSha: HEAD, remoteHeadSha: null, requirementsMet: true }))
      .toEqual({ acceptedHeadSha: null, action: "revoke" });
  });
});

describe("publication capability binding", () => {
  const claims = { company_id: "company-1", sub: "agent-1", run_id: "run-1" };

  it("accepts a capability bound to the authenticated agent and run", () => {
    expect(() => assertPublicationCapabilityBinding({
      claims,
      companyId: "company-1",
      actor: { type: "agent", agentId: "agent-1", runId: "run-1" },
    })).not.toThrow();
  });

  it("rejects a capability replayed by another run or agent", () => {
    expect(() => assertPublicationCapabilityBinding({
      claims,
      companyId: "company-1",
      actor: { type: "agent", agentId: "agent-1", runId: "run-2" },
    })).toThrow(/another run/);
    expect(() => assertPublicationCapabilityBinding({
      claims,
      companyId: "company-1",
      actor: { type: "agent", agentId: "agent-2", runId: "run-1" },
    })).toThrow(/another agent/);
    expect(() => assertPublicationCapabilityBinding({
      claims,
      companyId: "company-1",
      actor: { type: "agent", agentId: "agent-1" },
    })).toThrow(/another run/);
  });

  it("rejects a board session and a capability from another company", () => {
    expect(() => assertPublicationCapabilityBinding({
      claims,
      companyId: "company-1",
      actor: { type: "board" },
    })).toThrow(/agent runtime authentication/);
    expect(() => assertPublicationCapabilityBinding({
      claims,
      companyId: "company-2",
      actor: { type: "agent", agentId: "agent-1", runId: "run-1" },
    })).toThrow(/another company/);
  });
});

describe("delivery repository identity", () => {
  it("parses the owner and repo from the supported GitHub URL forms", () => {
    expect(parseGitHubRepositoryUrl("https://github.com/acme/widget")).toEqual({ host: "github.com", owner: "acme", name: "widget" });
    expect(parseGitHubRepositoryUrl("git@github.com:acme/widget.git")).toBeNull();
    expect(parseGitHubRepositoryUrl("https://github.com/acme/widget.git")).toEqual({ host: "github.com", owner: "acme", name: "widget" });
    expect(parseGitHubRepositoryUrl("https://gitlab.com/acme/widget")).toBeNull();
    expect(parseGitHubRepositoryUrl("https://github.com/acme")).toBeNull();
  });


  it("treats only successful check conclusions as passing", () => {
    expect(isCheckSuccessful("success")).toBe(true);
    expect(isCheckSuccessful("SUCCESS")).toBe(true);
    expect(isCheckSuccessful("failure")).toBe(false);
    expect(isCheckSuccessful("timed_out")).toBe(false);
    expect(isCheckSuccessful("in_progress")).toBe(false);
  });
});

describe("delivery phase", () => {
  it("retains the pre-block phase while a unit is blocked", () => {
    const blocked = unit({ status: "blocked", metadata: { blockedPhase: "ready_to_merge" } });
    expect(deriveDeliveryPhase(blocked)).toBe("ready_to_merge");
    expect(readUnitMetadata(blocked.metadata).blockedPhase).toBe("ready_to_merge");
  });

  it("reports not_started for an issue without a unit and done for a merged unit", () => {
    expect(deriveDeliveryPhase(null)).toBe("not_started");
    expect(deriveDeliveryPhase(unit({ status: "merged" }))).toBe("done");
    expect(deriveDeliveryPhase(unit({ status: "merging" }))).toBe("merging");
  });
});

describe("scoped MCP review payload", () => {
  it("unwraps structured content and JSON text blocks", () => {
    expect(parseMcpToolPayload({ structuredContent: { findings: [] } })).toEqual({ findings: [] });
    expect(parseMcpToolPayload({ content: [{ type: "text", text: '{"status":"approved"}' }] }))
      .toEqual({ status: "approved" });
    expect(parseMcpToolPayload({ content: [{ type: "text", text: "not json" }] })).toBe("not json");
  });
});

describe("delivery regression corrections", () => {
  it("refuses a non-code closure on a worker-recorded disposition", async () => {
    const gate = createDeliveryDoneGate(noDatabase);
    const decision = await gate.evaluateDone({
      companyId: issue({}).companyId,
      issue: issue({
        deliveryKind: "non_code",
        deliveryDisposition: {
          reasonCode: "no_code_change",
          message: "Worker claims no code changed",
          owner: null,
          nextAction: null,
          actorType: "agent",
          actorId: "agent_1",
          at: "2026-09-01T00:00:00.000Z",
        },
      }),
    });
    expect(decision).toMatchObject({ allowed: false, reasonCode: "delivery_disposition_required" });
  });

  it("proves merge inclusion only when the target is ahead of or identical to the candidate", () => {
    expect(isMergeIncluded("ahead")).toBe(true);
    expect(isMergeIncluded("identical")).toBe(true);
    expect(isMergeIncluded("behind")).toBe(false);
    expect(isMergeIncluded("diverged")).toBe(false);
    expect(isMergeIncluded("unknown")).toBe(false);
  });

  it("accepts only exact 40-hex revisions at the delivery boundary", () => {
    const submit = {
      action: "submit",
      headSha: "a".repeat(40),
      sourceBranch: "delivery/x",
      artifactReady: false,
    };
    expect(deliverySubmitActionSchema.safeParse(submit).success).toBe(true);
    expect(deliverySubmitActionSchema.safeParse({ ...submit, headSha: "abc1234" }).success).toBe(false);
    expect(deliverySubmitActionSchema.safeParse({ ...submit, headSha: ` ${"a".repeat(40)} ` }).success).toBe(true);
    expect(deliverySubmitActionSchema.safeParse({ ...submit, headSha: "g".repeat(40) }).success).toBe(false);
    // Coverage is an explicit handoff: a repeated task id is ambiguous and
    // rejected at the boundary instead of being silently collapsed.
    const covered = "22222222-2222-4222-8222-222222222222";
    expect(deliverySubmitActionSchema.safeParse({ ...submit, coveredIssueIds: [covered] }).success).toBe(true);
    expect(deliverySubmitActionSchema.safeParse({ ...submit, coveredIssueIds: [covered, covered] }).success).toBe(false);
    expect(deliveryReconciliationWriteSchema.safeParse({
      idempotencyKey: "k",
      issueId: "11111111-1111-4111-8111-111111111111",
      classification: "code_verified",
      provenance: {
        repository: "acme/widget",
        targetBranch: "main",
        mergedSha: "short",
      },
    }).success).toBe(false);
  });

  it("voids standing authorization on material scope changes only", () => {
    const existing: Parameters<typeof isMaterialPolicyScopeChange>[0]["existing"] = {
      repositoryId: "repo-1",
      targetBranch: "main",
      mergeMethod: "squash",
      mergeQueueMode: "serialized",
      requiredChecks: ["gate"],
      requireGreptile: false,
      requireIndependentApproval: true,
      githubConnectionId: "conn-1",
      greptileConnectionId: null,
      autoDeployDisposition: "none",
    };
    expect(isMaterialPolicyScopeChange({ existing, patch: { paused: true }, nextRepositoryId: "repo-1" })).toBe(false);
    expect(isMaterialPolicyScopeChange({ existing, patch: { targetBranch: "release" }, nextRepositoryId: "repo-1" })).toBe(true);
    expect(isMaterialPolicyScopeChange({ existing, patch: { repositoryUrl: "https://github.com/acme/other" }, nextRepositoryId: "repo-2" })).toBe(true);
    expect(isMaterialPolicyScopeChange({ existing, patch: { requiredChecks: [] }, nextRepositoryId: "repo-1" })).toBe(true);
    expect(isMaterialPolicyScopeChange({ existing, patch: { requireGreptile: true }, nextRepositoryId: "repo-1" })).toBe(true);
    expect(isMaterialPolicyScopeChange({ existing, patch: { autoDeployDisposition: "authorized" }, nextRepositoryId: "repo-1" })).toBe(true);
  });
});
