import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  companies,
  agents,
  issues,
  approvals,
} from "@paperclipai/db";
import { hasActionableWork } from "../services/actionable-work.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("W2 idle short-circuit — hasActionableWork predicate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-idle-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      status: "active",
    });
    return { companyId, agentId };
  }

  async function insertIssue(
    companyId: string,
    opts: { status: string; assigneeAgentId?: string | null },
  ) {
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Test issue",
      status: opts.status,
      assigneeAgentId: opts.assigneeAgentId ?? null,
    });
  }

  async function insertGate(
    companyId: string,
    opts: { status: string; designatedAgentId: string | null },
  ) {
    await db.insert(approvals).values({
      id: randomUUID(),
      companyId,
      type: "plan_approval",
      status: opts.status,
      payload: { gate: true, designatedAgentId: opts.designatedAgentId },
    });
  }

  it("returns false for an idle agent with no work", async () => {
    const { companyId, agentId } = await seed();
    expect(await hasActionableWork(db, agentId, companyId)).toBe(false);
  });

  it("returns true for an in_progress assigned issue", async () => {
    const { companyId, agentId } = await seed();
    await insertIssue(companyId, { status: "in_progress", assigneeAgentId: agentId });
    expect(await hasActionableWork(db, agentId, companyId)).toBe(true);
  });

  it("returns true for an in_review assigned issue", async () => {
    const { companyId, agentId } = await seed();
    await insertIssue(companyId, { status: "in_review", assigneeAgentId: agentId });
    expect(await hasActionableWork(db, agentId, companyId)).toBe(true);
  });

  it("returns false for a blocked / backlog / done assigned issue", async () => {
    const { companyId, agentId } = await seed();
    await insertIssue(companyId, { status: "blocked", assigneeAgentId: agentId });
    await insertIssue(companyId, { status: "backlog", assigneeAgentId: agentId });
    await insertIssue(companyId, { status: "done", assigneeAgentId: agentId });
    expect(await hasActionableWork(db, agentId, companyId)).toBe(false);
  });

  it("returns false when the in_progress issue is assigned to another agent", async () => {
    const { companyId, agentId } = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      status: "active",
    });
    await insertIssue(companyId, { status: "in_progress", assigneeAgentId: otherAgentId });
    expect(await hasActionableWork(db, agentId, companyId)).toBe(false);
  });

  it("returns true for a pending gate designated to the agent", async () => {
    const { companyId, agentId } = await seed();
    await insertGate(companyId, { status: "pending", designatedAgentId: agentId });
    expect(await hasActionableWork(db, agentId, companyId)).toBe(true);
  });

  it("returns false for a pending gate designated to a different agent", async () => {
    const { companyId, agentId } = await seed();
    await insertGate(companyId, { status: "pending", designatedAgentId: randomUUID() });
    expect(await hasActionableWork(db, agentId, companyId)).toBe(false);
  });

  it("returns false for a decided (non-pending) gate", async () => {
    const { companyId, agentId } = await seed();
    await insertGate(companyId, { status: "approved", designatedAgentId: agentId });
    expect(await hasActionableWork(db, agentId, companyId)).toBe(false);
  });
});
