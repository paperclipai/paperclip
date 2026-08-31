import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { NATIVE_SPARK_EXECUTOR_AGENT_ID } from "./issue-assignment-fence.js";
import { issueService } from "./issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const FALLBACK_AGENT_ID = "11111111-1111-4111-8111-111111111111";

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("issue assignment fence service integration", () => {
  it("keeps fenced creation blocked, rejects direct checkout and removal-plus-fallback", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assignment-fence-service-");
    const db = createDb(tempDb.connectionString);
    try {
      await ensureIssueRelationsTable(db);
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Fence Service",
        issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values([
        {
          id: NATIVE_SPARK_EXECUTOR_AGENT_ID,
          companyId,
          name: "Native Spark",
          role: "engineer",
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: FALLBACK_AGENT_ID,
          companyId,
          name: "Fallback",
          role: "engineer",
          status: "active",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);
      const svc = issueService(db);
      const executionPolicy = {
        assignmentFence: {
          kind: "native_spark_only",
          allowedAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
        },
      };
      const created = await svc.create(companyId, { title: "Fenced task", executionPolicy });
      expect(created).toMatchObject({ status: "blocked", assigneeAgentId: null, assigneeUserId: null });

      await expect(svc.checkout(created.id, NATIVE_SPARK_EXECUTOR_AGENT_ID, ["blocked"], randomUUID()))
        .rejects.toMatchObject({ status: 409 });
      await expect(svc.update(created.id, {
        executionPolicy: null,
        assigneeAgentId: FALLBACK_AGENT_ID,
      })).rejects.toMatchObject({ status: 409 });
    } finally {
      await db.delete(nativeRunFinalizations);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(companies);
      await tempDb.cleanup();
    }
  }, 30_000);

  it("accepts only a fresh successful native run and returns a fenced issue to blocked on release", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assignment-fence-receipt-");
    const db = createDb(tempDb.connectionString);
    try {
      await ensureIssueRelationsTable(db);
      const companyId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const cancelledRunId = randomUUID();
      const now = new Date();
      const executionPolicy = {
        assignmentFence: {
          kind: "native_spark_only",
          allowedAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
        },
      };
      await db.insert(companies).values({
        id: companyId,
        name: "Fence Receipt",
        issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: NATIVE_SPARK_EXECUTOR_AGENT_ID,
        companyId,
        name: "Native Spark",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Receipt task",
        status: "blocked",
        priority: "medium",
        executionPolicy,
      });
      await db.insert(heartbeatRuns).values([
        {
          id: runId,
          companyId,
          agentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
          status: "succeeded",
          runtimeMode: "native",
          nativeIssueId: issueId,
          driverKind: "codex",
          nativePhase: "completed",
          nativePhaseUpdatedAt: now,
          startedAt: new Date(now.getTime() - 1000),
          finishedAt: now,
        },
        {
          id: cancelledRunId,
          companyId,
          agentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
          status: "cancelled",
          runtimeMode: "native",
          nativeIssueId: issueId,
          driverKind: "codex",
          nativePhase: "completed",
          nativePhaseUpdatedAt: now,
          startedAt: new Date(now.getTime() - 1000),
          finishedAt: now,
        },
      ]);
      await db.insert(nativeRunFinalizations).values([
        { runId, companyId, issueId, phase: "completed" },
        { runId: cancelledRunId, companyId, issueId, phase: "completed" },
      ]);
      const svc = issueService(db);

      await expect(svc.recordAssignmentFenceReceipt(issueId, cancelledRunId)).rejects.toMatchObject({ status: 409 });
      const receipted = await svc.recordAssignmentFenceReceipt(issueId, runId);
      expect((receipted.executionState as { assignmentFenceReceipt?: { runId?: string } })?.assignmentFenceReceipt?.runId)
        .toBe(runId);
      const assigned = await svc.update(issueId, {
        assigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
        status: "in_progress",
        assignmentFenceIntent: "explicit",
      });
      expect(assigned).toMatchObject({ status: "in_progress", assigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID });
      const released = await svc.release(issueId);
      expect(released).toMatchObject({ status: "blocked", assigneeAgentId: null });
    } finally {
      await db.delete(nativeRunFinalizations);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(companies);
      await tempDb.cleanup();
    }
  }, 30_000);
});
