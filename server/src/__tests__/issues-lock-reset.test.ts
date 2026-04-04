import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue lock reset tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService execution lock reset", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-lock-reset-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("clears execution lock fields on release so the assignee can checkout again", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const staleRunId = randomUUID();
    const nextRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Staff Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      { id: staleRunId, companyId, agentId, status: "running" },
      { id: nextRunId, companyId, agentId, status: "queued" },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "QA blocker",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionLockedAt: new Date("2026-03-31T00:00:00.000Z"),
      executionAgentNameKey: "staff-engineer",
    });

    const released = await svc.release(issueId, agentId, staleRunId);
    expect(released).toBeTruthy();
    expect(released?.status).toBe("todo");
    expect(released?.assigneeAgentId).toBeNull();
    expect(released?.checkoutRunId).toBeNull();
    expect(released?.executionRunId).toBeNull();
    expect(released?.executionLockedAt).toBeNull();
    expect(released?.executionAgentNameKey).toBeNull();

    const recheckedOut = await svc.checkout(issueId, agentId, ["todo"], nextRunId);
    expect(recheckedOut.status).toBe("in_progress");
    expect(recheckedOut.assigneeAgentId).toBe(agentId);
    expect(recheckedOut.checkoutRunId).toBe(nextRunId);
    expect(recheckedOut.executionRunId).toBe(nextRunId);
  });

  it("clears execution lock fields when status leaves in_progress", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const staleRunId = randomUUID();
    const nextRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Staff Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      { id: staleRunId, companyId, agentId, status: "running" },
      { id: nextRunId, companyId, agentId, status: "queued" },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Status reset path",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionLockedAt: new Date("2026-03-31T00:00:00.000Z"),
      executionAgentNameKey: "staff-engineer",
    });

    const blocked = await svc.update(issueId, { status: "blocked" });
    expect(blocked).toBeTruthy();
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.checkoutRunId).toBeNull();
    expect(blocked?.executionRunId).toBeNull();
    expect(blocked?.executionLockedAt).toBeNull();
    expect(blocked?.executionAgentNameKey).toBeNull();

    const recheckedOut = await svc.checkout(issueId, agentId, ["blocked"], nextRunId);
    expect(recheckedOut.status).toBe("in_progress");
    expect(recheckedOut.assigneeAgentId).toBe(agentId);
    expect(recheckedOut.checkoutRunId).toBe(nextRunId);
    expect(recheckedOut.executionRunId).toBe(nextRunId);
  });
});
