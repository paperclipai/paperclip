import { randomUUID } from "node:crypto";
import { agents, authUsers, companies, createDb, executionWorkspaces, heartbeatRuns, issueComments, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { buildProjectMentionHref } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { toExecutionWorkspace } from "../execution-workspaces.js";
import { resolveRemoteWorkspaceSource } from "./remote-workspace-source.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("remote referenced project sources", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("remote-project-reference-");
    db = createDb(database.connectionString);
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "true");
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", "true");
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); });

  async function fixture(repository: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const projectId = randomUUID(), userId = `fixture-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Project reference owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Referenced project fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", status: "running", adapterType: "paperclip_runner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Delegate work here" });
    if (repository) await db.insert(projectWorkspaces).values({ companyId, projectId,
      name: "Repository", sourceType: "git", repoUrl: "https://example.test/team/repository.git" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat with lead", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "active", status: "in_progress" });
    await db.insert(issueComments).values({ companyId, issueId, authorUserId: userId,
      body: `Create the teammate's task in [@Delegate work here](${buildProjectMentionHref(projectId)}).` });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId,
      nativeIssueId: issueId, runtimeMode: "native", status: "running" });
    return { companyId, agentId, issueId, runId, projectId };
  }

  it.each(["true", "false"])("keeps a metadata-only project mention without a folder when the remote-source flag is %s", async (remoteEnabled) => {
    const f = await fixture(false);
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", remoteEnabled);
    try {
      const result = await resolveRemoteWorkspaceSource(db, { ...f, responsibleUserId: null,
        projectId: null, projectWorkspaceId: null, taskDirectory: true });
      expect(result).toMatchObject({ authority: "remote", source: { kind: "empty" }, projectId: null,
        projectWorkspaceId: null, referencedProjectFailures: [{ projectId: f.projectId, reason: "resolution" }] });
      expect(result.authority === "remote" && result.source.repositories).toBeUndefined();
      expect(result.authority === "remote" && result.warnings?.length).toBe(1);
      expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId))).toEqual([]);
    } finally {
      vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", "true");
    }
  });

  it("still rejects an actual repository reference before any workspace is created", async () => {
    const f = await fixture(true);
    await expect(resolveRemoteWorkspaceSource(db, { ...f, responsibleUserId: null,
      projectId: null, projectWorkspaceId: null, taskDirectory: true })).rejects.toMatchObject({
      code: "workspace_validation_failed", resultJson: { reason: "remote_workspace_readonly_sources_unsupported" },
    });
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId))).toEqual([]);
  });

  it("does not treat a configured source without a repository URL as metadata-only", async () => {
    const f = await fixture(false);
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.projectId, name: "Configured source" });
    await expect(resolveRemoteWorkspaceSource(db, { ...f, responsibleUserId: null,
      projectId: null, projectWorkspaceId: null, taskDirectory: true })).rejects.toMatchObject({
      resultJson: { reason: "remote_workspace_readonly_sources_unsupported" },
    });
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId))).toEqual([]);
  });

  it("preserves the disabled remote-source gate for a configured repository", async () => {
    const f = await fixture(true);
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", "false");
    try {
      await expect(resolveRemoteWorkspaceSource(db, { ...f, responsibleUserId: null,
        projectId: null, projectWorkspaceId: null, taskDirectory: true })).rejects.toMatchObject({
        resultJson: { reason: "remote_referenced_workspace_disabled" },
      });
      expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId))).toEqual([]);
    } finally {
      vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", "true");
    }
  });

  it("keeps a real repository denied when a source-less reference is also mentioned", async () => {
    const f = await fixture(true), metadataProjectId = randomUUID();
    await db.insert(projects).values({ id: metadataProjectId, companyId: f.companyId, name: "Metadata" });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      body: `Also mention [@Metadata](${buildProjectMentionHref(metadataProjectId)}).` });
    await expect(resolveRemoteWorkspaceSource(db, { ...f, responsibleUserId: null,
      projectId: null, projectWorkspaceId: null, taskDirectory: true })).rejects.toMatchObject({
      resultJson: { reason: "remote_workspace_readonly_sources_unsupported" },
    });
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId))).toEqual([]);
  });

  it("does not expose a source-less project from a different company", async () => {
    const f = await fixture(false), foreignCompanyId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign", issuePrefix: foreignCompanyId.slice(0, 8) });
    await db.update(projects).set({ companyId: foreignCompanyId }).where(eq(projects.id, f.projectId));
    const result = await resolveRemoteWorkspaceSource(db, { ...f, responsibleUserId: null,
      projectId: null, projectWorkspaceId: null, taskDirectory: true });
    expect(result).toMatchObject({ authority: "remote", source: { kind: "empty" },
      referencedProjectFailures: [], warnings: [] });
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId))).toEqual([]);
  });

  it("preserves an enrolled workspace's saved source for a metadata-only project mention", async () => {
    const f = await fixture(false), snapshotId = randomUUID();
    const source = { kind: "git" as const, repoUrl: "https://example.test/team/saved.git", ref: "saved-branch" };
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId,
      sourceIssueId: f.issueId, mode: "shared_workspace", strategyType: "project_primary",
      name: "Saved task workspace", providerType: "cloud_sandbox", cwd: "/workspaces/saved",
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 3, snapshotId,
        source, location: null, writerRunId: null, dirty: false } },
    }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issueId));
    const result = await resolveRemoteWorkspaceSource(db, { ...f, responsibleUserId: null,
      projectId: null, projectWorkspaceId: null, existingWorkspace: toExecutionWorkspace(workspace) });
    expect(result).toMatchObject({ authority: "remote", source, projectId: null, projectWorkspaceId: null,
      referencedProjectFailures: [{ projectId: f.projectId, reason: "resolution" }] });
    expect(result.authority === "remote" && result.source.repositories).toBeUndefined();
    expect(result.authority === "remote" && result.warnings?.length).toBe(1);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId)))
      .toEqual([workspace]);
  });
});
