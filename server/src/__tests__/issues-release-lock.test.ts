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

describeEmbeddedPostgres("issueService.release lock cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-release-lock-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("clears execution lock fields so a new run can checkout after release", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const staleRunId = randomUUID();
    const freshRunId = randomUUID();

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
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date(),
      },
      {
        id: freshRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "queued",
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionLockedAt: new Date(),
    });

    const released = await svc.release(issueId, agentId, staleRunId);
    expect(released?.status).toBe("todo");

    const checkedOut = await svc.checkout(issueId, agentId, ["todo"], freshRunId);
    expect(checkedOut.status).toBe("in_progress");
    expect(checkedOut.checkoutRunId).toBe(freshRunId);
    expect(checkedOut.executionRunId).toBe(freshRunId);
  });
});
