import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const execFileAsync = promisify(execFile);

// Fails the test loudly if the adapter is ever invoked — the run must abort
// during workspace resolution, before any adapter execution.
const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("adapter.execute must not run when realization fails loud");
  }),
);

const allowCcrotateGate = {
  checkAdapter: async () => ({ allow: true as const }),
  _resetForTesting: () => {},
};

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres preferred-workspace fail-loud tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-fail-loud-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "paperclip-test@example.com"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Paperclip Test"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "fail loud\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  return repoRoot;
}

describeEmbeddedPostgres("preferred non-primary workspace fail-loud", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fail-loud-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    // Drain any in-flight run lifecycle work before teardown so the heartbeat's
    // async finalizers don't touch the DB after it closes.
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 5) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("fails loud (no adapter run, no execution workspace) when a non-primary target cannot be realized", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const primaryWorkspaceId = randomUUID();
    const nonPrimaryWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    // A non-primary workspace whose configured cwd does not exist on disk and
    // has no repoUrl to clone — realization cannot satisfy it.
    const missingCwd = path.join(os.tmpdir(), `paperclip-missing-${randomUUID()}`);

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Fail Loud Project",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Primary workspace (realizable) created first; the non-primary target is
    // created later and explicitly flagged isPrimary=false.
    await db.insert(projectWorkspaces).values({
      id: primaryWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: repoRoot,
      isPrimary: true,
      createdAt: new Date(Date.now() - 1000),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: nonPrimaryWorkspaceId,
      companyId,
      projectId,
      name: "Secondary (unrealizable)",
      cwd: missingCwd,
      isPrimary: false,
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
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId: nonPrimaryWorkspaceId,
      title: "Targets unrealizable non-primary workspace",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: "PAP-8188",
      executionWorkspaceSettings: { mode: "shared_workspace" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db, { ccrotateGate: allowCcrotateGate });
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
      },
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("failed");
    }, { timeout: 10_000 });

    const failed = await heartbeat.getRun(run!.id);
    // Typed, non-retryable structured failure — not a silent fallback run.
    expect(failed?.errorCode).toBe("preferred_workspace_unrealizable");
    expect(failed?.error).toContain(nonPrimaryWorkspaceId);
    expect(failed?.error).toContain("Refusing to run");

    // The adapter never executed: resolution aborted before any agent run.
    expect(adapterExecute).not.toHaveBeenCalled();

    // No execution-workspace row was persisted — the run left no partial state
    // and nothing was stamped with a mismatched source.
    const persistedExecutionWorkspaces = await db.select().from(executionWorkspaces);
    expect(persistedExecutionWorkspaces).toHaveLength(0);

    const refreshedIssue = await db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(refreshedIssue?.executionWorkspaceId ?? null).toBeNull();
  }, 20_000);
});
