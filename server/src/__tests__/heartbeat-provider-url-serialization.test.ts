import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping provider-url heartbeat scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat provider-url serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-provider-url-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps queued runs blocked while another run with the same provider URL is active", async () => {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const activeAgentId = randomUUID();
    const queuedAgentId = randomUUID();
    const activeRunId = randomUUID();
    const queuedRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: activeAgentId,
        companyId,
        name: "Active",
        role: "engineer",
        status: "running",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "setTimeout(() => process.exit(0), 500)"],
          env: { OPENAI_BASE_URL: "https://provider.example/v1/" },
        },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: queuedAgentId,
        companyId,
        name: "Queued",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "setTimeout(() => process.exit(0), 500)"],
          env: { OPENAI_BASE_URL: "https://provider.example/v1" },
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: activeRunId,
        companyId,
        agentId: activeAgentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "running",
        contextSnapshot: {},
      },
      {
        id: queuedRunId,
        companyId,
        agentId: queuedAgentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        contextSnapshot: {},
      },
    ]);

    await instanceSettingsService(db).updateExperimental({ serializeAgentRunsByProviderUrl: true });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const blockedRun = await heartbeat.getRun(queuedRunId);
    expect(blockedRun?.status).toBe("queued");

    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, activeRunId));
    await db
      .update(agents)
      .set({
        status: "idle",
        updatedAt: new Date(),
      })
      .where(eq(agents.id, activeAgentId));

    await heartbeat.resumeQueuedRuns();

    const resumedRun = await waitFor(
      () => heartbeat.getRun(queuedRunId),
      (run) => Boolean(run && run.status !== "queued"),
    );
    expect(resumedRun?.status).not.toBe("queued");
  });
});
