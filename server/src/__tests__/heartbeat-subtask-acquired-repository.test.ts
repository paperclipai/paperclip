import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, executionWorkspaceRepositories, executionWorkspaces,
  heartbeatRuns, issues, projectWorkspaces, projects,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { taskRepositoryRelativePath } from "../services/execution-workspace-repositories.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const exec = promisify(execFileCallback);
const REPO_URL = "https://github.com/team/source";

describe.skipIf(!recoveryPostgresSupport.supported)("subtask in a project that acquires task repositories", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;
  let previousPath: string | undefined;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "subtask-acquired-repository-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "01234567890123456789012345678901");
    temporary = await startRecoveryPostgres("subtask-acquired-repository-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    heartbeat = heartbeatService(db);
    // Clone the public GitHub URL from a local fixture repository instead of the network.
    const realGit = (await exec("which", ["git"])).stdout.trim();
    const source = path.join(root, "source"), bin = path.join(root, "bin");
    await Promise.all([mkdir(source), mkdir(bin)]);
    const git = (...args: string[]) => exec(realGit, ["-C", source, ...args]);
    await git("init", "--initial-branch=main");
    await writeFile(path.join(source, "source.txt"), "project base\n");
    await git("add", ".");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base");
    await writeFile(path.join(bin, "git"), `#!${process.execPath}\n` +
      `const { spawnSync } = require('node:child_process'); const args = process.argv.slice(2);\n` +
      `const remote = args.includes('clone') ? args.at(-2) : null;\n` +
      `if (remote && remote !== ${JSON.stringify(REPO_URL)}) process.exit(97);\n` +
      `if (remote) args[args.length - 2] = ${JSON.stringify(source)};\n` +
      `const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\n` +
      `if (result.status) process.exit(result.status);\n` +
      `if (remote) process.exit(spawnSync(${JSON.stringify(realGit)}, ['-C', args.at(-1), 'remote', 'set-url', 'origin', ${JSON.stringify(REPO_URL)}], { stdio: 'inherit' }).status ?? 98);\n` +
      `process.exit(result.status ?? 99);\n`, { mode: 0o755 });
    previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    execute.mockReset();
  });

  afterAll(async () => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await db?.$client.end();
    await temporary?.cleanup();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(["new", "older-release"] as const)("gives a %s child its own freshly acquired repository instead of the parent's checkout", async (shape) => {
    const companyId = randomUUID(), userId = randomUUID(), agentId = randomUUID(), projectId = randomUUID();
    const parentId = randomUUID(), parentWorkspaceId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Acquired repositories", issuePrefix: `A${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", membershipRole: "owner", status: "active" });
    // A project with no project workspace: tasks acquire repositories into their own task files.
    await db.insert(projects).values({ id: projectId, companyId, name: "Repository-free project", status: "in_progress" });
    expect(await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.projectId, projectId))).toEqual([]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } }, permissions: {} });

    // The parent's realized task files, with an acquired repository holding unmerged work.
    const parentCwd = path.join(root, `parent-task-${parentId}`);
    const relativePath = taskRepositoryRelativePath(REPO_URL);
    const parentCheckout = path.join(parentCwd, relativePath);
    await mkdir(path.dirname(parentCheckout), { recursive: true });
    await exec("git", ["clone", REPO_URL, parentCheckout]);
    const pinnedCommit = (await exec("git", ["-C", parentCheckout, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(parentCheckout, "source.txt"), "parent unmerged change\n");
    await db.insert(issues).values({ id: parentId, companyId, projectId, title: "Parent", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId });
    await db.insert(executionWorkspaces).values({ id: parentWorkspaceId, companyId, projectId, sourceIssueId: parentId,
      name: "Parent task files", cwd: parentCwd, mode: "isolated_workspace", strategyType: "project_primary",
      providerType: "local_fs", metadata: { source: "task_session" } });
    await db.update(issues).set({ executionWorkspaceId: parentWorkspaceId, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" } }).where(eq(issues.id, parentId));
    await db.insert(executionWorkspaceRepositories).values({ companyId, executionWorkspaceId: parentWorkspaceId,
      requestedByIssueId: parentId, repoUrl: REPO_URL, repositoryIdentity: REPO_URL, relativePath, requestedRef: "HEAD",
      pinnedCommit, branchName: "main", state: "ready", requestKey: "parent-repository", requestKeys: ["parent-repository"] });

    const child = shape === "new"
      ? await issueService(db).create(companyId, { parentId, title: "Child", status: "todo",
          assigneeAgentId: agentId, actorResponsibleUserId: userId })
      // An older release bound every child to its parent's realized workspace.
      : (await db.insert(issues).values({ companyId, projectId, parentId, title: "Child", status: "todo",
          assigneeAgentId: agentId, responsibleUserId: userId, executionWorkspaceId: parentWorkspaceId,
          executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: "isolated_workspace" } }).returning())[0]!;
    if (shape === "new") expect(child.executionWorkspaceId).toBeNull();

    let childCwd: string | null = null;
    execute.mockImplementation(async (input: { context: { paperclipWorkspace?: { cwd?: string } } }) => {
      childCwd = input.context.paperclipWorkspace?.cwd ?? null;
      return { exitCode: 0, signal: null, timedOut: false };
    });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: child.id } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      expect((await heartbeat.getRun(run!.id))?.status).toMatch(/^(succeeded|failed|cancelled|timed_out)$/);
    }, { timeout: 30_000 });
    const finished = await heartbeat.getRun(run!.id);
    expect({ status: finished?.status, error: finished?.error }).toMatchObject({ status: "succeeded" });

    // The child ran in its own task files with its own fresh copy of the repository.
    expect(childCwd).toBeTruthy();
    expect(childCwd).not.toBe(parentCwd);
    expect(await readFile(path.join(childCwd!, relativePath, "source.txt"), "utf8")).toBe("project base\n");
    // The parent's checkout and its unmerged change are untouched.
    expect(await readFile(path.join(parentCheckout, "source.txt"), "utf8")).toBe("parent unmerged change\n");
    const [childRow] = await db.select().from(issues).where(eq(issues.id, child.id));
    expect(childRow.executionWorkspaceId).not.toBe(parentWorkspaceId);
    const childRepositories = await db.select().from(executionWorkspaceRepositories)
      .where(and(eq(executionWorkspaceRepositories.companyId, companyId), eq(executionWorkspaceRepositories.executionWorkspaceId, childRow.executionWorkspaceId!)));
    expect(childRepositories).toEqual([expect.objectContaining({ repositoryIdentity: REPO_URL, requestedByIssueId: child.id,
      state: "ready", relativePath })]);
    expect(await lstat(path.join(childCwd!, relativePath, ".git"))).toBeTruthy();
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
  }, 60_000);
});
