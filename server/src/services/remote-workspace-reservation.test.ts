import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environments,
  executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import { reserveRemoteWorkspace } from "./remote-workspaces.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("remote workspace reservation authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paperclip-remote-reservation-"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-remote-reservation-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function fixture(mode = "isolated_workspace") {
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("DATABASE_URL", database.connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    const [company] = await db.insert(companies).values({ name: "Reservation proof", issuePrefix: `R${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", adapterType: "paperclip_runner" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Source project" }).returning();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: company.id, projectId: project.id,
      name: "Task files", sourceType: "empty" }).returning();
    const [environment] = await db.insert(environments).values({ name: `Reservation ${randomUUID()}`, driver: "sandbox", config: {} }).returning();
    const [parent] = await db.insert(issues).values({ companyId: company.id, projectId: project.id,
      projectWorkspaceId: source.id, title: "Coordinator", status: "done", assigneeAgentId: agent.id }).returning();
    const snapshotId = randomUUID();
    const authority = { schema: "paperclip.remote-workspace.v1" as const, epoch: 3, snapshotId,
      source: { kind: "empty" as const }, location: null, writerRunId: null, dirty: false };
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: company.id, sourceIssueId: parent.id,
      projectId: project.id, projectWorkspaceId: source.id, name: "Coordinator files", mode,
      strategyType: "project_primary", providerType: "cloud_sandbox", cwd: `/workspaces/${randomUUID()}`,
      metadata: { remoteWorkspace: authority } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode } }).where(eq(issues.id, parent.id));
    const child = await issueService(db).create(company.id, { parentId: parent.id, title: "Continue the saved work", assigneeAgentId: agent.id });
    expect(child.executionWorkspaceId).toBe(workspace.id);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      issueId: child.id, status: "running", runtimeMode: "legacy" }).returning();
    const storage = { ...createStorageService(createLocalDiskStorageProvider(join(home, company.id))), provider: "s3" as const };
    const input = { db, storage, companyId: company.id, issueId: child.id, runId: run.id, agentId: agent.id,
      environmentId: environment.id, projectId: project.id, projectWorkspaceId: source.id,
      existingWorkspaceId: workspace.id, source: authority.source };
    const [boundWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
    return { input, parent, child, workspace: boundWorkspace!, authority, run, agent, company };
  }
  const current = async (id: string) => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!;

  it.each(["isolated_workspace", "operator_branch", "shared_workspace"])("reserves an inherited %s using the persisted task binding", async mode => {
    const f = await fixture(mode);
    const reserved = await reserveRemoteWorkspace(f.input);
    expect(reserved.id).toBe(f.workspace.id);
    expect(reserved.sourceIssueId).toBe(f.parent.id);
    expect(readRemoteWorkspaceAuthority(reserved.metadata)).toEqual({ ...f.authority, epoch: 4, writerRunId: f.run.id });
    const replay = await reserveRemoteWorkspace(f.input);
    expect(readRemoteWorkspaceAuthority(replay.metadata)).toEqual(readRemoteWorkspaceAuthority(reserved.metadata));
  });

  it("rejects a workspace that is not bound to the requesting task", async () => {
    const f = await fixture();
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.child.id));
    await expect(reserveRemoteWorkspace(f.input)).rejects.toThrow("Task workspace binding is unavailable");
    expect(await current(f.workspace.id)).toEqual(f.workspace);
  });

  it("keeps the original task's privacy boundary on an inherited workspace", async () => {
    const f = await fixture();
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: f.parent.id,
      assigneeAgentId: null }).where(eq(issues.id, f.parent.id));
    await expect(reserveRemoteWorkspace(f.input)).rejects.toMatchObject({ status: 403 });
    expect(await current(f.workspace.id)).toEqual(f.workspace);
  });

  it("keeps a live writer fenced until it releases the inherited workspace", async () => {
    const f = await fixture();
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      issueId: f.parent.id, status: "running" }).returning();
    const held = { ...f.authority, writerRunId: writer.id, dirty: true };
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: held } }).where(eq(executionWorkspaces.id, f.workspace.id));
    await expect(reserveRemoteWorkspace(f.input)).rejects.toThrow("unfinished writer");
    expect(readRemoteWorkspaceAuthority((await current(f.workspace.id)).metadata)).toEqual(held);
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: f.authority } }).where(eq(executionWorkspaces.id, f.workspace.id));
    await expect(reserveRemoteWorkspace(f.input)).resolves.toMatchObject({ id: f.workspace.id });
  });

  it("grants only one writer when two bound children reserve concurrently", async () => {
    const f = await fixture();
    const sibling = await issueService(db).create(f.company.id, { parentId: f.parent.id,
      title: "Another child", assigneeAgentId: f.agent.id });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      issueId: sibling.id, status: "running" }).returning();
    const inputs = [f.input, { ...f.input, issueId: sibling.id, runId: run.id }];
    const results = await Promise.allSettled(inputs.map(reserveRemoteWorkspace));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ details: { code: "remote_workspace_writer_pending" } });
    const winner = inputs[results.findIndex(result => result.status === "fulfilled")];
    expect(readRemoteWorkspaceAuthority((await current(f.workspace.id)).metadata)).toEqual({
      ...f.authority, epoch: 4, writerRunId: winner.runId,
    });
  });

  it.each(["archived", "cleanup_failed"])("keeps a %s workspace closed", async status => {
    const f = await fixture();
    await db.update(executionWorkspaces).set({ status }).where(eq(executionWorkspaces.id, f.workspace.id));
    await expect(reserveRemoteWorkspace(f.input)).rejects.toThrow("Workspace ownership changed.");
    expect(readRemoteWorkspaceAuthority((await current(f.workspace.id)).metadata)).toEqual(f.authority);
  });

  it("rejects a foreign company workspace without changing either binding", async () => {
    const f = await fixture(), other = await fixture();
    await expect(reserveRemoteWorkspace({ ...f.input, existingWorkspaceId: other.workspace.id })).rejects.toThrow("remote_workspace_missing");
    expect(await current(f.workspace.id)).toEqual(f.workspace);
    expect(await current(other.workspace.id)).toEqual(other.workspace);
  });
});
