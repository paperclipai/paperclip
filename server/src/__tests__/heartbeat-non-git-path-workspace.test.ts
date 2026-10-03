import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
suite("heartbeat project workspace source type", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-non-git-path-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    database = await startEmbeddedPostgresTestDatabase("non-git-path-workspace");
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
  });

  // Resolves the source type from the stored project workspace row, not from a hand-built input.
  it.each([
    { sourceType: "non_git_path", launches: true },
    { sourceType: "local_path", launches: false },
  ] as const)("reads $sourceType from the project workspace row for a folder without .git", async ({ sourceType, launches }) => {
    const companyId = randomUUID(), projectId = randomUUID(), workspaceId = randomUUID();
    const agentId = randomUUID(), issueId = randomUUID();
    const folder = path.join(root, companyId, "notes");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "README.md"), "Plain folder\n");
    await db.insert(companies).values({ id: companyId, name: "Notes", issuePrefix: `N${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Notes", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: workspaceId, companyId, projectId, name: "Notes folder", sourceType, cwd: folder, isPrimary: true,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({
      id: issueId, companyId, projectId, projectWorkspaceId: workspaceId, title: "Tidy the notes", status: "todo", assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId, projectId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect({ status: latest?.status, errorCode: latest?.errorCode }).toEqual({
        status: launches ? "succeeded" : "failed",
        errorCode: launches ? null : "workspace_validation_failed",
      });
    }, { timeout: 15_000 });

    const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
    expect(calls).toHaveLength(launches ? 1 : 0);
    if (launches) {
      expect(calls[0]![0].context.paperclipWorkspace.cwd).toBe(folder);
    } else {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.error).toContain('set the project workspace source type to "non_git_path"');
    }
  }, 25_000);
});
