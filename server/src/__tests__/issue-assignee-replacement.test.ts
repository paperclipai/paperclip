import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres assignee-replacement tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Hidden user-assignment trap (2026-08-17): 22 open cards carried
 * assignee_user_id with no agent — invisible to dispatch — and a single-field
 * PATCH of assigneeAgentId 422ed against the inherited user assignee, making
 * them un-reassignable through the natural call. Setting one assignee kind now
 * replaces the other; only an explicit both-fields write in one request is
 * rejected.
 */
describeEmbeddedPostgres("assignee replacement", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let issuesSvc: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assignee-replacement-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed({ assigneeUserId, assigneeAgentId }: { assigneeUserId?: string; assigneeAgentId?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Assignee Co",
      issuePrefix: `AR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      id: randomUUID(),
      companyId,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      role: "owner",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `AR-${issueId.slice(0, 6)}`,
      title: "Assignee replacement seed",
      status: "todo",
      assigneeUserId: assigneeUserId ?? null,
      assigneeAgentId: assigneeAgentId === "SEEDED" ? agentId : null,
    });
    return { companyId, agentId, issueId };
  }

  it("agent assignment replaces an inherited user assignee instead of 422ing", async () => {
    const { agentId, issueId } = await seed({ assigneeUserId: "local-board" });
    await issuesSvc.update(issueId, { assigneeAgentId: agentId });
    const [row] = await db.select().from(issues);
    const updated = row.id === issueId ? row : (await db.select().from(issues)).find((r) => r.id === issueId)!;
    expect(updated.assigneeAgentId).toBe(agentId);
    expect(updated.assigneeUserId).toBeNull();
  });

  it("user assignment replaces an inherited agent assignee", async () => {
    const { issueId } = await seed({ assigneeAgentId: "SEEDED" });
    await issuesSvc.update(issueId, { assigneeUserId: "local-board" });
    const updated = (await db.select().from(issues)).find((r) => r.id === issueId)!;
    expect(updated.assigneeUserId).toBe("local-board");
    expect(updated.assigneeAgentId).toBeNull();
  });

  it("an explicit both-assignees write in one request is still rejected", async () => {
    const { agentId, issueId } = await seed({});
    await expect(
      issuesSvc.update(issueId, { assigneeAgentId: agentId, assigneeUserId: "local-board" }),
    ).rejects.toThrowError(/one assignee/);
  });
});
