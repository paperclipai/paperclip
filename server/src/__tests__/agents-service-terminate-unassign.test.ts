import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentApiKeys, agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service terminate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-terminate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("unassigns the terminated agent's issues so they stay mutable", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Retired");

    const openIssueId = randomUUID();
    const reviewIssueId = randomUUID();
    const doneIssueId = randomUUID();

    await db.insert(issues).values([
      { id: openIssueId, companyId, title: "Open work", status: "todo", assigneeAgentId: agentId },
      { id: reviewIssueId, companyId, title: "In review", status: "in_review", assigneeAgentId: agentId },
      { id: doneIssueId, companyId, title: "Finished work", status: "done", assigneeAgentId: agentId },
    ]);

    const terminated = await agentService(db).terminate(agentId);
    expect(terminated).toMatchObject({ id: agentId, status: "terminated" });

    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.assigneeAgentId).toBeNull();
    }

    // Statuses must survive. Termination detaches ownership; it does not
    // reopen, close, or otherwise move the work.
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(openIssueId)?.status).toBe("todo");
    expect(byId.get(reviewIssueId)?.status).toBe("in_review");
    expect(byId.get(doneIssueId)?.status).toBe("done");
  });

  it("leaves other agents' issues untouched", async () => {
    const companyId = await seedCompany();
    const terminatedAgentId = await seedAgent(companyId, "Retired");
    const survivingAgentId = await seedAgent(companyId, "Active");

    const keptIssueId = randomUUID();
    await db.insert(issues).values([
      { companyId, title: "Retired agent work", status: "todo", assigneeAgentId: terminatedAgentId },
      { id: keptIssueId, companyId, title: "Active agent work", status: "todo", assigneeAgentId: survivingAgentId },
    ]);

    await agentService(db).terminate(terminatedAgentId);

    const [kept] = await db.select().from(issues).where(eq(issues.id, keptIssueId));
    expect(kept?.assigneeAgentId).toBe(survivingAgentId);

    const [survivor] = await db.select().from(agents).where(eq(agents.id, survivingAgentId));
    expect(survivor?.status).toBe("idle");
  });

  it("keeps authorship attribution and still revokes api keys", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Retired");

    const authoredIssueId = randomUUID();
    await db.insert(issues).values({
      id: authoredIssueId,
      companyId,
      title: "Authored by the retired agent",
      status: "todo",
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
    });

    await db.insert(agentApiKeys).values({
      agentId,
      companyId,
      name: "default",
      keyHash: "hash",
    });

    await agentService(db).terminate(agentId);

    const [authored] = await db.select().from(issues).where(eq(issues.id, authoredIssueId));
    expect(authored?.assigneeAgentId).toBeNull();
    // The agent row survives termination, so authorship remains a valid
    // reference. Only `remove` clears it.
    expect(authored?.createdByAgentId).toBe(agentId);

    const keys = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it("returns null for an unknown agent", async () => {
    expect(await agentService(db).terminate(randomUUID())).toBeNull();
  });
});
