import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { activityLog, approvals as approvalsTable, heartbeatRuns } from "@paperclipai/db";
import { createIntegrationHarness } from "../test-support/integration-harness.js";

async function waitForCondition<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe.sequential("governance integration", () => {
  let harness: Awaited<ReturnType<typeof createIntegrationHarness>>;

  beforeAll(async () => {
    harness = await createIntegrationHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("wakes the requesting manager when a manager-plan approval is approved", async () => {
    const company = await harness.createCompany({ name: "Governance Labs" });
    const manager = await harness.createAgent(company.id as string, {
      name: "Manager Bot",
      role: "manager",
      adapterConfig: {
        command: "node",
        args: ["-e", "setTimeout(() => process.exit(0), 25)"],
        timeoutSec: 10,
      },
    });
    const issue = await harness.createIssue(company.id as string, {
      title: "Manager plan follow-through",
      assigneeAgentId: manager.id,
    });
    const approval = await harness.createApproval(company.id as string, {
      type: "approve_manager_plan",
      requestedByAgentId: manager.id,
      issueIds: [issue.id],
      payload: {
        title: "Roadmap plan",
        summary: "Turn the next roadmap item into delivery work.",
      },
    });

    const approved = await harness.board.post(`/approvals/${approval.id as string}/approve`).send({
      decidedByUserId: "local-board",
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");

    const wakeRun = await waitForCondition("approval wakeup run", async () => {
      return harness.db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, company.id as string), eq(heartbeatRuns.agentId, manager.id as string)))
        .orderBy(desc(heartbeatRuns.createdAt))
        .then((rows) => rows[0] ?? null);
    });
    expect(wakeRun.contextSnapshot).toMatchObject({
      approvalId: approval.id,
      issueId: issue.id,
      wakeReason: "approval_approved",
    });

    const approvalActions = await harness.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, company.id as string), eq(activityLog.entityId, approval.id as string)))
      .orderBy(desc(activityLog.createdAt));

    expect(approvalActions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["approval.approved", "approval.requester_wakeup_queued"]),
    );
  });

  it("rejects cross-company reporting lines and keeps secret-backed approval payloads redacted", async () => {
    const companyA = await harness.createCompany({ name: "Alpha Co" });
    const companyB = await harness.createCompany({ name: "Beta Co" });
    const foreignManager = await harness.createAgent(companyA.id as string, {
      name: "Foreign Manager",
      role: "manager",
    });

    const invalidAgent = await harness.board.post(`/companies/${companyB.id as string}/agents`).send({
      name: "Cross Company Report",
      role: "general",
      reportsTo: foreignManager.id,
      adapterType: "process",
      adapterConfig: {
        command: "node",
        args: ["-e", "process.stdout.write('x')"],
      },
    });
    expect(invalidAgent.status).toBe(422);

    const securedCompany = await harness.createCompany({ name: "Secret Co" });
    const secret = await harness.createSecret(securedCompany.id as string, {
      name: "openai-api-key",
      value: "sk-live-secret",
    });
    const approval = await harness.createApproval(securedCompany.id as string, {
      type: "hire_agent",
      payload: {
        name: "Secured Hire",
        role: "general",
        adapterType: "process",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
            },
          },
        },
      },
    });

    const listedSecrets = await harness.board.get(`/companies/${securedCompany.id as string}/secrets`);
    expect(listedSecrets.status).toBe(200);
    expect(JSON.stringify(listedSecrets.body)).not.toContain("sk-live-secret");

    const fetchedApproval = await harness.board.get(`/approvals/${approval.id as string}`);
    expect(fetchedApproval.status).toBe(200);
    expect(JSON.stringify(fetchedApproval.body)).not.toContain("sk-live-secret");

    const storedApproval = await harness.db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approval.id as string))
      .then((rows) => rows[0]!);
    expect(storedApproval.payload).toMatchObject({
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "secret_ref",
            secretId: secret.id,
            version: "latest",
          },
        },
      },
    });

    const creationActivity = await harness.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, securedCompany.id as string), eq(activityLog.entityId, approval.id as string)))
      .orderBy(desc(activityLog.createdAt))
      .then((rows) => rows[0]!);
    expect(JSON.stringify(creationActivity.details ?? {})).not.toContain("sk-live-secret");
  });
});
