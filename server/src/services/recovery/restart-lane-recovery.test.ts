import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "./service.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("restart-lane recovery sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restart-lane-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  async function seedErroredLane(input: { companyId: string; name: string; error: string }) {
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const createdAt = new Date(Date.now() - 1_000);
    await db.insert(agents).values({
      id: agentId, companyId: input.companyId, name: input.name, role: "engineer", status: "error",
      errorReason: input.error, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: failedRunId, companyId: input.companyId, agentId, status: "failed", invocationSource: "automation",
      error: input.error, createdAt,
    });
    return { agentId, failedRunId, createdAt };
  }

  it("recovers a 12-lane restart in batches of 5/5/2 and requires a successor run id", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Recovery Co", issuePrefix: "RC", requireBoardApprovalForNewAgents: false,
    });
    const lanes = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      seedErroredLane({ companyId, name: `Lane ${index + 1}`, error: "connection_close" }),
    ));
    let active = 0;
    let maxActive = 0;
    const enqueueWakeup = vi.fn(async (agentId: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const successor = {
        id: randomUUID(), companyId, agentId, status: "succeeded" as const,
        invocationSource: "automation" as const, createdAt: new Date(),
      };
      await db.insert(heartbeatRuns).values(successor);
      return successor as any;
    });

    const result = await recoveryService(db, { enqueueWakeup }).sweepRestartLaneRecovery();

    expect(result).toMatchObject({ candidates: 12, reset: 12, recovered: 12, unrecoverable: 0 });
    expect(result.batchSizes).toEqual([5, 5, 2]);
    expect(result.successorRunIds).toHaveLength(12);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(enqueueWakeup).toHaveBeenCalledTimes(12);
    const statuses = await db.select({ id: agents.id, status: agents.status }).from(agents).where(eq(agents.companyId, companyId));
    expect(statuses).toHaveLength(12);
    expect(statuses.every((agent) => agent.status === "idle")).toBe(true);
    expect(lanes).toHaveLength(12);
  });

  it("leaves non-restart errors in error state without waking them", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Non restart Co", issuePrefix: "NRC", requireBoardApprovalForNewAgents: false,
    });
    const lane = await seedErroredLane({ companyId, name: "Configuration lane", error: "Invalid API key" });
    const enqueueWakeup = vi.fn();

    const result = await recoveryService(db, { enqueueWakeup }).sweepRestartLaneRecovery();

    expect(result).toMatchObject({ candidates: 0, reset: 0, recovered: 0, unrecoverable: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    const agent = await db.select().from(agents).where(eq(agents.id, lane.agentId)).then((rows) => rows[0]);
    expect(agent).toMatchObject({ status: "error", errorReason: "Invalid API key" });
  });
});
