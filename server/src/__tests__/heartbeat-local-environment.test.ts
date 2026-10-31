import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  authUsers,
  createDb,
  environmentLeases,
  environments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { projectService } from "../services/projects.js";
import { environmentService } from "../services/environments.js";

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
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousAgentJwtSecret: string | undefined;

  beforeAll(async () => {
    previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "heartbeat-local-environment-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-local-environment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    // A run reaches its terminal status before finalizeRun finishes writing
    // its trailing lifecycle events and side effects (see the comment on
    // drainActiveRunExecutions in heartbeat.ts). Drain those in-flight writes
    // before the TRUNCATE below, or a write that lands after the company row
    // is gone violates heartbeat_run_events' foreign key.
    await heartbeat.drainActiveRunExecutions();
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
    // Same reasoning as the afterEach drain: closing the embedded database
    // while a run's finalize work is still in flight lets a queued write hit
    // a socket that cleanup() already tore down.
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
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

  it.each([{ enabled: false, otherSource: false }, { enabled: true, otherSource: false }, { enabled: false, otherSource: true }])(
    "dispatches through the task project's saved environment (checkout policy=$enabled, other project source=$otherSource)", async ({ enabled, otherSource }) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const tempDir = await mkdtemp(join(tmpdir(), "paperclip-project-environment-"));
    const output = join(tempDir, "selected-environment.txt");
    await db.insert(companies).values({ id: companyId, name: "Project environment", issuePrefix: "ENV",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Test operator", email: "environment@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "owner" });
    const selected = await environmentService(db).ensureLocalEnvironment(companyId);
    await db.update(environments).set({ envVars: { PROJECT_ENVIRONMENT_MARKER: { type: "plain", value: "project-computer" } } })
      .where(eq(environments.id, selected.id));
    const [fallback] = await db.insert(environments).values({ name: "Unavailable agent computer", driver: "sandbox", status: "archived",
      config: { provider: "daytona", image: "test/unused" } }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Project without a codebase" }).returning();
    await projectService(db).update(project.id, { executionWorkspacePolicy: { enabled, environmentId: selected.id } });
    expect((await projectService(db).getById(project.id))?.executionWorkspacePolicy).toMatchObject({ enabled, environmentId: selected.id });
    await db.insert(agents).values({ id: agentId, companyId, name: "Project agent", status: "idle", adapterType: "process",
      defaultEnvironmentId: fallback.id,
      adapterConfig: { command: process.execPath, args: ["-e",
        `require('node:fs').writeFileSync(${JSON.stringify(output)}, process.env.PROJECT_ENVIRONMENT_MARKER ?? 'wrong-environment')`] } });
    let sourceWorkspaceId: string | undefined;
    if (otherSource) {
      const [sourceProject] = await db.insert(projects).values({ companyId, name: "Different source project",
        executionWorkspacePolicy: { enabled: false, environmentId: fallback.id } }).returning();
      const [source] = await db.insert(projectWorkspaces).values({ companyId, projectId: sourceProject.id, name: "Source files",
        cwd: tempDir, sourceType: "non_git_path", isPrimary: true }).returning();
      sourceWorkspaceId = source.id;
    }
    const [issue] = await db.insert(issues).values({ companyId, projectId: project.id, projectWorkspaceId: sourceWorkspaceId, title: "Use the project computer",
      status: "todo", assigneeAgentId: agentId }).returning();

    const queued = await heartbeat.invoke(agentId, "on_demand", { issueId: issue.id }, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id, 15_000);
    expect(finished?.status).toBe("succeeded");
    expect(await readFile(output, "utf8")).toBe("project-computer");
    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ environmentId: selected.id, status: "released" });
    expect(finished?.contextSnapshot?.paperclipEnvironment).toMatchObject({ id: selected.id, name: selected.name });
    await heartbeat.drainActiveRunExecutions();

    // Clearing restores the agent's choice and preserves its inactive-target error.
    await projectService(db).update(project.id, { executionWorkspacePolicy: { enabled, environmentId: null } });
    expect((await projectService(db).getById(project.id))?.executionWorkspacePolicy?.environmentId).toBeNull();
    const [nextIssue] = await db.insert(issues).values({ companyId, projectId: project.id, projectWorkspaceId: sourceWorkspaceId,
      title: "Inherit the agent computer", status: "todo", assigneeAgentId: agentId }).returning();
    const next = await heartbeat.invoke(agentId, "on_demand", { issueId: nextIssue.id }, "manual");
    expect(next!.id).not.toBe(queued!.id);
    const nextFinished = await waitForRunToFinish(heartbeat, next!.id, 15_000);
    expect(nextFinished?.status, JSON.stringify({ error: nextFinished?.error, retryReason: nextFinished?.scheduledRetryReason })).not.toBe("succeeded");
    expect(nextFinished?.error).toContain("Unavailable agent computer");
    expect(await readFile(output, "utf8")).toBe("project-computer");
  });

  it("injects run-scoped Paperclip env into process agents", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const tempDir = await mkdtemp(join(tmpdir(), "paperclip-process-env-"));
    const envPath = join(tempDir, "env.json");

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
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({`,
            "agentId: process.env.PAPERCLIP_AGENT_ID ?? null,",
            "companyId: process.env.PAPERCLIP_COMPANY_ID ?? null,",
            "apiUrl: process.env.PAPERCLIP_API_URL ?? null,",
            "runId: process.env.PAPERCLIP_RUN_ID ?? null,",
            "apiKeyPresent: Boolean(process.env.PAPERCLIP_API_KEY),",
            "}));",
          ].join(" "),
        ],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const captured = JSON.parse(await readFile(envPath, "utf8")) as Record<string, unknown>;
    expect(captured).toMatchObject({
      agentId,
      companyId,
      runId: queued!.id,
      apiKeyPresent: true,
    });
    expect(captured.apiUrl).toEqual(expect.stringMatching(/^https?:\/\//));
  });
});
