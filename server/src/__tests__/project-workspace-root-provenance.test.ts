import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaceRepositoryAccess,
  executionWorkspaces, issues, projects, projectWorkspaces, projectAccessMembers, principalPermissionGrants,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { projectService } from "../services/projects.js";
import { assertExecutionWorkspaceRootReadAccess, assertExecutionWorkspaceRootWriteAccess } from "../services/execution-workspace-repositories.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("configured project root provenance", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    database = await startEmbeddedPostgresTestDatabase("paperclip-configured-provenance-");
    db = createDb(database.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "paperclip-configured-provenance-"));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each((["cwd", "file_url", "absolute_path"] as const).flatMap(sourceKind =>
    (["move", "remove", "remove_project", "replace_repositories"] as const).map(mutation => ({ sourceKind, mutation }))))(
    "retains nested private files before first admission ($sourceKind / $mutation)", async ({ sourceKind, mutation }) => {
      const companyId = randomUUID(), userId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      const cwd = path.join(root, companyId), privateCwd = path.join(cwd, "private"), unrelatedCwd = `${cwd}-unrelated`;
      await mkdir(privateCwd, { recursive: true });
      await mkdir(unrelatedCwd);
      await writeFile(path.join(privateCwd, "secret.txt"), "Private configured source\n");
      await db.insert(companies).values({ id: companyId, name: "Configured provenance", issuePrefix: `P${companyId.slice(0, 6)}` });
      await db.insert(authUsers).values({ id: userId, name: "Reader", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process", status: "idle" });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "member", status: "active" });
      const [source] = await db.insert(projects).values({ companyId, name: "Private source", visibility: "private",
        executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
      const sourceUrl = (cwd: string) => sourceKind === "file_url" ? pathToFileURL(cwd).href : cwd;
      const [configured] = await db.insert(projectWorkspaces).values({ companyId, projectId: source.id, name: "Private files",
        cwd: sourceKind === "cwd" ? privateCwd : null,
        repoUrl: sourceKind === "cwd" ? "https://github.com/example/private" : sourceUrl(privateCwd),
        metadata: { githubRepositoryId: "fixture-private" } }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Public parent", cwd, mode: "shared_workspace", strategyType: "task_directory" }).returning();
      await db.insert(issues).values({ id: issueId, companyId, title: "Public task", assigneeAgentId: agentId, executionWorkspaceId: workspace.id });
      const actor = { type: "board" as const, source: "session" as const, userId, ignoreInstanceAdmin: true };
      const access = { companyId, cwd, sourceWorkspaceId: workspace.id, actor };
      expect(await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, companyId))).toEqual([]);
      const service = projectService(db, { captureWorkspaceUpdates: false });
      if (mutation === "move") await service.updateWorkspace(source.id, configured.id,
        sourceKind === "cwd" ? { cwd: unrelatedCwd } : { repoUrl: sourceUrl(unrelatedCwd) });
      else if (mutation === "remove") await service.removeWorkspace(source.id, configured.id);
      else if (mutation === "remove_project") await service.remove(source.id);
      else await service.replaceRepositories(source.id, []);
      const retained = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, companyId));
      expect(retained).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "project_source", scopeId: source.id, canonicalCwd: await realpath(privateCwd) }),
        expect.objectContaining({ kind: "shared_project_source", scopeId: source.id, canonicalCwd: await realpath(privateCwd) }),
      ]));
      expect(retained.some(row => row.kind === "reader")).toBe(false);
      await expect(assertExecutionWorkspaceRootReadAccess(db, access)).rejects.toThrow(/source project/);
      await expect(assertExecutionWorkspaceRootWriteAccess(db, { ...access, issueId })).rejects.toThrow(/source project/);
      if (mutation !== "move") await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId, cwd: unrelatedCwd, actor })).resolves.toBeUndefined();
      if (mutation === "remove_project") return;
      const [readGrant] = await db.insert(projectAccessMembers).values({ companyId, projectId: source.id, subjectType: "user", subjectId: userId }).returning();
      await expect(assertExecutionWorkspaceRootReadAccess(db, access)).resolves.toBeUndefined();
      await expect(assertExecutionWorkspaceRootWriteAccess(db, { ...access, issueId })).rejects.toThrow(/protected|not authorized/);
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
        permissionKey: "tasks:assign_scope", scope: { projectId: source.id, assigneeAgentId: agentId } });
      await expect(assertExecutionWorkspaceRootWriteAccess(db, { ...access, issueId })).resolves.toBeUndefined();
      await db.delete(projectAccessMembers).where(eq(projectAccessMembers.id, readGrant.id));
      await expect(assertExecutionWorkspaceRootReadAccess(db, access)).rejects.toThrow(/source project/);
      await expect(assertExecutionWorkspaceRootWriteAccess(db, { ...access, issueId })).rejects.toThrow(/source project/);
    });

  it("can remove a configured folder that never existed without inventing provenance", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Missing source", issuePrefix: `M${companyId.slice(0, 6)}` });
    const [source] = await db.insert(projects).values({ companyId, name: "Missing private source", visibility: "private" }).returning();
    const [configured] = await db.insert(projectWorkspaces).values({ companyId, projectId: source.id, name: "Missing", cwd: path.join(root, companyId, "never-created") }).returning();
    await expect(projectService(db, { captureWorkspaceUpdates: false }).removeWorkspace(source.id, configured.id)).resolves.toMatchObject({ id: configured.id });
    expect(await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, companyId))).toEqual([]);
  });
});
