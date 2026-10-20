import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaces, issues,
  projects, projectWorkspaces, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { fileResourceRoutes } from "../routes/file-resources.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("workspace history real process journey", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const exec = promisify(execFileCallback);
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "paperclip-workspace-history-journey-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "false");
    database = await startEmbeddedPostgresTestDatabase("workspace-history-journey");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    heartbeat = heartbeatService(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  it("dispatches a real child process, serves its file, and reuses files despite private source history", async () => {
    const companyId = randomUUID(), userId = randomUUID(), privateUserId = randomUUID(), agentId = randomUUID();
    const projectId = randomUUID(), sourceId = randomUUID(), issueId = randomUUID(), privateIssueId = randomUUID();
    const sourceCwd = path.join(root, "selected-checkout");
    await mkdir(sourceCwd);
    await exec("git", ["init", "--initial-branch=main", sourceCwd]);
    await writeFile(path.join(sourceCwd, "README.md"), "Selected repository\n");
    await exec("git", ["-C", sourceCwd, "add", "."]);
    await exec("git", ["-C", sourceCwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    await db.insert(authUsers).values([userId, privateUserId].map(id => ({ id, name: "Journey user", email: `${id}@example.test`,
      createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companies).values({ id: companyId, name: "Workspace history journey", issuePrefix: "JNY", defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values([userId, privateUserId].map(principalId => ({ companyId,
      principalType: "user" as const, principalId, membershipRole: "member" as const, status: "active" as const })));
    await db.insert(projects).values({ id: projectId, companyId, name: "Selected repository" });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Selected source", cwd: sourceCwd, isPrimary: true });
    const childScript = 'const startedAtUnixMs = Date.now(); const fs = require("node:fs"); fs.appendFileSync("journey-result.txt", process.env.PAPERCLIP_RUN_ID + "\\n"); console.log(JSON.stringify({ written: "journey-result.txt", cwd: process.cwd(), startedAtUnixMs, finishedAtUnixMs: Date.now() })); const release = ".journey-release-" + process.env.PAPERCLIP_RUN_ID; const timer = setInterval(() => { if (fs.existsSync(release)) { fs.unlinkSync(release); clearInterval(timer); } }, 10);';
    await db.insert(agents).values({ id: agentId, companyId, name: "Real process worker", adapterType: "process", status: "idle",
      adapterConfig: { command: process.execPath, args: ["-e", childScript], cwd: sourceCwd, timeoutSec: 20 } });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId,
      membershipRole: "member", status: "active" });
    await db.insert(issues).values({ id: privateIssueId, companyId, title: "Private historical source task",
      description: "PRIVATE_HISTORY_DESCRIPTION", visibility: "private", privacyRootIssueId: privateIssueId,
      responsibleUserId: privateUserId, status: "done" });
    await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: privateIssueId,
      name: "PRIVATE_HISTORY_WORKSPACE", cwd: sourceCwd, mode: "shared_workspace", strategyType: "project_primary" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write a result using selected source", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: userId, projectId, projectWorkspaceId: sourceId,
      executionWorkspaceSettings: { mode: "shared_workspace" }, workspaceSelection: { version: 1, source: "explicit", selection: {
        kind: "configured_source", projectWorkspaceId: sourceId, mode: "shared",
      } } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false };
      next();
    });
    app.use("/api", fileResourceRoutes(db));
    app.use("/api", issueRoutes(db));
    app.use(errorHandler);
    const measurements: Array<{ beforeChildMs: number; childWorkMs: number }> = [];
    const runTask = async () => {
      const requestedAtUnixMs = Date.now();
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
      expect(run).not.toBeNull();
      // Hold the real child until the task is settled, avoiding an automatic
      // continuation for a process adapter that has no task-completion tool call.
      let processCwd: string | null = null;
      await vi.waitFor(async () => {
        const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
        const [workspace] = task.executionWorkspaceId ? await db.select().from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, task.executionWorkspaceId)) : [];
        processCwd = workspace?.cwd ?? null;
        expect(processCwd).not.toBeNull();
        expect(await readFile(path.join(processCwd!, "journey-result.txt"), "utf8")).toContain(run!.id);
      }, { timeout: 25_000 });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      await writeFile(path.join(processCwd!, `.journey-release-${run!.id}`), "settled");
      await vi.waitFor(async () => {
        const completed = await heartbeat.getRun(run!.id);
        expect(completed).toMatchObject({ status: "succeeded", error: null });
      }, { timeout: 25_000 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const completed = await heartbeat.getRun(run!.id);
      expect(completed?.resultJson).toMatchObject({ stdout: expect.stringContaining("journey-result.txt") });
      const child = JSON.parse(String(completed!.resultJson!.stdout).trim());
      measurements.push({ beforeChildMs: child.startedAtUnixMs - requestedAtUnixMs,
        childWorkMs: child.finishedAtUnixMs - child.startedAtUnixMs });
      return run!;
    };
    const first = await runTask();
    const [bound] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
    expect(workspace.cwd).toBe(sourceCwd);
    expect(workspace.metadata?.isolatedRemoteSource).toBeUndefined();
    expect(await readFile(path.join(workspace.cwd!, "journey-result.txt"), "utf8")).toBe(`${first.id}\n`);
    const content = await request(app).get(`/api/issues/${issueId}/file-resources/content`).query({ path: "journey-result.txt", workspace: "execution" });
    expect(content.status).toBe(200);
    expect(JSON.stringify(content.body)).toContain(first.id);
    const denied = await request(app).get(`/api/issues/${privateIssueId}`);
    expect([403, 404]).toContain(denied.status);
    expect(JSON.stringify(denied.body)).not.toContain("PRIVATE_HISTORY_DESCRIPTION");
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    const second = await runTask();
    const [reused] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(reused.executionWorkspaceId).toBe(workspace.id);
    expect(await readFile(path.join(workspace.cwd!, "journey-result.txt"), "utf8")).toBe(`${first.id}\n${second.id}\n`);
    const secondContent = await request(app).get(`/api/issues/${issueId}/file-resources/content`).query({ path: "journey-result.txt", workspace: "execution" });
    expect(secondContent.status).toBe(200);
    expect(JSON.stringify(secondContent.body)).toContain(second.id);
    console.info("workspace-history-journey timings", JSON.stringify(measurements));
    const evidencePath = process.env.PAPERCLIP_JOURNEY_EVIDENCE_PATH;
    if (evidencePath) await writeFile(evidencePath, JSON.stringify({
      result: "passed", processAdapter: "real", workspaceReused: true, privateTaskDenied: true, measurements,
    }, null, 2));
  }, 60_000);
});
