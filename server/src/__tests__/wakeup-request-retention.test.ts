import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { wakeupRequestRetentionService } from "../services/wakeup-request-retention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent wakeup request retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wakeup-request-retention-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("prunes old skipped and coalesced rows in bounded batches while preserving audit and referenced rows", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const old = new Date("2026-08-12T12:00:00.000Z");
    const withinDiagnosticsWindow = new Date("2026-08-19T12:00:00.000Z");
    const recent = new Date("2026-08-26T12:00:00.000Z");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ids = {
      skipped: randomUUID(),
      coalesced: randomUUID(),
      completed: randomUUID(),
      failed: randomUUID(),
      diagnosticsWindowSkipped: randomUUID(),
      recentSkipped: randomUUID(),
      referencedSkipped: randomUUID(),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "RET",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Retention Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: ids.skipped,
        companyId,
        agentId,
        source: "assignment",
        status: "skipped",
        requestedAt: old,
        finishedAt: old,
      },
      {
        id: ids.coalesced,
        companyId,
        agentId,
        source: "assignment",
        status: "coalesced",
        requestedAt: old,
        finishedAt: old,
        runId: randomUUID(),
      },
      {
        id: ids.completed,
        companyId,
        agentId,
        source: "assignment",
        status: "completed",
        requestedAt: old,
        finishedAt: old,
      },
      {
        id: ids.failed,
        companyId,
        agentId,
        source: "assignment",
        status: "failed",
        requestedAt: old,
        finishedAt: old,
      },
      {
        id: ids.diagnosticsWindowSkipped,
        companyId,
        agentId,
        source: "assignment",
        status: "skipped",
        requestedAt: withinDiagnosticsWindow,
        finishedAt: withinDiagnosticsWindow,
      },
      {
        id: ids.recentSkipped,
        companyId,
        agentId,
        source: "assignment",
        status: "skipped",
        requestedAt: recent,
        finishedAt: recent,
      },
      {
        id: ids.referencedSkipped,
        companyId,
        agentId,
        source: "assignment",
        status: "skipped",
        requestedAt: old,
        finishedAt: old,
        runId: randomUUID(),
      },
    ]);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      wakeupRequestId: ids.referencedSkipped,
      finishedAt: old,
    });

    const retention = wakeupRequestRetentionService(db);
    await expect(retention.pruneTerminalRequests({ now, batchSize: 1 })).resolves.toMatchObject({
      deleted: 1,
      hasMore: true,
    });
    await expect(retention.pruneTerminalRequests({ now, batchSize: 100 })).resolves.toMatchObject({
      deleted: 1,
      hasMore: false,
    });

    const remaining = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, Object.values(ids)))
      .then((rows) => rows.map((row) => row.id).sort());

    expect(remaining).toEqual([
      ids.completed,
      ids.diagnosticsWindowSkipped,
      ids.failed,
      ids.recentSkipped,
      ids.referencedSkipped,
    ].sort());
  });
});
