import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity-log run_id fallback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("logActivity run_id graceful degradation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId!: string;
  let agentId!: string;
  let registeredRunId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-log-runid-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    registeredRunId = randomUUID();

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
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: registeredRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function onlyActivityRow() {
    const rows = await db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it("writes a registered run_id unchanged", async () => {
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.created",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      runId: registeredRunId,
    });

    expect((await onlyActivityRow()).runId).toBe(registeredRunId);
  });

  it("substitutes NULL for a well-formed but unregistered run_id instead of throwing", async () => {
    const unregisteredRunId = randomUUID();

    await expect(
      logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.created",
        entityType: "issue",
        entityId: randomUUID(),
        agentId,
        runId: unregisteredRunId,
      }),
    ).resolves.not.toThrow();

    expect((await onlyActivityRow()).runId).toBeNull();
  });

  it("leaves a null run_id null (existing behavior unchanged)", async () => {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.created",
      entityType: "issue",
      entityId: randomUUID(),
      runId: null,
    });

    expect((await onlyActivityRow()).runId).toBeNull();
  });
});
