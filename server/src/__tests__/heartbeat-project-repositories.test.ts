import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { runLocalGit, setExpensiveWorkspaceGitExecutor } from "@paperclipai/adapter-utils/git-workspace-sync";
import { WorkspaceGitScanError } from "../services/workspace-git-operation-scheduler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("task project repository provisioning", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-project-repos-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "false");
    database = await startEmbeddedPostgresTestDatabase("project-repositories");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    execute.mockImplementation(async (input) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.context.issueId));
      return { exitCode: 0, signal: null, timedOut: false };
    });
  }, 30_000);
  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    setExpensiveWorkspaceGitExecutor(null);
  });

  it.each([
    { code: "workspace_git_scan_timeout", scenario: "temporary", retryable: true },
    { code: "workspace_git_scan_saturated", scenario: "temporary", retryable: true },
    { code: "workspace_git_scan_timeout", scenario: "exhausted", retryable: true },
    { code: "workspace_git_scan_timeout", scenario: "paused", retryable: true },
    { code: "workspace_git_scan_output_limit", scenario: "permanent", retryable: false },
    { code: "workspace_git_scan_cancelled", scenario: "cancelled", retryable: false },
    { code: "workspace_git_scan_failed", scenario: "permanent", retryable: false },
  ] as const)("handles $scenario $code during local-source preparation", async ({ code, scenario, retryable }) => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const source = path.join(root, companyId, "source");
    await mkdir(source, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "ignore" });
    git("init", "-b", "main");
    await writeFile(path.join(source, "README.md"), "committed");
    await writeFile(path.join(source, ".gitignore"), "private.secret\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
    await writeFile(path.join(source, "README.md"), "preserved dirty work");
    await writeFile(path.join(source, "private.secret"), "must not copy");
    await db.insert(companies).values({ id: companyId, name: "Bootstrap recovery", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Local source", status: "in_progress" });
    await db.insert(projectWorkspaces).values([
      { id: randomUUID(), companyId, projectId, name: "Anchor", sourceType: "local_path", cwd: source, isPrimary: true, createdAt: new Date(Date.now() - 1000) },
      { id: randomUUID(), companyId, projectId, name: "Source copy", sourceType: "git_repo", repoUrl: pathToFileURL(source).href, cwd: source, isPrimary: false },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Recover startup and use existing work", status: "todo", assigneeAgentId: agentId });
    let inject = true;
    const canonicalSource = await realpath(source);
    setExpensiveWorkspaceGitExecutor(async (input) => {
      if (inject && (input.localDir === source || input.localDir === canonicalSource) && input.operation === "adapter_sync.ignored_files") {
        inject = scenario === "exhausted";
        throw new WorkspaceGitScanError(code, "Injected temporary scan failure");
      }
      return runLocalGit(input.localDir, [...input.args]);
    });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
    await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.errorCode).toBe(code), { timeout: 15_000 });
    expect(execute.mock.calls.filter(([input]) => input.runId === run!.id)).toHaveLength(0);
    await heartbeat.drainActiveRunExecutions();
    if (!retryable) {
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).toBe("blocked");
      return;
    }
    let retry: typeof heartbeatRuns.$inferSelect;
    await vi.waitFor(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
      expect(rows).toHaveLength(1);
      retry = rows[0]!;
      expect(retry.status).toBe("scheduled_retry");
      expect(retry.scheduledRetryAttempt).toBe(1);
    });
    // Recreate the service as on restart; durable scheduling must not need the old closure.
    await heartbeat.drainActiveRunExecutions();
    heartbeat = heartbeatService(db);
    if (scenario === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, retry!.id));
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();
    if (scenario === "paused") {
      expect((await heartbeat.getRun(retry!.id))?.status).toBe("cancelled");
      expect(execute.mock.calls.filter(([input]) => input.agent.id === agentId)).toHaveLength(0);
      return;
    }
    if (scenario === "exhausted") {
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(retry!.id))?.errorCode).toBe(code);
      const [last] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry!.id));
      expect(last).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 2 });
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, last!.id));
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(last!.id))?.errorCode).toBe(code);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(3);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
      expect(execute.mock.calls.filter(([input]) => input.agent.id === agentId)).toHaveLength(0);
      return;
    }
    await vi.waitFor(async () => expect((await heartbeat.getRun(retry!.id))?.status).toBe("succeeded"), { timeout: 15_000 });
    expect(execute.mock.calls.filter(([input]) => input.runId === retry!.id)).toHaveLength(1);
    const [task] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    expect(task).toMatchObject({ status: "done", assigneeAgentId: agentId });
    const copies = (execute.mock.calls.find(([input]) => input.runId === retry!.id)![0].context.paperclipWorkspaces as Array<{ cwd: string }>).filter((hint) => hint.cwd.includes(".paperclip-repositories"));
    expect(copies.length).toBeGreaterThan(0);
    expect(await readFile(path.join(copies[0]!.cwd, "README.md"), "utf8")).toBe("preserved dirty work");
    await expect(readFile(path.join(copies[0]!.cwd, "private.secret"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(source, "README.md"), "utf8")).toBe("preserved dirty work");
  }, 40_000);

  it.each([1, 2])("gives a task all %i repositories without any configured local folders", async (count) => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const repositoryRows = [];
    for (let index = 0; index < count; index++) {
      const source = path.join(root, companyId, `source-${index}`);
      await mkdir(source, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "ignore" });
      git("init", "-b", "main");
      await writeFile(path.join(source, "README.md"), `repository ${index}`);
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
      repositoryRows.push({ id: randomUUID(), companyId, projectId, name: `Repo ${index}`, sourceType: "git_repo", repoUrl: pathToFileURL(source).href, cwd: null, isPrimary: index === 0 });
    }
    await db.insert(companies).values({ id: companyId, name: "Repo test", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Multi-repo", status: "in_progress" });
    await db.insert(projectWorkspaces).values(repositoryRows);
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Use project repositories", status: "todo", assigneeAgentId: agentId });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect({ status: latest?.status, error: latest?.error }).toEqual({ status: "succeeded", error: null });
    }, { timeout: 15_000 });
    const input = execute.mock.calls.find(([ctx]) => ctx.runId === run!.id)![0];
    const hints = input.context.paperclipWorkspaces as Array<{ workspaceId: string; cwd: string }>;
    for (let index = 0; index < count; index++) {
      const hint = hints.find((entry) => entry.workspaceId === repositoryRows[index]!.id);
      expect(hint?.cwd).toBeTruthy();
      expect(await readFile(path.join(hint!.cwd, "README.md"), "utf8")).toBe(`repository ${index}`);
      expect(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: hint!.cwd, encoding: "utf8" }).trim()).toBe(await realpath(hint!.cwd));
    }
  }, 25_000);
});
