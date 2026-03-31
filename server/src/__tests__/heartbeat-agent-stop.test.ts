import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent stop tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for child exit")), timeoutMs)),
  ]);
}

describeEmbeddedPostgres("heartbeat agent stop", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-stop-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunningRun(processPid: number | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-03-31T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude Operator",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {},
      processPid,
      startedAt: now,
      updatedAt: now,
    });

    return { agentId, runId, wakeupRequestId };
  }

  it("cancels active local runs using the persisted pid when the in-memory handle is gone", async () => {
    const child = spawnAliveProcess();
    expect(child.pid).toBeTypeOf("number");

    const { agentId, runId, wakeupRequestId } = await seedRunningRun(child.pid ?? null);
    const heartbeat = heartbeatService(db);

    const cancelledRuns = await heartbeat.cancelActiveForAgent(agentId, "Cancelled by operator");
    expect(cancelledRuns).toBe(1);

    await waitForExit(child);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("cancelled");
    expect(run?.error).toBe("Cancelled by operator");

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("cancelled");

    const events = await heartbeat.listEvents(runId, 0, 20);
    expect(events.some((event) => event.message === "run cancelled")).toBe(true);
  });
});
