import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("freezes generic pending hire config and reapplies the approval snapshot on activation", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "idle",
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
    });
  });
});
