import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  activityLog,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat auth pre-flight check", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-auth-preflight-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    unregisterServerAdapter("mock_adapter");
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("refuses to claim runs when adapter auth probe fails", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const adapterType = "mock_adapter";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "MockAgent",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
           enabled: true,
           maxConcurrentRuns: 1,
        }
      },
      permissions: {},
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "manual",
      contextSnapshot: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      triggerDetail: "test-cron",
    });

    const probeAuth = vi.fn().mockResolvedValue({
      status: "unauthenticated",
      source: "api_key",
      requestId: "req-123",
      detail: "Invalid API key",
      probedAt: new Date().toISOString(),
    });

    registerServerAdapter({
      type: adapterType,
      execute: vi.fn(),
      testEnvironment: vi.fn(),
      probeAuth,
    } as any);

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    expect(probeAuth).toHaveBeenCalledTimes(1);

    // Verify run is still queued
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("queued");

    // Verify activity was logged
    const logs = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "adapter.auth_probe_failed")
    ));
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({
      adapterType,
      probeStatus: "unauthenticated",
      requestId: "req-123",
      triggerDetail: "test-cron",
    });

    // Second call within 1 minute should use cache and not call probeAuth again
    await heartbeat.resumeQueuedRuns();
    expect(probeAuth).toHaveBeenCalledTimes(1);
  });
});
