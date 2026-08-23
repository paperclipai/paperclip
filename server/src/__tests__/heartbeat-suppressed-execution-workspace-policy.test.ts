import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
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
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Suppressed policy test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
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
    `Skipping embedded Postgres suppressed execution workspace policy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function readGit(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function createGitRepo() {
  // realpath: on macOS os.tmpdir() is a symlink (/tmp -> /private/tmp) and the runtime persists
  // resolved worktree paths, so unresolved fixtures never match.
  const repoRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-suppressed-policy-repo-")));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "suppressed policy\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

function readAdapterWorkspace(input: unknown) {
  const context = (input as { context?: Record<string, unknown> }).context ?? {};
  const workspace = (context.paperclipWorkspace ?? {}) as Record<string, unknown>;
  return {
    cwd: typeof workspace.cwd === "string" ? workspace.cwd : null,
    strategy: typeof workspace.strategy === "string" ? workspace.strategy : null,
    mode: typeof workspace.mode === "string" ? workspace.mode : null,
    branchName: typeof workspace.branchName === "string" ? workspace.branchName : null,
  };
}

/**
 * Seed the exact shape from the upstream report: a project whose execution workspace policy asks
 * for isolated git worktrees, an agent that already carries a fixed `adapterConfig.cwd` from an
 * unrelated earlier task, and `issueCount` issues in that project assigned to that agent. The
 * report dispatches two or more issues, which is what makes a shared checkout observable.
 */
async function seedPolicyProjectRun(input: {
  db: Db;
  repoRoot: string;
  agentFixedCwd: string;
  isolatedWorkspacesEnabled: boolean;
  issueCount?: number;
}) {
  const { db } = input;
  const issueCount = input.issueCount ?? 1;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const issueIds = Array.from({ length: issueCount }, () => randomUUID());
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  await instanceSettingsService(db).updateExperimental({
    enableIsolatedWorkspaces: input.isolatedWorkspacesEnabled,
  });
  await db.insert(companies).values({
    id: companyId,
    name: "Acme",
    issuePrefix,
    status: "active",
    defaultResponsibleUserId: "responsible-user",
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Isolated by policy",
    status: "active",
    executionWorkspacePolicy: {
      enabled: true,
      defaultMode: "isolated_workspace",
      allowIssueOverride: true,
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: "HEAD",
        branchTemplate: "{{issue.identifier}}-worktree",
      },
    },
  });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary",
    cwd: input.repoRoot,
    isPrimary: true,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "CodexCoder",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    // The stale per-agent cwd the upstream report blames for the bypass.
    adapterConfig: { cwd: input.agentFixedCwd },
    runtimeConfig: {
      heartbeat: {
        wakeOnDemand: true,
        maxConcurrentRuns: 1,
      },
    },
    permissions: {},
  });
  await db.insert(issues).values(
    issueIds.map((id, index) => ({
      id,
      companyId,
      projectId,
      projectWorkspaceId,
      title: `Policy-governed task ${index + 1}`,
      status: "todo" as const,
      workMode: "standard" as const,
      priority: "medium" as const,
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: index + 1,
      identifier: `${issuePrefix}-${index + 1}`,
    })),
  );

  return { companyId, projectId, agentId, issueId: issueIds[0]!, issueIds };
}

describeEmbeddedPostgres("project execution workspace policy suppressed by the instance flag", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-suppressed-policy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Suppressed policy test run.",
      provider: "test",
      model: "test-model",
    }));
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  it("names the discarded policy on the run instead of silently sharing one checkout", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const agentFixedCwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-agent-fixed-cwd-")));
    tempRoots.push(agentFixedCwd);

    const { agentId, issueId } = await seedPolicyProjectRun({
      db,
      repoRoot,
      agentFixedCwd,
      isolatedWorkspacesEnabled: false,
    });

    let adapterWorkspace: ReturnType<typeof readAdapterWorkspace> | null = null;
    adapterExecute.mockImplementationOnce(async (adapterInput: unknown) => {
      adapterWorkspace = readAdapterWorkspace(adapterInput);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Suppressed policy test run.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    expect(run).not.toBeNull();
    const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(finishedRun?.status).toBe("succeeded");

    // The policy asked for an isolated git worktree and did not get one: the run landed straight
    // on the shared project checkout, which is what stacks several tasks' diffs on one branch.
    expect(adapterWorkspace).toMatchObject({
      cwd: repoRoot,
      strategy: "project_primary",
      branchName: null,
    });
    const worktreeList = await readGit(repoRoot, ["worktree", "list"]);
    expect(worktreeList.split("\n")).toHaveLength(1);

    // ...but the run now says so out loud instead of leaving the operator to infer it from a
    // checkout that never got its worktrees.
    expect(finishedRun?.stdoutExcerpt ?? "").toContain(
      "[paperclip] This project configures an execution workspace policy",
    );
    expect(finishedRun?.stdoutExcerpt ?? "").toContain('default mode "isolated_workspace"');
    expect(finishedRun?.stdoutExcerpt ?? "").toContain('workspace strategy "git_worktree"');
    expect(finishedRun?.stdoutExcerpt ?? "").toContain("Isolated Workspaces");
  }, 60_000);

  // The counterpart to the case above, and the one that decides where the bug actually lives. The
  // upstream report blames the agent's fixed `adapterConfig.cwd` for overriding the policy. With the
  // instance flag on, the very same seed — same stale agent cwd, same project policy — puts every
  // issue in its own worktree, so the stale cwd is not what bypasses the policy. The instance flag
  // is, which is why the fix names that discard rather than changing workspace resolution.
  it("gives each issue its own worktree despite the agent's fixed cwd once isolated workspaces are enabled", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const agentFixedCwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-agent-fixed-cwd-")));
    tempRoots.push(agentFixedCwd);

    const { agentId, issueIds } = await seedPolicyProjectRun({
      db,
      repoRoot,
      agentFixedCwd,
      isolatedWorkspacesEnabled: true,
      issueCount: 2,
    });

    const adapterWorkspaces: ReturnType<typeof readAdapterWorkspace>[] = [];
    adapterExecute.mockImplementation(async (adapterInput: unknown) => {
      adapterWorkspaces.push(readAdapterWorkspace(adapterInput));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Suppressed policy test run.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    // The agent caps itself at one concurrent run, so dispatch is sequential — which is also the
    // ordering the report describes, where a later task inherits the earlier task's checkout.
    for (const issueId of issueIds) {
      const run = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
      expect(run).not.toBeNull();
      const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
      expect(finishedRun?.status).toBe("succeeded");
      expect(finishedRun?.stdoutExcerpt ?? "").not.toContain(
        "This project configures an execution workspace policy",
      );
    }

    expect(adapterWorkspaces).toHaveLength(2);
    for (const workspace of adapterWorkspaces) {
      expect(workspace.strategy).toBe("git_worktree");
      // Neither the shared project checkout nor the agent's stale fixed cwd.
      expect(workspace.cwd).not.toBe(repoRoot);
      expect(workspace.cwd).not.toBe(agentFixedCwd);
    }
    expect(adapterWorkspaces[0]!.cwd).not.toBe(adapterWorkspaces[1]!.cwd);

    // The reporter's step 4: `git worktree list` shows one worktree per issue, not one shared
    // checkout. The main checkout is the first line, so two issues means three lines.
    const worktreeList = await readGit(repoRoot, ["worktree", "list"]);
    expect(worktreeList.split("\n")).toHaveLength(3);
  }, 90_000);
});
