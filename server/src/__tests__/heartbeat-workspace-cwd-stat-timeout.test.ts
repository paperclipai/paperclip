import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const HANGING_WORKSPACE_CWD = "/tmp/paperclip-hanging-workspace-cwd-test";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const stat: typeof actual.stat = ((path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
    if (path === HANGING_WORKSPACE_CWD) {
      return new Promise(() => {});
    }
    // @ts-expect-error - forwarding whatever arguments actual.stat was called with
    return actual.stat(path, ...rest);
  }) as typeof actual.stat;
  return { ...actual, default: { ...actual, stat }, stat };
});

const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "workspace-cwd-stat-timeout test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

type Db = ReturnType<typeof createDb>;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat workspace-cwd-stat-timeout tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-cwd-stat-timeout-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "workspace cwd stat timeout\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

async function waitForHeartbeatIdle(db: Db, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function deleteHeartbeatRowsAfterActivityLogDrains(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(issueComments);
    try {
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

describeEmbeddedPostgres("heartbeat wakeup: session workspace cwd stat timeout", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-cwd-stat-timeout-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await waitForHeartbeatIdle(db);
    adapterExecute.mockClear();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(agentTaskSessions);
    await db.delete(environmentLeases);
    await db.delete(workspaceOperations);
    await deleteHeartbeatRowsAfterActivityLogDrains(db);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  async function seedWakeTarget() {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();

    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace Cwd Stat Timeout",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: repoRoot,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Reproduces the stalled workspace-cwd stat",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: `PAP-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: issueId,
      sessionParamsJson: {
        sessionId: "prior-session",
        cwd: HANGING_WORKSPACE_CWD,
        workspaceId: projectWorkspaceId,
      },
      sessionDisplayId: "prior-session",
    });

    return { companyId, agentId, issueId };
  }

  it(
    "does not hang the wake (and its db.transaction) forever when the prior session's workspace cwd stat() stalls",
    async () => {
      const { agentId, issueId } = await seedWakeTarget();
      const heartbeat = heartbeatService(db);

      const start = Date.now();
      await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          skipIssueComment: true,
        },
      });
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(12_000);

      const stuck = await db.execute(
        sql`select count(*)::int as count from pg_stat_activity where state = 'idle in transaction'`,
      );
      const row = (stuck as unknown as { count: number }[])[0];
      expect(row?.count ?? 0).toBe(0);
    },
    20_000,
  );
});
