import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, applyPendingMigrations, ensurePostgresDatabase } from "./client.js";
import {
  activityLog,
  agentConfigRevisions,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvalComments,
  approvals,
  artifacts,
  assets,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  documentRevisions,
  documents,
  executionWorkspaces,
  financeEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueLabels,
  issueReadStates,
  issueWorkProducts,
  issues,
  labels,
  projectGoals,
  projectWorkspaces,
  projects,
  workspaceOperations,
  workspaceRuntimeServices,
  goals,
} from "./schema/index.js";
import { runHoldingMigrationRecovery, selectSubsidiariesForScope } from "./recover-holding-migration.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

const tempPaths: string[] = [];
const runningInstances: EmbeddedPostgresInstance[] = [];

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function createTempDatabase(): Promise<string> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-recovery-"));
  tempPaths.push(dataDir);
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C.UTF-8", "--username=paperclip"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  runningInstances.push(instance);
  const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    // Test migrations lag the current schema for this column; patch the temp fixture DB forward.
    await sql.unsafe(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS circuit_breaker_config jsonb`);
    await sql.unsafe(`
      ALTER TABLE heartbeat_runs
      ADD COLUMN IF NOT EXISTS external_run_id text,
      ADD COLUMN IF NOT EXISTS context_snapshot jsonb,
      ADD COLUMN IF NOT EXISTS session_reused boolean DEFAULT false NOT NULL,
      ADD COLUMN IF NOT EXISTS task_session_reused boolean DEFAULT false NOT NULL,
      ADD COLUMN IF NOT EXISTS prompt_chars integer DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS skill_set_hash text,
      ADD COLUMN IF NOT EXISTS context_fetch_mode text,
      ADD COLUMN IF NOT EXISTS normalized_input_tokens integer
    `);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id uuid PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES companies(id),
        agent_id uuid REFERENCES agents(id),
        issue_id uuid REFERENCES issues(id),
        heartbeat_run_id uuid REFERENCES heartbeat_runs(id),
        type text NOT NULL,
        name text NOT NULL,
        description text,
        content_type text,
        content_text text,
        content_ref text,
        size_bytes integer,
        metadata jsonb,
        status text NOT NULL DEFAULT 'active',
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
  } finally {
    await sql.end();
  }
  return connectionString;
}

afterEach(async () => {
  while (runningInstances.length > 0) {
    const instance = runningInstances.pop();
    if (!instance) continue;
    await instance.stop();
  }
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (!tempPath) continue;
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("runHoldingMigrationRecovery", () => {
  it("maps scope values onto known subsidiaries", async () => {
    const definitions = selectSubsidiariesForScope(["VTL", "navico"]);
    expect(definitions.map((definition) => definition.issuePrefix)).toEqual(["NAV", "VTL"]);
  });

  it(
    "repairs dependent company ids for a partially migrated subsidiary without rewriting issue identifiers",
    async () => {
      const connectionString = await createTempDatabase();
      const db = createDb(connectionString);
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

      const holdingCompanyId = "e4f86ad5-bcdd-4ac9-9972-11ed5f6c7820";
      const subsidiaryCompanyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const leadAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const workspaceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const executionWorkspaceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const issueId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const wakeupRequestId = "11111111-1111-4111-8111-111111111111";
      const heartbeatRunId = "22222222-2222-4222-8222-222222222222";
      const documentId = "33333333-3333-4333-8333-333333333333";
      const documentRevisionId = "44444444-4444-4444-8444-444444444444";
      const assetId = "55555555-5555-4555-8555-555555555555";
      const approvalId = "66666666-6666-4666-8666-666666666666";
      const goalId = "77777777-7777-4777-8777-777777777777";
      const labelId = "88888888-8888-4888-8888-888888888888";
      const runtimeServiceId = "99999999-9999-4999-8999-999999999999";
      const budgetPolicyId = "abababab-abab-4bab-8bab-abababababab";
      const budgetIncidentId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
      const costEventId = "efefefef-efef-4fef-8fef-efefefefefef";
      const financeEventId = "12121212-1212-4212-8212-121212121212";
      const artifactId = "13131313-1313-4313-8313-131313131313";

      await db.insert(companies).values([
        {
          id: holdingCompanyId,
          name: "EvoHaus",
          issuePrefix: "EVO",
        },
        {
          id: subsidiaryCompanyId,
          name: "Vitalix",
          issuePrefix: "VTL",
          parentCompanyId: holdingCompanyId,
        },
      ]);

      await db.insert(agents).values({
        id: leadAgentId,
        companyId: subsidiaryCompanyId,
        name: "Vitalix Lead",
        role: "project_lead",
        adapterType: "openclaw_gateway",
        metadata: { project: "vitalix" },
      });

      await db.insert(projects).values({
        id: projectId,
        companyId: subsidiaryCompanyId,
        name: "Vitalix",
        leadAgentId,
      });

      await db.insert(projectWorkspaces).values({
        id: workspaceId,
        companyId: subsidiaryCompanyId,
        projectId,
        name: "ios",
      });

      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId: subsidiaryCompanyId,
        projectId,
        projectWorkspaceId: workspaceId,
        mode: "task",
        strategyType: "branch",
        name: "Vitalix task workspace",
      });

      await db.insert(issues).values({
        id: issueId,
        companyId: subsidiaryCompanyId,
        projectId,
        projectWorkspaceId: workspaceId,
        executionWorkspaceId,
        title: "Recover inbox visibility",
        identifier: "EVOA-12",
        assigneeAgentId: leadAgentId,
        createdByAgentId: leadAgentId,
      });

      await db.insert(goals).values({
        id: goalId,
        companyId: holdingCompanyId,
        title: "Vitalix goal",
      });

      await db.insert(projectGoals).values({
        projectId,
        goalId,
        companyId: holdingCompanyId,
      });

      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId: holdingCompanyId,
        agentId: leadAgentId,
        source: "manual",
      });

      await db.insert(heartbeatRuns).values({
        id: heartbeatRunId,
        companyId: holdingCompanyId,
        agentId: leadAgentId,
        status: "succeeded",
        wakeupRequestId,
      });

      await db.insert(heartbeatRunEvents).values({
        companyId: holdingCompanyId,
        runId: heartbeatRunId,
        agentId: leadAgentId,
        seq: 1,
        eventType: "stdout",
      });

      await db.insert(agentRuntimeState).values({
        agentId: leadAgentId,
        companyId: holdingCompanyId,
        adapterType: "openclaw_gateway",
      });

      await db.insert(agentTaskSessions).values({
        companyId: holdingCompanyId,
        agentId: leadAgentId,
        adapterType: "openclaw_gateway",
        taskKey: "heartbeat",
      });

      await db.insert(agentConfigRevisions).values({
        companyId: holdingCompanyId,
        agentId: leadAgentId,
        changedKeys: ["model"],
        beforeConfig: { model: "old" },
        afterConfig: { model: "new" },
      });

      await db.insert(issueComments).values({
        companyId: holdingCompanyId,
        issueId,
        body: "Need to recover this thread",
      });

      await db.insert(issueReadStates).values({
        companyId: holdingCompanyId,
        issueId,
        userId: "user-1",
      });

      await db.insert(documents).values({
        id: documentId,
        companyId: holdingCompanyId,
        latestBody: "plan body",
      });

      await db.insert(documentRevisions).values({
        id: documentRevisionId,
        companyId: holdingCompanyId,
        documentId,
        revisionNumber: 1,
        body: "plan body",
      });

      await db.insert(issueDocuments).values({
        companyId: holdingCompanyId,
        issueId,
        documentId,
        key: "plan",
      });

      await db.insert(assets).values({
        id: assetId,
        companyId: holdingCompanyId,
        provider: "s3",
        objectKey: "vitalix/plan.png",
        contentType: "image/png",
        byteSize: 10,
        sha256: "abc",
      });

      await db.insert(issueAttachments).values({
        companyId: holdingCompanyId,
        issueId,
        assetId,
      });

      await db.insert(labels).values({
        id: labelId,
        companyId: holdingCompanyId,
        name: "recovery",
        color: "#22c55e",
      });

      await db.insert(issueLabels).values({
        issueId,
        labelId,
        companyId: holdingCompanyId,
      });

      await db.insert(approvals).values({
        id: approvalId,
        companyId: holdingCompanyId,
        type: "budget_override",
        payload: { issueId },
      });

      await db.insert(issueApprovals).values({
        companyId: holdingCompanyId,
        issueId,
        approvalId,
      });

      await db.insert(approvalComments).values({
        companyId: holdingCompanyId,
        approvalId,
        body: "approved",
      });

      await db.insert(workspaceRuntimeServices).values({
        id: runtimeServiceId,
        companyId: holdingCompanyId,
        projectId,
        projectWorkspaceId: workspaceId,
        executionWorkspaceId,
        issueId,
        scopeType: "issue",
        serviceName: "vite",
        status: "running",
        lifecycle: "ephemeral",
        provider: "local",
      });

      await db.insert(issueWorkProducts).values({
        companyId: holdingCompanyId,
        projectId,
        issueId,
        executionWorkspaceId,
        runtimeServiceId,
        type: "preview",
        provider: "paperclip",
        title: "Preview URL",
        status: "active",
        createdByRunId: heartbeatRunId,
      });

      await db.insert(workspaceOperations).values({
        companyId: holdingCompanyId,
        executionWorkspaceId,
        heartbeatRunId,
        phase: "boot",
      });

      await db.insert(costEvents).values({
        id: costEventId,
        companyId: holdingCompanyId,
        agentId: leadAgentId,
        issueId,
        projectId,
        heartbeatRunId,
        provider: "openrouter",
        biller: "openrouter",
        billingType: "token",
        model: "minimax",
        costCents: 42,
        occurredAt: new Date("2026-03-20T00:00:00Z"),
      });

      await db.insert(financeEvents).values({
        id: financeEventId,
        companyId: holdingCompanyId,
        agentId: leadAgentId,
        issueId,
        projectId,
        heartbeatRunId,
        costEventId,
        eventKind: "usage",
        biller: "openrouter",
        amountCents: 42,
        occurredAt: new Date("2026-03-20T00:00:00Z"),
      });

      await db.insert(artifacts).values({
        id: artifactId,
        companyId: holdingCompanyId,
        agentId: leadAgentId,
        issueId,
        heartbeatRunId,
        type: "report",
        name: "Recovery artifact",
      });

      await db.insert(activityLog).values({
        companyId: holdingCompanyId,
        actorType: "agent",
        actorId: leadAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        agentId: leadAgentId,
        runId: heartbeatRunId,
      });

      await db.insert(budgetPolicies).values({
        id: budgetPolicyId,
        companyId: holdingCompanyId,
        scopeType: "agent",
        scopeId: leadAgentId,
        windowKind: "calendar_month_utc",
      });

      await db.insert(budgetIncidents).values({
        id: budgetIncidentId,
        companyId: holdingCompanyId,
        policyId: budgetPolicyId,
        scopeType: "agent",
        scopeId: leadAgentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: new Date("2026-03-01T00:00:00Z"),
        windowEnd: new Date("2026-04-01T00:00:00Z"),
        thresholdType: "hard_stop",
        amountLimit: 100,
        amountObserved: 120,
        approvalId,
      });

      const report = await runHoldingMigrationRecovery({
        connectionString,
        companyScope: ["VTL"],
        mode: "apply",
        strict: true,
      });

      expect(report.totals.companies).toBe(1);
      expect(report.totals.conflicts).toBe(0);
      expect(report.totals.applied).toBeGreaterThan(0);

      const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(updatedIssue?.identifier).toBe("EVOA-12");
      expect(updatedIssue?.companyId).toBe(subsidiaryCompanyId);

      const queries = [
        `SELECT company_id FROM issue_comments WHERE issue_id = '${issueId}'`,
        `SELECT company_id FROM issue_read_states WHERE issue_id = '${issueId}'`,
        `SELECT company_id FROM issue_documents WHERE issue_id = '${issueId}'`,
        `SELECT company_id FROM documents WHERE id = '${documentId}'`,
        `SELECT company_id FROM document_revisions WHERE document_id = '${documentId}'`,
        `SELECT company_id FROM issue_attachments WHERE issue_id = '${issueId}'`,
        `SELECT company_id FROM assets WHERE id = '${assetId}'`,
        `SELECT company_id FROM issue_labels WHERE issue_id = '${issueId}'`,
        `SELECT company_id FROM labels WHERE id = '${labelId}'`,
        `SELECT company_id FROM issue_approvals WHERE issue_id = '${issueId}'`,
        `SELECT company_id FROM approvals WHERE id = '${approvalId}'`,
        `SELECT company_id FROM approval_comments WHERE approval_id = '${approvalId}'`,
        `SELECT company_id FROM heartbeat_runs WHERE id = '${heartbeatRunId}'`,
        `SELECT company_id FROM heartbeat_run_events WHERE run_id = '${heartbeatRunId}'`,
        `SELECT company_id FROM agent_runtime_state WHERE agent_id = '${leadAgentId}'`,
        `SELECT company_id FROM agent_task_sessions WHERE agent_id = '${leadAgentId}'`,
        `SELECT company_id FROM agent_wakeup_requests WHERE agent_id = '${leadAgentId}'`,
        `SELECT company_id FROM agent_config_revisions WHERE agent_id = '${leadAgentId}'`,
        `SELECT company_id FROM artifacts WHERE id = '${artifactId}'`,
        `SELECT company_id FROM cost_events WHERE id = '${costEventId}'`,
        `SELECT company_id FROM finance_events WHERE id = '${financeEventId}'`,
        `SELECT company_id FROM workspace_runtime_services WHERE id = '${runtimeServiceId}'`,
        `SELECT company_id FROM workspace_operations WHERE execution_workspace_id = '${executionWorkspaceId}'`,
        `SELECT company_id FROM issue_work_products WHERE issue_id = '${issueId}'`,
        `SELECT company_id FROM project_goals WHERE project_id = '${projectId}'`,
        `SELECT company_id FROM activity_log WHERE entity_id = '${issueId}'`,
        `SELECT company_id FROM budget_policies WHERE id = '${budgetPolicyId}'`,
        `SELECT company_id FROM budget_incidents WHERE id = '${budgetIncidentId}'`,
      ];

      for (const query of queries) {
        const rows = await sql.unsafe<{ company_id: string }[]>(query);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.company_id === subsidiaryCompanyId)).toBe(true);
      }

      await sql.end();
    },
    40_000,
  );
});
