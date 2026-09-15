import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, projects, projectWorkspaces } from "@paperclipai/db";
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
