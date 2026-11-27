import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  workspaceOperations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { listUnfinalizedExecutionWorkspaceIds, runWorkspaceIsFinalized } from "../services/issues.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_HISTORY_TEST_DATABASE_URL");

describe("workspace finalize readiness with equal startedAt", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let workspaceId: string;
  let runId: string;
  const startedAt = new Date("2026-01-01T00:00:00.000Z");

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("workspace-finalize-tie-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate workspace_operations, execution_workspaces, heartbeat_runs, agents, companies cascade`);
    companyId = randomUUID(); workspaceId = randomUUID(); runId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Tie fixture", issuePrefix: "TIE" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "manual" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, mode: "isolated_workspace",
      strategyType: "test", name: workspaceId });
  });

  async function record(phase: string, status: string) {
    await db.insert(workspaceOperations).values({ companyId, executionWorkspaceId: workspaceId,
      heartbeatRunId: runId, phase, status, startedAt });
  }

  it("treats the later-written finalize as latest in runWorkspaceIsFinalized", async () => {
    await record("workspace_finalize", "succeeded");
    await record("workspace_finalize", "running");
    expect(await runWorkspaceIsFinalized(db, companyId, workspaceId, runId)).toBe(false);
  });

  it("treats the later-written operation as latest in listUnfinalizedExecutionWorkspaceIds", async () => {
    await record("workspace_finalize", "succeeded");
    await record("workspace_provision", "running");
    expect([...await listUnfinalizedExecutionWorkspaceIds(db, companyId, [workspaceId])]).toEqual([workspaceId]);
  });
});
