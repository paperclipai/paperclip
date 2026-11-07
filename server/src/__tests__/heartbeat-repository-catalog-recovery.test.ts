import express from "express";
import request from "supertest";
import { taskWorkspaceRoutes } from "../routes/task-workspaces.js";
import { errorHandler } from "../middleware/error-handler.js";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, connectionGrants, createDb,
  executionWorkspaceRepositories, executionWorkspaces, heartbeatRuns, issues, toolApplications, toolConnections,
} from "@paperclipai/db";
import { RepositoryCatalogUnavailableError } from "../services/repository-catalog-unavailable-error.js";
import { heartbeatService } from "../services/heartbeat.js";
import { taskRepositoryRelativePath } from "../services/execution-workspace-repositories.js";
import { writeConnectionCredential } from "../services/connection-credentials.js";
import { syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import { toolAccessService } from "../services/tool-access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

describe.skipIf(!recoveryPostgresSupport.supported)("repository catalog bootstrap recovery", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "repository-catalog-recovery-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "01234567890123456789012345678901");
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    temporary = await startRecoveryPostgres("repository-catalog-recovery-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    vi.useRealTimers();
    vi.restoreAllMocks();
    execute.mockReset();
  });

  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function fixture(status: number, genuineDenial = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const workspaceId = randomUUID(), repositoryId = randomUUID(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Repository owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Repository retry", issuePrefix: `C${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", membershipRole: "owner", status: "active" });
    const cwd = path.join(root, workspaceId), repoUrl = "https://github.com/catalog-fixture/repository";
    const relativePath = taskRepositoryRelativePath(repoUrl), checkout = path.join(cwd, relativePath);
    await mkdir(checkout, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--initial-branch=main");
    git("config", "user.name", "Catalog fixture");
    git("config", "user.email", "catalog@example.test");
    git("remote", "add", "origin", repoUrl);
    await writeFile(path.join(checkout, "saved.txt"), "retained repository work\n");
    git("add", "saved.txt");
    git("commit", "-m", "Saved fixture");
    const pinnedCommit = git("rev-parse", "HEAD");
    await writeFile(path.join(checkout, ".git", "paperclip-workspace-owner.json"), JSON.stringify({ version: 1, repositoryId, pinnedCommit }));
    await db.insert(agents).values({ id: agentId, companyId, name: "Catalog worker", status: "idle", adapterType: "codex_local",
      adapterConfig: { cwd }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue retained repository", status: "todo", assigneeAgentId: agentId,
      executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: "shared_workspace" },
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "existing", workspaceId } } });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, name: "Retained task files", cwd,
      mode: "shared_workspace", strategyType: "task_directory" });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    await db.insert(executionWorkspaceRepositories).values({ id: repositoryId, companyId, executionWorkspaceId: workspaceId,
      requestedByIssueId: issueId, repoUrl, repositoryIdentity: repoUrl, catalogRepositoryId: "201", relativePath,
      requestedRef: "HEAD", pinnedCommit, branchName: "main", state: "ready", requestKey: "saved-repository", requestKeys: ["saved-repository"] });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Catalog GitHub", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Catalog GitHub", uid: randomUUID(),
      enabled: true, status: "active", transport: "mcp_remote", authKind: "api_key", credentialPolicy: "per_user", config: { sourceTemplateKey: "github" } }).returning();
    const { secret } = await writeConnectionCredential(db, { companyId, connectionName: connection.name, configPath: "credentials.authorization",
      label: "Fixture credential", value: "synthetic-catalog-token", ownerUserId: userId, actor: { userId } });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection.id, kind: "user", subjectUserId: userId,
      credentialSecretRefs: [{ configPath: "credentials.authorization", secretId: secret.id, versionSelector: "latest" }] }).returning();
    await syncConnectionCredentialBindings(db, connection);
    expect(await toolAccessService(db).githubReadHeaders(companyId, connection.id, userId)).toEqual({ Authorization: "Bearer synthetic-catalog-token" });
    let available = false;
    const retryAt = new Date(Math.ceil((Date.now() + 1000) / 1000) * 1000);
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
      expect(new URL(String(url)).hostname).toBe("api.github.com");
      expect(new URL(String(url)).pathname).toBe("/user/repos");
      return available ? Response.json([{ id: 201, full_name: "catalog-fixture/repository", private: true }])
        : Response.json({ message: "synthetic provider body must not become an access denial" }, { status,
          headers: genuineDenial ? {} : status === 403 ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(retryAt.getTime() / 1000) } : { "retry-after": "1" } });
    });
    execute.mockImplementation(async () => {
      expect(available).toBe(true);
      expect(await readFile(path.join(checkout, "saved.txt"), "utf8")).toBe("retained repository work\n");
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    return { companyId, agentId, issueId, workspaceId, repositoryId, userId, applicationId: application.id, grant, provider, retryAt, recover: () => { available = true; } };
  }

  it("keeps the direct repository request HTTP contract outside bootstrap recovery", async () => {
    const f = await fixture(503);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: f.userId, companyIds: [f.companyId],
        memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    app.use("/api", taskWorkspaceRoutes(db));
    app.use(errorHandler);
    const response = await request(app).post(`/api/issues/${f.issueId}/workspace/repositories`)
      .send({ repository: { kind: "catalog", id: "201" }, requestKey: "direct-repository-request" });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Repository access is no longer available; refresh the repository catalog");
    expect(f.provider).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(0);
  });

  it.each([true, false])("accepts a partial catalog only when the required repository is present (%s)", async present => {
    const f = await fixture(503);
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: f.applicationId,
      name: "Healthy GitHub", uid: randomUUID(), enabled: true, status: "active", transport: "mcp_remote",
      authKind: "api_key", credentialPolicy: "per_user", config: { sourceTemplateKey: "github" } }).returning();
    const { secret } = await writeConnectionCredential(db, { companyId: f.companyId, connectionName: connection.name,
      configPath: "credentials.authorization", label: "Healthy fixture", value: "synthetic-healthy-token",
      ownerUserId: f.userId, actor: { userId: f.userId } });
    await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: connection.id, kind: "user",
      subjectUserId: f.userId, credentialSecretRefs: [{ configPath: "credentials.authorization", secretId: secret.id, versionSelector: "latest" }] });
    await syncConnectionCredentialBindings(db, connection);
    f.provider.mockImplementation(async (url, init) => {
      expect(new URL(String(url)).hostname).toBe("api.github.com");
      if (new Headers(init?.headers).get("authorization") === "Bearer synthetic-healthy-token") {
        return Response.json([{ id: present ? 201 : 202, full_name: present ? "catalog-fixture/repository" : "catalog-fixture/other", private: true }]);
      }
      return new Response(null, { status: 503 });
    });
    const discovered = toolAccessService(db).listProjectRepositories(f.companyId, f.userId, false, { requiredRepositoryIds: ["201"] });
    if (present) expect(await discovered).toMatchObject({ failedConnectionCount: 1, repositories: [expect.objectContaining({ id: "201" })] });
    else await expect(discovered).rejects.toMatchObject({ code: "repository_catalog_unavailable" });
    expect(f.provider).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not retry a genuine catalog permission denial or start provider work", async () => {
    const f = await fixture(403, true);
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual",
      contextSnapshot: { issueId: f.issueId } });
    await vi.waitFor(async () => { expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "failed", errorCode: "setup_failed" }); }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(f.provider).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id))).toEqual([f.grant]);
  });

  it("does not classify a provider-started error as catalog bootstrap recovery", async () => {
    const f = await fixture(503);
    f.recover();
    execute.mockRejectedValue(new RepositoryCatalogUnavailableError());
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: f.issueId } });
    await vi.waitFor(async () => { expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "failed", errorCode: "adapter_failed" }); }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(execute).toHaveBeenCalledTimes(1);
    const failed = await heartbeat.getRun(run!.id);
    expect(failed!.resultJson?.executionRecovery).not.toEqual(expect.objectContaining({ kind: "bootstrap", providerWorkStarted: false }));
    expect(failed!.resultJson?.retryNotBefore).toBeUndefined();
    for (const retry of await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))) {
      await heartbeat.cancelRun(retry.id, "Fixture cleanup", { expectedStatus: "scheduled_retry" });
    }
  });

  it("preserves an operator Stop before the automatic successor becomes due", async () => {
    const f = await fixture(503);
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: f.issueId } });
    await vi.waitFor(async () => { expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "failed" }); }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(successor).toBeDefined();
    await heartbeat.cancelRun(successor.id, "Operator stopped retry", { expectedStatus: "scheduled_retry",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: f.grant.subjectUserId } });
    f.recover();
    await heartbeat.promoteDueScheduledRetries(new Date(successor.scheduledRetryAt!.getTime() + 1));
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    expect(await heartbeat.getRun(successor.id)).toMatchObject({ status: "cancelled" });
    expect(execute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, successor.id))).toHaveLength(0);
  });

  it.each([403, 503])("retries a real HTTP%s catalog refusal before provider work and continues only after fresh discovery", async status => {
    const f = await fixture(status);
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual",
      contextSnapshot: { issueId: f.issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => { expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "failed" }); }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(f.provider).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot?.codexTransientFallbackMode).toBeUndefined();
    expect(successors[0].scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(f.retryAt.getTime());
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id))).toEqual([f.grant]);
    f.recover();
    const due = new Date(successors[0].scheduledRetryAt!.getTime() + 1);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, due.getTime() - Date.now())));
    await heartbeat.promoteDueScheduledRetries(due);
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    await vi.waitFor(async () => { expect(await heartbeat.getRun(successors[0].id)).toMatchObject({ status: "succeeded" }); }, { timeout: 15_000 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "done", executionWorkspaceId: f.workspaceId });
  }, 60_000);
});
