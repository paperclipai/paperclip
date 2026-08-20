import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("logActivity run_id provenance (KEWL-3766 / KEWL-3768 / KEWL-3769)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-run-provenance-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "default-user",
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
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves an unknown runId to null instead of throwing an FK violation", async () => {
    const unknownRunId = randomUUID();

    const activity = await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      runId: unknownRunId,
    });

    expect(activity?.id).toBeTruthy();

    const row = await db
      .select({ runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.id, activity!.id))
      .then((rows) => rows[0]);

    expect(row?.runId).toBeNull();
  });

  it("preserves a runId that references a known heartbeat run", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
    });

    const activity = await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      runId,
    });

    expect(activity?.id).toBeTruthy();

    const row = await db
      .select({ runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.id, activity!.id))
      .then((rows) => rows[0]);

    expect(row?.runId).toBe(runId);
  });
});
