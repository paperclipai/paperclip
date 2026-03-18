import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import {
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
} from "@paperclipai/db";
import { and, eq, ne } from "drizzle-orm";

describe("workspace isolation: conflict detection query", () => {
  let databaseDir = "";
  let db: ReturnType<typeof createDb>;
  let embeddedPostgres: EmbeddedPostgres;
  let companyId = "";
  let agentAId = "";
  let agentBId = "";

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-workspace-isolation-"));
    const port = await detectPort(55434);
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });

    await embeddedPostgres.initialise();
    await embeddedPostgres.start();

    const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "paperclip");

    const databaseUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);

    companyId = randomUUID();
    agentAId = randomUUID();
    agentBId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workspace Isolation Test Company",
      issuePrefix: "WIT",
    });

    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Agent A",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Agent B",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }, 120_000);

  it("detects a running run by another agent on the same workspace cwd", async () => {
    const projectCwd = "/home/test/project";

    // Agent A has a running run with workspaceCwd set
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: agentAId,
      status: "running",
      workspaceCwd: projectCwd,
      startedAt: new Date(),
    });

    // Query for conflicts from Agent B's perspective
    const conflictingRun = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.workspaceCwd, projectCwd),
          eq(heartbeatRuns.status, "running"),
          ne(heartbeatRuns.agentId, agentBId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    expect(conflictingRun).not.toBeNull();
    expect(conflictingRun!.agentId).toBe(agentAId);
  });

  it("does not flag own agent's run as a conflict", async () => {
    const projectCwd = "/home/test/own-agent-project";

    // Agent B has a running run with workspaceCwd set
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: agentBId,
      status: "running",
      workspaceCwd: projectCwd,
      startedAt: new Date(),
    });

    // Query for conflicts from Agent B's own perspective (should not find itself)
    const conflictingRun = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.workspaceCwd, projectCwd),
          eq(heartbeatRuns.status, "running"),
          ne(heartbeatRuns.agentId, agentBId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    expect(conflictingRun).toBeNull();
  });

  it("does not flag finished runs as conflicts", async () => {
    const projectCwd = "/home/test/finished-project";

    // Agent A has a finished run with workspaceCwd set
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: agentAId,
      status: "succeeded",
      workspaceCwd: projectCwd,
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    // Query for conflicts from Agent B's perspective (should find nothing)
    const conflictingRun = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.workspaceCwd, projectCwd),
          eq(heartbeatRuns.status, "running"),
          ne(heartbeatRuns.agentId, agentBId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    expect(conflictingRun).toBeNull();
  });

  it("does not flag runs without workspaceCwd as conflicts", async () => {
    const projectCwd = "/home/test/null-cwd-project";

    // Agent A has a running run without workspaceCwd
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: agentAId,
      status: "running",
      workspaceCwd: null,
      startedAt: new Date(),
    });

    // Query for conflicts (should find nothing since workspaceCwd is null)
    const conflictingRun = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.workspaceCwd, projectCwd),
          eq(heartbeatRuns.status, "running"),
          ne(heartbeatRuns.agentId, agentBId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    expect(conflictingRun).toBeNull();
  });
});
