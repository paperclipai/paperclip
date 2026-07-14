import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  deliveryAttestations,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { deliveryAttestationService } from "../services/delivery-attestations.js";
import { issueService } from "../services/issues.js";
import { computeTargetFingerprint } from "../services/workspace-target-fingerprint.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres delivery attestation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

process.env.PAPERCLIP_AGENT_JWT_SECRET ??= "test-secret-for-delivery-attestations";

describeEmbeddedPostgres("delivery attestations", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-attestations-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(deliveryAttestations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let companyId: string;
  let agentId: string;

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  });

  async function makeRun() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
    });
    return runId;
  }

  async function makeIssue(overrides: Partial<typeof issues.$inferInsert> = {}) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the feature",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      ...overrides,
    });
    return issueId;
  }

  describe("deliveryAttestationService", () => {
    it("is append-only: a repeated call for the same operation key does not create a duplicate row", async () => {
      const svc = deliveryAttestationService(db);
      const runId = await makeRun();
      const issueId = await makeIssue();
      const fingerprint = computeTargetFingerprint(companyId, "git", "https://example.com/acme/repo.git");

      const first = await svc.record({
        companyId,
        issueId,
        runId,
        declarationId: `projectWorkspace:${issueId}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
        operationId: "op-1",
      });
      const second = await svc.record({
        companyId,
        issueId,
        runId,
        declarationId: `projectWorkspace:${issueId}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
        operationId: "op-1",
      });

      expect(second.id).toBe(first.id);
      const rows = await svc.listForRun(runId, companyId);
      expect(rows).toHaveLength(1);
    });

    it("records a new row for a genuinely new operation attempt", async () => {
      const svc = deliveryAttestationService(db);
      const runId = await makeRun();
      const issueId = await makeIssue();
      const fingerprint = computeTargetFingerprint(companyId, "git", "https://example.com/acme/repo.git");

      await svc.record({
        companyId,
        issueId,
        runId,
        declarationId: `projectWorkspace:${issueId}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "failed",
        deliveryMethod: "commit",
        operationId: "attempt-1",
      });
      await svc.record({
        companyId,
        issueId,
        runId,
        declarationId: `projectWorkspace:${issueId}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
        operationId: "attempt-2",
      });

      const rows = await svc.listForRun(runId, companyId);
      expect(rows).toHaveLength(2);
    });

    it("does not let a sibling issue's succeeded attestation satisfy this issue's lookup", async () => {
      const svc = deliveryAttestationService(db);
      const runA = await makeRun();
      const runB = await makeRun();
      const issueA = await makeIssue();
      const issueB = await makeIssue();
      const fingerprint = computeTargetFingerprint(companyId, "git", "https://example.com/acme/repo.git");

      await svc.record({
        companyId,
        issueId: issueB,
        runId: runB,
        declarationId: `projectWorkspace:${issueB}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
      });

      const matches = await svc.findSucceededForIssue({
        companyId,
        issueId: issueA,
        declarationRevision: 0,
      });
      expect(matches).toHaveLength(0);

      // Recording issueA's own attestation makes it (and only it) match.
      const own = await svc.record({
        companyId,
        issueId: issueA,
        runId: runA,
        declarationId: `projectWorkspace:${issueA}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
      });
      const matchesAfter = await svc.findSucceededForIssue({
        companyId,
        issueId: issueA,
        declarationRevision: 0,
      });
      expect(matchesAfter.map((row) => row.id)).toEqual([own.id]);
    });
  });

  describe("terminal transition gate (issueService.update)", () => {
    it("rejects done for a workspace_delivery issue with no attestation", async () => {
      const svc = issueService(db);
      const issueId = await makeIssue({ completionRequirement: "workspace_delivery", completionRequirementRevision: 0 });

      await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "delivery_attestation_required" }),
      });
    });

    it("allows done once exactly one succeeded attestation matches the issue and revision", async () => {
      const attestationSvc = deliveryAttestationService(db);
      const svc = issueService(db);
      const runId = await makeRun();
      const issueId = await makeIssue({ completionRequirement: "workspace_delivery", completionRequirementRevision: 0 });
      const fingerprint = computeTargetFingerprint(companyId, "git", "https://example.com/acme/repo.git");

      await attestationSvc.record({
        companyId,
        issueId,
        runId,
        declarationId: `projectWorkspace:${issueId}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
      });

      const updated = await svc.update(issueId, { status: "done" });
      expect(updated?.status).toBe("done");
      expect(updated?.completedAt).not.toBeNull();
    });

    it("rejects done when only a sibling issue's run produced a succeeded attestation", async () => {
      const attestationSvc = deliveryAttestationService(db);
      const svc = issueService(db);
      const siblingRunId = await makeRun();
      const issueId = await makeIssue({ completionRequirement: "workspace_delivery", completionRequirementRevision: 0 });
      const siblingIssueId = await makeIssue({ completionRequirement: "workspace_delivery", completionRequirementRevision: 0 });
      const fingerprint = computeTargetFingerprint(companyId, "git", "https://example.com/acme/repo.git");

      await attestationSvc.record({
        companyId,
        issueId: siblingIssueId,
        runId: siblingRunId,
        declarationId: `projectWorkspace:${siblingIssueId}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
      });

      await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "delivery_attestation_required" }),
      });
    });

    it("rejects done when the attestation was generated under a stale requirement revision", async () => {
      const attestationSvc = deliveryAttestationService(db);
      const svc = issueService(db);
      const runId = await makeRun();
      const issueId = await makeIssue({ completionRequirement: "workspace_delivery", completionRequirementRevision: 1 });
      const fingerprint = computeTargetFingerprint(companyId, "git", "https://example.com/acme/repo.git");

      await attestationSvc.record({
        companyId,
        issueId,
        runId,
        declarationId: `projectWorkspace:${issueId}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
      });

      await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "delivery_attestation_required" }),
      });
    });

    it("does not gate done for legacy/evidence_only/artifact issues (migration compatibility)", async () => {
      const svc = issueService(db);
      const legacyIssueId = await makeIssue({ completionRequirement: null });
      const evidenceIssueId = await makeIssue({ completionRequirement: "evidence_only" });

      const updatedLegacy = await svc.update(legacyIssueId, { status: "done" });
      expect(updatedLegacy?.status).toBe("done");

      const updatedEvidence = await svc.update(evidenceIssueId, { status: "done" });
      expect(updatedEvidence?.status).toBe("done");
    });

    it("allows done when an explicit deliveryAttestationId is referenced and valid", async () => {
      const attestationSvc = deliveryAttestationService(db);
      const svc = issueService(db);
      const runId = await makeRun();
      const issueId = await makeIssue({ completionRequirement: "workspace_delivery", completionRequirementRevision: 0 });
      const fingerprint = computeTargetFingerprint(companyId, "git", "https://example.com/acme/repo.git");

      const attestation = await attestationSvc.record({
        companyId,
        issueId,
        runId,
        declarationId: `projectWorkspace:${issueId}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
      });

      const updated = await svc.update(issueId, { status: "done", deliveryAttestationId: attestation.id });
      expect(updated?.status).toBe("done");
    });

    it("rejects an explicit deliveryAttestationId that belongs to a different issue", async () => {
      const attestationSvc = deliveryAttestationService(db);
      const svc = issueService(db);
      const runId = await makeRun();
      const issueId = await makeIssue({ completionRequirement: "workspace_delivery", completionRequirementRevision: 0 });
      const siblingIssueId = await makeIssue({ completionRequirement: "workspace_delivery", completionRequirementRevision: 0 });
      const fingerprint = computeTargetFingerprint(companyId, "git", "https://example.com/acme/repo.git");

      const siblingAttestation = await attestationSvc.record({
        companyId,
        issueId: siblingIssueId,
        runId,
        declarationId: `projectWorkspace:${siblingIssueId}`,
        declarationRevision: 0,
        targetKind: "repository_checkout",
        targetFingerprint: fingerprint,
        providerKey: "git",
        outcome: "succeeded",
        deliveryMethod: "commit",
      });

      await expect(
        svc.update(issueId, { status: "done", deliveryAttestationId: siblingAttestation.id }),
      ).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "delivery_attestation_required" }),
      });
    });
  });
});
