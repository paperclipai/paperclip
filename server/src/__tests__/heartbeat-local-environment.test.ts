import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat environment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

async function waitForRunLeasesToRelease(
  db: ReturnType<typeof createDb>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, runId));
    if (leases.length > 0 && leases.every((lease) => lease.status !== "active")) return leases;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await db
    .select()
    .from(environmentLeases)
    .where(eq(environmentLeases.heartbeatRunId, runId));
}

describeEmbeddedPostgres("heartbeat local environment lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-local-environment-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("clears agent errorReason when a new heartbeat starts", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "error",
      errorReason: "Configured OpenCode model is unavailable: openai/gpt-5.1-codex.",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 500)"],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const deadline = Date.now() + 5_000;
    let sawRunningWithClearedError = false;
    while (Date.now() < deadline) {
      const [agentRow] = await db
        .select({ status: agents.status, errorReason: agents.errorReason })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (agentRow?.status === "running" && agentRow?.errorReason === null) {
        sawRunningWithClearedError = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(sawRunningWithClearedError).toBe(true);

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
  });

  it("runs work through the default Local environment lease", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const localRows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "local"));
    expect(localRows).toHaveLength(1);
    expect(localRows[0]?.name).toBe("Local");

    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.environmentId).toBe(localRows[0]?.id);
    expect(leases[0]?.status).toBe("released");
    expect(leases[0]?.provider).toBe("local");
    expect(leases[0]?.releasedAt).not.toBeNull();

    const context = finished?.contextSnapshot as Record<string, unknown>;
    expect(context.paperclipEnvironment).toMatchObject({
      id: localRows[0]?.id,
      name: "Local",
      driver: "local",
      leaseId: leases[0]?.id,
    });
  });
});
