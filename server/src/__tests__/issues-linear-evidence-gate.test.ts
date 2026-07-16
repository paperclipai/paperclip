import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import {
  linearEvidenceCommentSha256,
  linearEvidenceIdempotencyKey,
  linearEvidenceMappingKey,
  linearEvidencePayloadSha256,
  type LinearEvidenceBridgeReader,
  type LinearEvidenceCompletionSnapshot,
  type LinearEvidencePayload,
} from "../services/linear-evidence-bridge.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService Linear completion evidence gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-linear-evidence-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "LIN",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "LIN-1",
      issueNumber: 1,
      title: "Require canonical Linear evidence",
      status: "todo",
      priority: "high",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        linearEvidence: { required: true, independentQaRequired: true },
      },
    });
    return { companyId, issueId };
  }

  function publishedSnapshot(
    companyId: string,
    issueId: string,
    paperclipIssueUpdatedAt: string,
  ): LinearEvidenceCompletionSnapshot {
    const mappingKey = linearEvidenceMappingKey(companyId, issueId);
    const evidence: LinearEvidencePayload = {
      contractVersion: 1,
      mappingKey,
      paperclipIssueId: issueId,
      paperclipIssueUpdatedAt,
      linearIssueId: "linear-381",
      implementerId: "codex-implementer-1",
      whatChanged: "Implemented the Linear evidence completion gate.",
      artifact: { sha256: "b".repeat(64) },
      verification: {
        verifierId: "lana-qa",
        independent: true,
        result: "passed",
        summary: "Focused tests passed.",
        testedAt: "2026-07-15T12:30:00.000Z",
      },
      recordedAt: "2026-07-15T12:31:00.000Z",
    };
    const idempotencyKey = linearEvidenceIdempotencyKey(evidence);
    return {
      mappingKey,
      linearIssueId: evidence.linearIssueId,
      evidence,
      evidenceSha256: linearEvidencePayloadSha256(evidence),
      idempotencyKey,
      delivery: {
        state: "published",
        idempotencyKey,
        commentBodySha256: linearEvidenceCommentSha256(evidence),
        remoteCommentId: "comment-381",
        publishedAt: "2026-07-15T12:32:00.000Z",
      },
      conflicts: [],
    };
  }

  it("keeps the issue non-terminal when the required bridge is absent", async () => {
    const { issueId } = await seedIssue();

    await expect(issueService(db).update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "linear_evidence_gate_failed",
        reason: "bridge_unavailable",
      },
    });

    const persisted = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(persisted[0]?.status).toBe("todo");
  });

  it("does not allow removing the gate and completing in one mutation", async () => {
    const { issueId } = await seedIssue();

    await expect(issueService(db).update(issueId, {
      status: "done",
      executionPolicy: null,
      actorUserId: "board-user",
    })).rejects.toMatchObject({
      status: 422,
      details: { reason: "bridge_unavailable" },
    });
  });

  it("allows only a board user to weaken or remove the gate", async () => {
    const { issueId } = await seedIssue();

    await expect(issueService(db).update(issueId, {
      executionPolicy: null,
      actorAgentId: randomUUID(),
    })).rejects.toMatchObject({ status: 403 });
  });

  it("allows Done only after a matching publication receipt and independent QA", async () => {
    const { companyId, issueId } = await seedIssue();
    const current = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, issueId));
    const issueUpdatedAt = current[0]!.updatedAt.toISOString();
    const getCompletionSnapshot = vi.fn(async () => publishedSnapshot(companyId, issueId, issueUpdatedAt));
    const bridge: LinearEvidenceBridgeReader = { getCompletionSnapshot };

    const updated = await issueService(db, { linearEvidenceBridge: bridge }).update(issueId, { status: "done" });

    expect(updated?.status).toBe("done");
    expect(getCompletionSnapshot).toHaveBeenCalledWith({
      companyId,
      paperclipIssueId: issueId,
      paperclipIssueUpdatedAt: issueUpdatedAt,
      mappingKey: linearEvidenceMappingKey(companyId, issueId),
    });
  });

  it("does not authorize a newer issue version with evidence validated for the prior version", async () => {
    const { companyId, issueId } = await seedIssue();
    const current = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, issueId));
    const versionOne = current[0]!.updatedAt;
    const versionTwo = new Date(versionOne.getTime() + 1_000);
    const bridge: LinearEvidenceBridgeReader = {
      getCompletionSnapshot: vi.fn(async () => {
        const snapshot = publishedSnapshot(companyId, issueId, versionOne.toISOString());
        await db
          .update(issues)
          .set({ title: "Concurrent V2 mutation", updatedAt: versionTwo })
          .where(eq(issues.id, issueId));
        return snapshot;
      }),
    };

    await expect(
      issueService(db, { linearEvidenceBridge: bridge }).update(issueId, { status: "done" }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "linear_evidence_issue_version_changed",
        expectedUpdatedAt: versionOne.toISOString(),
        actualUpdatedAt: versionTwo.toISOString(),
      },
    });

    const persisted = await db
      .select({ status: issues.status, title: issues.title, updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(persisted).toEqual({
      status: "todo",
      title: "Concurrent V2 mutation",
      updatedAt: versionTwo,
    });
  });
});
