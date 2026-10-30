import express from "express";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, executionWorkspaceRepositoryAccess, executionWorkspaceRepositoryRoots, executionWorkspaceRepositories, executionWorkspaces, goals, issueAccessGrants, issues, projects, projectAccessMembers, projectWorkspaces, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { taskRepositoryRelativePath } from "../services/execution-workspace-repositories.js";
import { errorHandler } from "../middleware/index.js";
import { canActorReadExecutionWorkspace } from "../services/authorization.js";
import {
  createFileResourceAvailabilityLimiter,
  createFileResourceLimiter,
  createFileResourceListLimiter,
  fileResourceRoutes,
  type WorkspaceFileResourceService,
} from "../routes/file-resources.js";
import {
  WORKSPACE_FILE_TEXT_MAX_BYTES,
  workspaceFileResourceService,
} from "../services/workspace-file-resources.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const execFileAsync = promisify(execFile);
let seedGraphSequence = 0;

type TestGraph = {
  companyId: string;
  otherCompanyId: string;
  issueId: string;
  otherIssueId: string;
  projectId: string;
  projectWorkspaceId: string;
  targetProjectId: string;
  targetProjectWorkspaceId: string;
  otherProjectId: string;
  otherProjectWorkspaceId: string;
  workspaceRoot: string;
  targetWorkspaceRoot: string;
  executionRoot: string;
};

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-resources-"));
  const projectRoot = path.join(root, "project");
  const targetProjectRoot = path.join(root, "target-project");
  const executionRoot = path.join(root, "execution");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(targetProjectRoot, { recursive: true });
  await fs.mkdir(executionRoot, { recursive: true });
  return { root, projectRoot, targetProjectRoot, executionRoot };
}

async function seedGraph(db: Db, input: {
  projectRoot: string;
  targetProjectRoot?: string;
  executionRoot?: string | null;
  projectSourceType?: string;
  targetProjectSourceType?: string;
}): Promise<TestGraph> {
  seedGraphSequence += 1;
  const prefixSuffix = seedGraphSequence.toString(36).toUpperCase().padStart(4, "0");
  const suffix = crypto.randomUUID().slice(0, 8);
  const companyId = crypto.randomUUID();
  const otherCompanyId = crypto.randomUUID();
  const goalId = crypto.randomUUID();
  const otherGoalId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const targetProjectId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  const projectWorkspaceId = crypto.randomUUID();
  const targetProjectWorkspaceId = crypto.randomUUID();
  const otherProjectWorkspaceId = crypto.randomUUID();
  const executionWorkspaceId = crypto.randomUUID();
  const issueId = crypto.randomUUID();
  const otherIssueId = crypto.randomUUID();

  await db.insert(companies).values([
    { id: companyId, name: `Company ${suffix}`, issuePrefix: `F${prefixSuffix}` },
    { id: otherCompanyId, name: `Other ${suffix}`, issuePrefix: `G${prefixSuffix}` },
  ]);
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  await db.insert(goals).values([
    { id: goalId, companyId, title: "Goal", level: "company", status: "active" },
    { id: otherGoalId, companyId: otherCompanyId, title: "Other goal", level: "company", status: "active" },
  ]);
  await db.insert(projects).values([
    { id: projectId, companyId, goalId, name: "Project", status: "in_progress" },
    { id: targetProjectId, companyId, goalId, name: "Target project", status: "in_progress" },
    { id: otherProjectId, companyId: otherCompanyId, goalId: otherGoalId, name: "Other project", status: "in_progress" },
  ]);
  await db.insert(projectWorkspaces).values([
    {
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: input.projectSourceType ?? "local_path",
      cwd: input.projectRoot,
      isPrimary: true,
    },
    {
      id: otherProjectWorkspaceId,
      companyId: otherCompanyId,
      projectId: otherProjectId,
      name: "Other workspace",
      sourceType: "local_path",
      cwd: input.projectRoot,
      isPrimary: true,
    },
    {
      id: targetProjectWorkspaceId,
      companyId,
      projectId: targetProjectId,
      name: "Target workspace",
      sourceType: input.targetProjectSourceType ?? "local_path",
      cwd: input.targetProjectRoot ?? input.projectRoot,
      isPrimary: true,
    },
  ]);
  await db.insert(issues).values([
    {
      id: issueId,
      companyId,
      projectId,
      goalId,
      projectWorkspaceId,
      title: "Read a file",
      status: "todo",
      priority: "medium",
    },
    {
      id: otherIssueId,
      companyId: otherCompanyId,
      projectId: otherProjectId,
      goalId: otherGoalId,
      projectWorkspaceId: otherProjectWorkspaceId,
      title: "Other issue",
      status: "todo",
      priority: "medium",
    },
  ]);
  await db.insert(executionWorkspaces).values({
    id: executionWorkspaceId,
    companyId,
    projectId,
    projectWorkspaceId,
    sourceIssueId: issueId,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Issue worktree",
    status: "active",
    cwd: input.executionRoot ?? null,
    providerType: input.executionRoot ? "git_worktree" : "remote_managed",
    providerRef: input.executionRoot ?? "remote-workspace",
  });
  await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));

  return {
    companyId,
    otherCompanyId,
    issueId,
    otherIssueId,
    projectId,
    projectWorkspaceId,
    targetProjectId,
    targetProjectWorkspaceId,
    otherProjectId,
    otherProjectWorkspaceId,
    workspaceRoot: input.projectRoot,
    targetWorkspaceRoot: input.targetProjectRoot ?? input.projectRoot,
    executionRoot: input.executionRoot ?? input.projectRoot,
  };
}

function createApp(
  db: Db,
  actor: Request["actor"],
  routeOpts: Parameters<typeof fileResourceRoutes>[1] = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", fileResourceRoutes(db, routeOpts));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("workspace file resources", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-file-resources-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
  });

  it("withholds private task files and private cross-project targets", async () => {
    const { projectRoot, executionRoot, targetProjectRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot, targetProjectRoot });
    await fs.writeFile(path.join(projectRoot, "secret.txt"), "PRIVATE_FILE", "utf8");
    await fs.writeFile(path.join(targetProjectRoot, "secret.txt"), "PRIVATE_TARGET", "utf8");
    const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });
    await db.update(issues).set({ visibility: "private", responsibleUserId: "owner" }).where(eq(issues.id, graph.issueId));
    await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: "secret.txt" }).expect(404);
    await db.update(issues).set({ visibility: "open" }).where(eq(issues.id, graph.issueId));
    await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: "secret.txt" }).expect(200);
    await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, graph.targetProjectId));
    await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ projectId: graph.targetProjectId, workspaceId: graph.targetProjectWorkspaceId, path: "secret.txt" }).expect(404);
  });

  it("accepts issue identifiers and returns 404 for unknown or malformed issue ids", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "notes.txt"), "IDENTIFIER_OK", "utf8");
    const [company] = await db.select().from(companies).where(eq(companies.id, graph.companyId));
    const identifier = `${company!.issuePrefix}-1`;
    await db.update(issues).set({ issueNumber: 1, identifier }).where(eq(issues.id, graph.issueId));
    const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });

    for (const ref of [identifier, identifier.toLowerCase()]) {
      const content = await request(app).get(`/api/issues/${ref}/file-resources/content`).query({ workspace: "project", path: "notes.txt" }).expect(200);
      expect(content.body.content.data).toBe("IDENTIFIER_OK");
      await request(app).get(`/api/issues/${ref}/file-resources/list`).query({ workspace: "project" }).expect(200);
    }

    await db.update(issues).set({ visibility: "private", responsibleUserId: "owner" }).where(eq(issues.id, graph.issueId));
    await request(app).get(`/api/issues/${identifier}/file-resources/content`).query({ workspace: "project", path: "notes.txt" }).expect(404);

    for (const ref of [`${company!.issuePrefix}-999999`, "not-a-uuid"]) {
      await request(app).get(`/api/issues/${ref}/file-resources/content`).query({ workspace: "project", path: "notes.txt" }).expect(404);
      await request(app).get(`/api/issues/${ref}/file-resources/list`).query({ workspace: "project" }).expect(404);
      await request(app).post(`/api/issues/${ref}/file-resources/availability`).send({ queries: [{ workspace: "project", path: "notes.txt" }] }).expect(404);
    }
  });

  it("resolves and reads a project file without exposing absolute paths", async () => {
    const { root, projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "src", "app.ts"), "export const ok = true;\n", { encoding: "utf8" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, "src", "app.ts"), "export const ok = true;\n", "utf8");
    });

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "src/app.ts" });

    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body.resource.displayPath).toBe("src/app.ts");
    expect(JSON.stringify(res.body)).not.toContain(root);
    expect(res.body.content.data).toContain("export const ok");
  });

  it("lists and downloads non-previewable workspace files", async () => {
    const { root, projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    const relativePath = "artifacts/archive.bin";
    const bytes = Buffer.from([0, 1, 2, 3, 4, 255]);
    await fs.mkdir(path.join(projectRoot, "artifacts"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, relativePath), bytes);

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const listed = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "all", path: "artifacts" });

    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "file",
        relativePath,
        previewKind: "unsupported",
        capabilities: { preview: false, download: true, listChildren: false },
      }),
    ]));
    expect(JSON.stringify(listed.body)).not.toContain(root);

    const downloaded = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: relativePath, download: "1" })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(downloaded.status).toBe(200);
    expect(downloaded.headers["content-disposition"]).toBe('attachment; filename="archive.bin"');
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(downloaded.body as Buffer, bytes)).toBe(0);
  });

  it("falls back from an execution workspace miss to the project workspace", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Project\n", "utf8");

    const resolved = await workspaceFileResourceService(db).resolve(graph.issueId, {
      path: "README.md",
      workspace: "auto",
    });

    expect(resolved.workspaceKind).toBe("project_workspace");
    expect(resolved.displayPath).toBe("README.md");
    expect(resolved.capabilities.preview).toBe(true);
  });

  it.each(["missing", "denied", "symlink loop", "overlong path"])("skips an unused %s configured alternative while keeping explicit reads strict", async alternative => {
    const { root, projectRoot, executionRoot, targetProjectRoot } = await makeWorkspace();
    try {
      const graph = await seedGraph(db, { projectRoot, executionRoot, targetProjectRoot });
      await db.update(executionWorkspaces).set({ projectId: null, projectWorkspaceId: null, providerType: "local_fs" }).where(eq(executionWorkspaces.sourceIssueId, graph.issueId));
      await fs.writeFile(path.join(executionRoot, "report.txt"), "CURRENT_TASK_REPORT");
      if (alternative === "missing" || alternative === "symlink loop") {
        await fs.rm(projectRoot, { recursive: true });
        if (alternative === "symlink loop") await fs.symlink(projectRoot, projectRoot);
      } else if (alternative === "overlong path") {
        await db.update(projectWorkspaces).set({ cwd: path.join(projectRoot, "x".repeat(512)) }).where(eq(projectWorkspaces.id, graph.projectWorkspaceId));
      } else {
        const [privateIssue] = await db.insert(issues).values({ companyId: graph.companyId, title: "Private alternative source", visibility: "private", responsibleUserId: "private-owner" }).returning();
        await db.insert(executionWorkspaces).values({ companyId: graph.companyId, sourceIssueId: privateIssue.id, name: "Private alternative", cwd: projectRoot,
          mode: "shared_workspace", strategyType: "task_directory", providerType: "local_fs" });
        await fs.writeFile(path.join(projectRoot, "report.txt"), "PRIVATE_ALTERNATIVE_BYTES");
      }
      const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });
      const base = `/api/issues/${graph.issueId}/file-resources`;
      const listed = await request(app).get(`${base}/list`).expect(200);
      expect(listed.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: "report.txt" })]));
      await request(app).get(`${base}/resolve`).query({ path: "report.txt" }).expect(200);
      const preview = await request(app).get(`${base}/content`).query({ path: "report.txt" }).expect(200);
      expect(preview.body.content.data).toBe("CURRENT_TASK_REPORT");
      const download = await request(app).get(`${base}/content`).query({ path: "report.txt", download: true }).expect(200);
      expect(download.text).toBe("CURRENT_TASK_REPORT");
      const explicit = { projectId: graph.projectId, workspaceId: graph.projectWorkspaceId };
      for (const target of [explicit, { workspace: "project" }]) {
        await request(app).get(`${base}/list`).query(target).expect(alternative === "denied" ? 200 : 404);
        await request(app).get(`${base}/resolve`).query({ ...target, path: "report.txt" }).expect(alternative === "denied" ? 200 : 404);
        await request(app).get(`${base}/content`).query({ ...target, path: "report.txt" }).expect(alternative === "denied" ? 200 : 404);
        await request(app).get(`${base}/content`).query({ ...target, path: "report.txt", download: true }).expect(alternative === "denied" ? 200 : 404);
      }
      const batch = await request(app).post(`${base}/availability`).send({ queries: [
        { path: "report.txt" }, { workspace: "execution", path: "report.txt" },
        { workspace: "project", path: "report.txt" }, { ...explicit, path: "report.txt" },
      ] }).expect(200);
      expect(batch.body.results).toEqual([
        expect.objectContaining({ openable: true, resource: expect.objectContaining({ workspaceKind: "execution_workspace" }) }),
        expect.objectContaining({ openable: true, resource: expect.objectContaining({ workspaceKind: "execution_workspace" }) }),
        alternative === "denied" ? expect.objectContaining({ openable: true }) : expect.objectContaining({ openable: false, unavailableReason: "not_found", resource: null }),
        alternative === "denied" ? expect.objectContaining({ openable: true }) : expect.objectContaining({ openable: false, unavailableReason: "not_found", resource: null }),
      ]);
      expect(JSON.stringify(batch.body)).not.toContain(projectRoot);
      expect(JSON.stringify(batch.body)).not.toContain("PRIVATE_ALTERNATIVE_BYTES");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("reads projectless task files before and after organizational project assignment", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, graph.issueId));
    await db.update(executionWorkspaces).set({ projectId: null, projectWorkspaceId: null, strategyType: "project_primary", providerType: "local_fs" }).where(eq(executionWorkspaces.sourceIssueId, graph.issueId));
    await fs.writeFile(path.join(executionRoot, "report.txt"), "Task-owned report", "utf8");
    const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });
    for (const projectId of [null, graph.targetProjectId]) {
      await db.update(issues).set({ projectId }).where(eq(issues.id, graph.issueId));
      const result = await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "execution", path: "report.txt" }).expect(200);
      expect(result.body.content.data).toBe("Task-owned report");
      expect(result.body.resource.workspaceKind).toBe("execution_workspace");
    }
  });

  it("reads task-bound files regardless of historical private sources and leaves legacy ledgers unchanged", async () => {
    const { root, projectRoot, executionRoot, targetProjectRoot } = await makeWorkspace();
    try {
      const graph = await seedGraph(db, { projectRoot, executionRoot, targetProjectRoot });
      const canonicalCwd = await fs.realpath(executionRoot);
      const rootKey = createHash("sha256").update(canonicalCwd).digest("hex");
      const privateIssueId = crypto.randomUUID();
      await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, graph.issueId));
      await db.update(executionWorkspaces).set({ projectId: null, projectWorkspaceId: null, providerType: "local_fs" }).where(eq(executionWorkspaces.sourceIssueId, graph.issueId));
      await db.update(projectWorkspaces).set({ cwd: executionRoot }).where(eq(projectWorkspaces.id, graph.projectWorkspaceId));
      await db.insert(issues).values({ id: privateIssueId, companyId: graph.companyId, title: "Private source task", visibility: "private", responsibleUserId: "private-owner" });
      const [source] = await db.insert(executionWorkspaces).values({ companyId: graph.companyId, sourceIssueId: privateIssueId,
        name: "Private source workspace", cwd: executionRoot, mode: "shared_workspace", strategyType: "task_directory", providerType: "local_fs" }).returning();
      await fs.writeFile(path.join(executionRoot, "secret.txt"), "PRIVATE_ROOT_BYTES");
      const [task] = await db.select().from(issues).where(eq(issues.id, graph.issueId));
      await db.update(executionWorkspaces).set({ sourceIssueId: privateIssueId, name: "Private original workspace metadata" })
        .where(eq(executionWorkspaces.id, task.executionWorkspaceId!));
      await db.update(executionWorkspaces).set({ sourceIssueId: null }).where(eq(executionWorkspaces.id, task.executionWorkspaceId!));
      expect(await canActorReadExecutionWorkspace(db, { type: "board", userId: "board-user", source: "session", companyIds: [graph.companyId] }, task.executionWorkspaceId!)).toBe(false);
      const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });
      const targets = [{ workspace: "execution" }, { projectId: graph.projectId, workspaceId: graph.projectWorkspaceId }];
      const reads = () => targets.flatMap(target => [
        request(app).get(`/api/issues/${graph.issueId}/file-resources/list`).query(target),
        request(app).get(`/api/issues/${graph.issueId}/file-resources/resolve`).query({ ...target, path: "secret.txt" }),
        request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ ...target, path: "secret.txt" }),
        request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ ...target, path: "secret.txt", download: true }),
        request(app).post(`/api/issues/${graph.issueId}/file-resources/availability`).send({ queries: [{ ...target, path: "secret.txt" }] }),
      ]);
      const allow = async () => {
        for (const pending of reads()) {
          const response = await pending;
          expect(response.status).toBe(200);
          if (response.body.kind === "workspace_file_availability") {
            expect(response.body.results).toEqual([expect.objectContaining({ openable: true })]);
          }
          for (const hidden of [source.id, privateIssueId, "Private source workspace", "Private original workspace metadata"]) expect(JSON.stringify(response.body)).not.toContain(hidden);
        }
      };
      await allow();
      expect(await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, graph.companyId))).toEqual([]);
      expect(await db.select().from(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, graph.companyId))).toEqual([]);
      const [grant] = await db.insert(issueAccessGrants).values({ issueId: privateIssueId, subjectType: "user", subjectId: "board-user", source: "explicit" }).returning();
      for (const pending of reads()) expect((await pending).status).toBe(200);
      const content = await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "execution", path: "secret.txt" }).expect(200);
      expect(content.body.content.data).toBe("PRIVATE_ROOT_BYTES");
      await db.insert(executionWorkspaceRepositoryAccess).values({ companyId: graph.companyId, rootKey, canonicalCwd, kind: "source", scopeId: source.id });
      const provenance = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, graph.companyId));
      await db.update(executionWorkspaces).set({ cwd: targetProjectRoot }).where(eq(executionWorkspaces.id, source.id));
      await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
      await allow();
      await db.update(issueAccessGrants).set({ revokedAt: null }).where(eq(issueAccessGrants.id, grant.id));
      await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "execution", path: "secret.txt" }).expect(200);
      await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, source.id));
      await allow();
      expect(await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, graph.companyId))).toEqual(provenance);
      expect(await db.select().from(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, graph.companyId))).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("ignores an unrelated private project alias while reading the current task root", async () => {
    const { root, projectRoot, executionRoot, targetProjectRoot } = await makeWorkspace();
    try {
      const graph = await seedGraph(db, { projectRoot, executionRoot, targetProjectRoot });
      await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, graph.issueId));
      await db.update(executionWorkspaces).set({ projectId: null, projectWorkspaceId: null, providerType: "local_fs" }).where(eq(executionWorkspaces.sourceIssueId, graph.issueId));
      await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, graph.targetProjectId));
      await db.update(projectWorkspaces).set({ cwd: executionRoot }).where(eq(projectWorkspaces.id, graph.targetProjectWorkspaceId));
      await fs.writeFile(path.join(executionRoot, "private-project.txt"), "PRIVATE_CONFIGURED_PROJECT");
      const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });
      await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "execution", path: "private-project.txt" }).expect(200);
      await db.insert(projectAccessMembers).values({ companyId: graph.companyId, projectId: graph.targetProjectId, subjectType: "user", subjectId: "board-user" });
      const response = await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "execution", path: "private-project.txt" }).expect(200);
      expect(response.body.content.data).toBe("PRIVATE_CONFIGURED_PROJECT");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ["configured", "ancestor"], ["configured", "descendant"],
    ["execution", "ancestor"], ["execution", "descendant"],
  ] as const)("allows files in authorized roots despite %s private %s aliases and retained history", async (ownerKind, relation) => {
    const { root, projectRoot, targetProjectRoot } = await makeWorkspace();
    try {
      const ancestor = path.join(root, "work"), descendant = path.join(ancestor, "private");
      await fs.mkdir(descendant, { recursive: true });
      const publicRoot = relation === "ancestor" ? ancestor : descendant;
      const privateRoot = relation === "ancestor" ? descendant : ancestor;
      const relativeFile = relation === "ancestor" ? "private/secret.txt" : "secret.txt";
      await fs.writeFile(path.join(publicRoot, relativeFile), "PRIVATE_OVERLAPPING_ROOT_BYTES");
      const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot: publicRoot });
      await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, graph.issueId));
      await db.update(executionWorkspaces).set({ projectId: null, projectWorkspaceId: null, providerType: "local_fs" }).where(eq(executionWorkspaces.sourceIssueId, graph.issueId));
      await db.update(projectWorkspaces).set({ cwd: publicRoot }).where(eq(projectWorkspaces.id, graph.projectWorkspaceId));
      let ownerId: string;
      let privateIssueId: string | null = null;
      if (ownerKind === "configured") {
        ownerId = graph.targetProjectId;
        await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, ownerId));
        await db.update(projectWorkspaces).set({ cwd: privateRoot }).where(eq(projectWorkspaces.id, graph.targetProjectWorkspaceId));
        expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.projectId, ownerId))).toEqual([]);
      } else {
        const [task] = await db.insert(issues).values({ companyId: graph.companyId, title: "Private overlapping task", visibility: "private", responsibleUserId: "private-owner" }).returning();
        privateIssueId = task.id;
        const [workspace] = await db.insert(executionWorkspaces).values({ companyId: graph.companyId, sourceIssueId: task.id,
          name: "Private overlapping workspace", cwd: privateRoot, mode: "shared_workspace", strategyType: "task_directory", providerType: "local_fs" }).returning();
        ownerId = workspace.id;
      }
      const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });
      const targets = [{ workspace: "execution" }, { projectId: graph.projectId, workspaceId: graph.projectWorkspaceId }];
      const readState = async () => ({
        access: await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, graph.companyId)),
        policies: await db.select().from(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, graph.companyId)),
      });
      const allow = async () => {
        const before = await readState();
        for (const target of targets) {
          for (const [endpoint, query] of [
            ["list", {}], ["resolve", { path: relativeFile }], ["content", { path: relativeFile }], ["content", { path: relativeFile, download: true }],
          ] as const) {
            const response = await request(app).get(`/api/issues/${graph.issueId}/file-resources/${endpoint}`).query({ ...target, ...query }).expect(200);
            for (const hidden of [ownerId, "Private overlapping"]) expect(JSON.stringify(response.body)).not.toContain(hidden);
          }
          const availability = await request(app).post(`/api/issues/${graph.issueId}/file-resources/availability`)
            .send({ queries: [{ ...target, path: relativeFile }] }).expect(200);
          expect(availability.body.results).toEqual([expect.objectContaining({ openable: true })]);
        }
        expect(await readState()).toEqual(before);
      };
      await allow();
      const grant = ownerKind === "configured"
        ? (await db.insert(projectAccessMembers).values({ companyId: graph.companyId, projectId: ownerId, subjectType: "user", subjectId: "board-user" }).returning())[0]!
        : (await db.insert(issueAccessGrants).values({ issueId: privateIssueId!, subjectType: "user", subjectId: "board-user", source: "explicit" }).returning())[0]!;
      const beforeAllowedReads = await readState();
      for (const target of targets) {
        const response = await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ ...target, path: relativeFile }).expect(200);
        expect(response.body.content.data).toBe("PRIVATE_OVERLAPPING_ROOT_BYTES");
      }
      expect(await readState()).toEqual(beforeAllowedReads);
      const canonicalCwd = await fs.realpath(privateRoot);
      await db.insert(executionWorkspaceRepositoryAccess).values({ companyId: graph.companyId,
        rootKey: createHash("sha256").update(canonicalCwd).digest("hex"), canonicalCwd,
        kind: ownerKind === "configured" ? "project_source" : "source", scopeId: ownerId });
      if (ownerKind === "configured") {
        await db.update(projectWorkspaces).set({ cwd: targetProjectRoot }).where(eq(projectWorkspaces.id, graph.targetProjectWorkspaceId));
        await db.delete(projectAccessMembers).where(eq(projectAccessMembers.id, grant.id));
      } else {
        await db.update(executionWorkspaces).set({ cwd: targetProjectRoot }).where(eq(executionWorkspaces.id, ownerId));
        await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
      }
      await allow();
      expect(await fs.readFile(path.join(publicRoot, relativeFile), "utf8")).toBe("PRIVATE_OVERLAPPING_ROOT_BYTES");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps sibling string-prefix roots independent without registering file readers", async () => {
    const { root, projectRoot, targetProjectRoot } = await makeWorkspace();
    try {
      const privateRoot = path.join(root, "work"), publicRoot = path.join(root, "worker");
      await fs.mkdir(privateRoot); await fs.mkdir(publicRoot);
      await fs.writeFile(path.join(publicRoot, "public.txt"), "PUBLIC_SIBLING_BYTES");
      const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot: publicRoot });
      await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, graph.targetProjectId));
      await db.update(projectWorkspaces).set({ cwd: privateRoot }).where(eq(projectWorkspaces.id, graph.targetProjectWorkspaceId));
      const [privateIssue] = await db.insert(issues).values({ companyId: graph.companyId, title: "Private sibling", visibility: "private", responsibleUserId: "private-owner" }).returning();
      await db.insert(executionWorkspaces).values({ companyId: graph.companyId, sourceIssueId: privateIssue.id, cwd: privateRoot,
        name: "Private sibling", mode: "shared_workspace", strategyType: "task_directory", providerType: "local_fs" });
      const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });
      const target = { workspace: "execution", path: "public.txt" };
      const content = await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query(target).expect(200);
      expect(content.body.content.data).toBe("PUBLIC_SIBLING_BYTES");
      await request(app).get(`/api/issues/${graph.issueId}/file-resources/list`).query({ workspace: "execution" }).expect(200);
      await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ ...target, download: true }).expect(200);
      const availability = await request(app).post(`/api/issues/${graph.issueId}/file-resources/availability`).send({ queries: [target] }).expect(200);
      expect(availability.body.results).toEqual([expect.objectContaining({ openable: true })]);
      expect(await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, graph.companyId))).toEqual([]);
      expect(await db.select().from(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, graph.companyId))).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("does not confuse identical repositories in unrelated available roots with private file provenance", async () => {
    const { root, projectRoot, executionRoot, targetProjectRoot } = await makeWorkspace();
    try {
      const graph = await seedGraph(db, { projectRoot, executionRoot, targetProjectRoot });
      await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, graph.issueId));
      const [publicWorkspace] = await db.update(executionWorkspaces).set({ projectId: null, projectWorkspaceId: null, providerType: "local_fs" }).where(eq(executionWorkspaces.sourceIssueId, graph.issueId)).returning();
      const [privateIssue] = await db.insert(issues).values({ companyId: graph.companyId, title: "Unrelated private repository", visibility: "private", responsibleUserId: "private-owner" }).returning();
      const [privateWorkspace] = await db.insert(executionWorkspaces).values({ companyId: graph.companyId, sourceIssueId: privateIssue.id,
        name: "Unrelated source", cwd: targetProjectRoot, mode: "shared_workspace", strategyType: "task_directory", providerType: "local_fs" }).returning();
      const identity = "https://github.com/fixture/same-repo.git", relativePath = taskRepositoryRelativePath(identity);
      for (const workspace of [publicWorkspace, privateWorkspace]) {
        await fs.mkdir(path.join(workspace.cwd!, relativePath), { recursive: true });
        await fs.writeFile(path.join(workspace.cwd!, relativePath, "report.txt"), workspace.id === publicWorkspace.id ? "PUBLIC_COPY" : "PRIVATE_COPY");
        await db.insert(executionWorkspaceRepositories).values({ companyId: graph.companyId, executionWorkspaceId: workspace.id,
          repositoryIdentity: identity, repoUrl: identity, relativePath, requestKey: workspace.id, state: "ready" });
      }
      const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });
      const response = await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "execution", path: `${relativePath}/report.txt` }).expect(200);
      expect(response.body.content.data).toBe("PUBLIC_COPY");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("reads a selected source independently of task project while retaining source privacy", async () => {
    const { projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "source.txt"), "Selected source", "utf8");
    const app = createApp(db, { type: "board", userId: "board-user", companyIds: [graph.companyId], source: "session", isInstanceAdmin: false });
    for (const projectId of [null, graph.targetProjectId]) {
      await db.update(issues).set({ projectId }).where(eq(issues.id, graph.issueId));
      const result = await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: "source.txt" }).expect(200);
      expect(result.body.content.data).toBe("Selected source");
      expect(result.body.resource.workspaceId).toBe(graph.projectWorkspaceId);
    }
    await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, graph.projectId));
    await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: "source.txt" }).expect(404);
  });

  it("auto-discovers unhinted same-company project files when issue workspaces miss", async () => {
    const { projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    const targetPath = "docs/reference/skills.md";
    await fs.mkdir(path.join(targetProjectRoot, path.dirname(targetPath)), { recursive: true });
    await fs.writeFile(path.join(targetProjectRoot, targetPath), "# Skills reference\n", "utf8");

    const resolved = await workspaceFileResourceService(db).resolve(graph.issueId, {
      path: targetPath,
      workspace: "auto",
    });

    expect(resolved).toMatchObject({
      workspaceKind: "project_workspace",
      workspaceId: graph.targetProjectWorkspaceId,
      projectId: graph.targetProjectId,
      projectName: "Target project",
      displayPath: `Target project / ${targetPath}`,
      previewKind: "text",
    });

    const content = await workspaceFileResourceService(db).readContent(graph.issueId, {
      path: targetPath,
      workspace: "auto",
    });
    expect(content.resource.workspaceId).toBe(graph.targetProjectWorkspaceId);
    expect(content.content.data).toContain("# Skills reference");
  });

  it("resolves explicit same-company cross-project workspace files and logs target details", async () => {
    const { root, projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    await fs.mkdir(path.join(targetProjectRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(targetProjectRoot, "docs", "README.md"), "# Target project\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({
        projectId: graph.targetProjectId,
        workspaceId: graph.targetProjectWorkspaceId,
        path: "docs/README.md",
      });

    expect(res.status).toBe(200);
    expect(res.body.resource).toMatchObject({
      workspaceKind: "project_workspace",
      workspaceId: graph.targetProjectWorkspaceId,
      projectId: graph.targetProjectId,
      projectName: "Target project",
      displayPath: "Target project / docs/README.md",
    });
    expect(res.body.content.data).toContain("# Target project");
    expect(JSON.stringify(res.body)).not.toContain(root);

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const read = rows.find((row) => row.action === "issue.file_resource_content_read");
    expect(read?.details).toMatchObject({
      outcome: "success",
      workspaceId: graph.targetProjectWorkspaceId,
      projectId: graph.targetProjectId,
      projectName: "Target project",
      displayPath: "Target project / docs/README.md",
    });
    expect(JSON.stringify(read?.details)).not.toContain(targetProjectRoot);
  });

  it("reads explicit cross-project git_repo workspaces with a local checkout", async () => {
    const { root, projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, {
      projectRoot,
      targetProjectRoot,
      executionRoot,
      targetProjectSourceType: "git_repo",
    });
    const readmePath = "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/README.md";
    await fs.mkdir(path.join(targetProjectRoot, path.dirname(readmePath)), { recursive: true });
    await fs.writeFile(path.join(targetProjectRoot, readmePath), "# Bundled skills\n\nRendered from content project.\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({
        projectId: graph.targetProjectId,
        workspaceId: graph.targetProjectWorkspaceId,
        path: readmePath,
      });

    expect(res.status).toBe(200);
    expect(res.body.resource).toMatchObject({
      workspaceKind: "project_workspace",
      workspaceId: graph.targetProjectWorkspaceId,
      projectId: graph.targetProjectId,
      projectName: "Target project",
      displayPath: `Target project / ${readmePath}`,
      provider: "git_repo",
      previewKind: "text",
    });
    expect(res.body.content.encoding).toBe("utf8");
    expect(res.body.content.data).toContain("# Bundled skills");
    expect(JSON.stringify(res.body)).not.toContain(root);
  });

  it("resolves and lists explicit same-company cross-project workspace folders", async () => {
    const { root, projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    const folderPath = "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/";
    await fs.mkdir(path.join(targetProjectRoot, folderPath), { recursive: true });
    await fs.writeFile(path.join(targetProjectRoot, folderPath, "README.md"), "# Bundled skills\n", "utf8");
    await fs.writeFile(path.join(targetProjectRoot, folderPath, "notes.txt"), "notes\n", "utf8");
    await fs.writeFile(path.join(targetProjectRoot, "outside.txt"), "not in focused folder\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const resolved = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({
        projectId: graph.targetProjectId,
        workspaceId: graph.targetProjectWorkspaceId,
        path: folderPath,
      });

    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      kind: "directory",
      workspaceKind: "project_workspace",
      workspaceId: graph.targetProjectWorkspaceId,
      projectId: graph.targetProjectId,
      projectName: "Target project",
      displayPath: `Target project / ${folderPath}`,
      capabilities: { preview: false, download: false, listChildren: true },
    });
    expect(JSON.stringify(resolved.body)).not.toContain(root);

    const listed = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({
        projectId: graph.targetProjectId,
        workspaceId: graph.targetProjectWorkspaceId,
        path: folderPath,
        mode: "all",
      });

    expect(listed.status).toBe(200);
    expect(listed.body.state).toBe("available");
    expect(listed.body.query).toMatchObject({ path: folderPath.slice(0, -1), mode: "all" });
    expect(new Set(listed.body.items.map((item: { relativePath: string }) => item.relativePath))).toEqual(new Set([
      `${folderPath}README.md`,
      `${folderPath}notes.txt`,
    ]));
    expect(JSON.stringify(listed.body)).not.toContain(root);
    expect(JSON.stringify(listed.body)).not.toContain("outside.txt");
  });

  it("auto-discovers unhinted same-company project folders when issue workspaces miss", async () => {
    const { root, projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    const folderPath = "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/";
    await fs.mkdir(path.join(targetProjectRoot, folderPath), { recursive: true });
    await fs.writeFile(path.join(targetProjectRoot, folderPath, "README.md"), "# Bundled skills\n", "utf8");
    await fs.writeFile(path.join(targetProjectRoot, folderPath, "suggestions.md"), "# Suggestions\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const resolved = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({ path: folderPath });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      kind: "directory",
      workspaceId: graph.targetProjectWorkspaceId,
      projectId: graph.targetProjectId,
      projectName: "Target project",
      displayPath: `Target project / ${folderPath}`,
    });

    const listed = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ path: folderPath });
    expect(listed.status).toBe(200);
    expect(listed.body.state).toBe("available");
    expect(listed.body.workspace).toMatchObject({
      workspaceId: graph.targetProjectWorkspaceId,
      projectId: graph.targetProjectId,
      projectName: "Target project",
    });
    expect(new Set(listed.body.items.map((item: { relativePath: string }) => item.relativePath))).toEqual(new Set([
      `${folderPath}README.md`,
      `${folderPath}suggestions.md`,
    ]));
    expect(JSON.stringify(listed.body)).not.toContain(root);
  });

  it("rejects ambiguous unhinted same-company project file matches", async () => {
    const { projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    const duplicateProjectId = crypto.randomUUID();
    const duplicateWorkspaceId = crypto.randomUUID();
    const duplicateRoot = path.join(path.dirname(targetProjectRoot), "duplicate-target");
    const targetPath = "docs/reference/skills.md";
    await fs.mkdir(path.join(targetProjectRoot, path.dirname(targetPath)), { recursive: true });
    await fs.writeFile(path.join(targetProjectRoot, targetPath), "# Target\n", "utf8");
    await fs.mkdir(path.join(duplicateRoot, path.dirname(targetPath)), { recursive: true });
    await fs.writeFile(path.join(duplicateRoot, targetPath), "# Duplicate\n", "utf8");
    await db.insert(projects).values({
      id: duplicateProjectId,
      companyId: graph.companyId,
      name: "Duplicate target",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: duplicateWorkspaceId,
      companyId: graph.companyId,
      projectId: duplicateProjectId,
      name: "Duplicate workspace",
      sourceType: "local_path",
      cwd: duplicateRoot,
      isPrimary: true,
    });

    await expect(workspaceFileResourceService(db).resolve(graph.issueId, {
      path: targetPath,
      workspace: "auto",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "ambiguous_workspace_path" },
    });
  });

  it("denies explicit cross-company project workspaces", async () => {
    const { projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({
        projectId: graph.otherProjectId,
        workspaceId: graph.otherProjectWorkspaceId,
        path: "README.md",
      });

    expect(res.status).toBe(403);
    expect(res.body?.details?.code).toBe("cross_company_workspace");
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const denied = rows.find((row) => row.action === "issue.file_resource_resolve_denied");
    expect(denied?.details).toMatchObject({
      outcome: "denied",
      projectId: graph.otherProjectId,
      workspaceId: graph.otherProjectWorkspaceId,
      denialReason: "cross_company_workspace",
    });
  });

  it("rejects explicit project/workspace mismatches", async () => {
    const { projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({
        projectId: graph.targetProjectId,
        workspaceId: graph.projectWorkspaceId,
        path: "README.md",
      });

    expect(res.status).toBe(422);
    expect(res.body?.details?.code).toBe("workspace_project_mismatch");
  });

  it("blocks symlink escapes from explicit cross-project workspaces", async () => {
    const { root, projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    await fs.writeFile(path.join(root, "outside-target.txt"), "secret\n", "utf8");
    await fs.symlink(path.join(root, "outside-target.txt"), path.join(targetProjectRoot, "escape.txt"));

    await expect(workspaceFileResourceService(db).readContent(graph.issueId, {
      projectId: graph.targetProjectId,
      workspaceId: graph.targetProjectWorkspaceId,
      path: "escape.txt",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "outside_workspace" },
    });
  });

  it("blocks symlink directory escapes from explicit cross-project workspaces", async () => {
    const { root, projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    const outsideDir = path.join(root, "outside-dir");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret\n", "utf8");
    await fs.symlink(outsideDir, path.join(targetProjectRoot, "escape-dir"));

    await expect(workspaceFileResourceService(db).resolve(graph.issueId, {
      projectId: graph.targetProjectId,
      workspaceId: graph.targetProjectWorkspaceId,
      path: "escape-dir/",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "outside_workspace" },
    });
  });

  it("resolves and reads video workspace files as base64 previews", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "demo.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));

    const resolved = await workspaceFileResourceService(db).resolve(graph.issueId, {
      path: "demo.mp4",
      workspace: "project",
    });
    expect(resolved.previewKind).toBe("video");
    expect(resolved.contentType).toBe("video/mp4");
    expect(resolved.capabilities.preview).toBe(true);

    const content = await workspaceFileResourceService(db).readContent(graph.issueId, {
      path: "demo.mp4",
      workspace: "project",
    });
    expect(content.resource.previewKind).toBe("video");
    expect(content.content.encoding).toBe("base64");
    expect(content.content.data).toBe(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]).toString("base64"));
  });

  it("lists and searches safe file candidates from the preferred execution workspace", async () => {
    const { root, projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.mkdir(path.join(executionRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(executionRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(executionRoot, "src", "app.ts"), "export const ok = true;\n", "utf8");
    await fs.writeFile(path.join(executionRoot, ".env"), "TOKEN=secret\n", "utf8");
    await fs.writeFile(path.join(executionRoot, "node_modules", "pkg", "index.ts"), "export {}\n", "utf8");
    await fs.writeFile(path.join(executionRoot, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(projectRoot, "src-project.ts"), "export const project = true;\n", "utf8");
    await fs.writeFile(path.join(root, "outside.ts"), "secret\n", "utf8");
    await fs.symlink(path.join(root, "outside.ts"), path.join(executionRoot, "escape.ts"));

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "auto", q: "src", limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("available");
    expect(res.body.workspace.workspaceKind).toBe("execution_workspace");
    expect(res.body.items.map((item: { displayPath: string }) => item.displayPath)).toEqual(["src/app.ts"]);
    expect(JSON.stringify(res.body)).not.toContain(root);
    expect(JSON.stringify(res.body)).not.toContain(".env");
    expect(JSON.stringify(res.body)).not.toContain("node_modules");
    expect(JSON.stringify(res.body)).not.toContain("escape.ts");
    expect(JSON.stringify(res.body)).not.toContain("blob.bin");
  });

  it("enforces default and hard list/search caps", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        fs.writeFile(
          path.join(projectRoot, `file-${String(index).padStart(2, "0")}.ts`),
          "export {}\n",
          "utf8",
        ),
      ),
    );
    const tooDeepDir = path.join(projectRoot, ...Array.from({ length: 21 }, (_, index) => `deep-${index}`));
    await fs.mkdir(tooDeepDir, { recursive: true });
    await fs.writeFile(path.join(tooDeepDir, "too-deep.ts"), "export const hidden = true;\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const defaultLimit = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "all" });
    expect(defaultLimit.status).toBe(200);
    expect(defaultLimit.body.query.limit).toBe(25);
    expect(defaultLimit.body.items).toHaveLength(25);
    expect(defaultLimit.body.truncated).toBe(true);

    const tooLargeLimit = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "all", limit: 101 });
    expect(tooLargeLimit.status).toBe(422);
    expect(tooLargeLimit.body?.details?.code).toBe("invalid_query");

    const tooDeep = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "all", q: "too-deep", limit: 100 });
    expect(tooDeep.status).toBe(200);
    expect(tooDeep.body.items).toEqual([]);
    expect(tooDeep.body.truncated).toBe(true);
  });

  it("lists one folder level at a time so deep descendants do not hide selected siblings", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.mkdir(path.join(projectRoot, "docs", "deep"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "docs", "selected.md"), "# Selected\n", "utf8");
    await Promise.all(
      Array.from({ length: 130 }, (_, index) =>
        fs.writeFile(
          path.join(projectRoot, "docs", "deep", `generated-${String(index).padStart(3, "0")}.md`),
          "# Generated\n",
          "utf8",
        ),
      ),
    );

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const parent = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", path: "docs", mode: "all", limit: 100 });

    expect(parent.status).toBe(200);
    expect(parent.body.query).toMatchObject({ path: "docs", mode: "all", offset: 0 });
    expect(parent.body.truncated).toBe(false);
    expect(parent.body.items.map((item: { kind: string; relativePath: string }) => `${item.kind}:${item.relativePath}`)).toEqual([
      "directory:docs/deep",
      "file:docs/selected.md",
    ]);

    const firstDeepPage = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", path: "docs/deep", mode: "all", limit: 100 });
    expect(firstDeepPage.status).toBe(200);
    expect(firstDeepPage.body.items).toHaveLength(100);
    expect(firstDeepPage.body.truncated).toBe(true);

    const secondDeepPage = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", path: "docs/deep", mode: "all", limit: 100, offset: 100 });
    expect(secondDeepPage.status).toBe(200);
    expect(secondDeepPage.body.query.offset).toBe(100);
    expect(secondDeepPage.body.items).toHaveLength(30);
    expect(secondDeepPage.body.truncated).toBe(false);
  });

  it("supports recent mode, limit caps, and list activity logging", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "old.ts"), "export const old = true;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "new.ts"), "export const newer = true;\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "recent", limit: 1 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.truncated).toBe(true);

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const listRead = rows.find((row) => row.action === "issue.file_resource_list");
    expect(listRead).toBeTruthy();
    expect(listRead?.details).toMatchObject({
      outcome: "success",
      workspaceSelector: "project",
      mode: "recent",
      resultCount: 1,
      truncated: true,
    });
    expect(JSON.stringify(listRead?.details)).not.toContain(projectRoot);
    expect(JSON.stringify(listRead?.details)).not.toContain("old.ts");
    expect(JSON.stringify(listRead?.details)).not.toContain("new.ts");
  });

  it("applies list offsets to search, recent, and changed modes", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await execFileAsync("git", ["-C", projectRoot, "init"]);
    await Promise.all([
      fs.writeFile(path.join(projectRoot, "alpha.ts"), "export const alpha = true;\n", "utf8"),
      fs.writeFile(path.join(projectRoot, "beta.ts"), "export const beta = true;\n", "utf8"),
      fs.writeFile(path.join(projectRoot, "gamma.ts"), "export const gamma = true;\n", "utf8"),
    ]);
    const older = new Date("2026-01-01T00:00:00.000Z");
    const middle = new Date("2026-01-02T00:00:00.000Z");
    const newer = new Date("2026-01-03T00:00:00.000Z");
    await fs.utimes(path.join(projectRoot, "alpha.ts"), older, older);
    await fs.utimes(path.join(projectRoot, "beta.ts"), middle, middle);
    await fs.utimes(path.join(projectRoot, "gamma.ts"), newer, newer);

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const searchPage = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", q: ".ts", limit: 1, offset: 1 });
    expect(searchPage.status).toBe(200);
    expect(searchPage.body.items.map((item: { relativePath: string }) => item.relativePath)).toEqual(["beta.ts"]);
    expect(searchPage.body.truncated).toBe(true);

    const recentPage = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "recent", limit: 1, offset: 1 });
    expect(recentPage.status).toBe(200);
    expect(recentPage.body.items.map((item: { relativePath: string }) => item.relativePath)).toEqual(["beta.ts"]);
    expect(recentPage.body.truncated).toBe(true);

    const changedPage = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", mode: "changed", limit: 1, offset: 1 });
    expect(changedPage.status).toBe(200);
    expect(changedPage.body.items.map((item: { relativePath: string }) => item.relativePath)).toEqual(["beta.ts"]);
    expect(changedPage.body.truncated).toBe(true);
  });

  it("rejects overlong list searches and redacts the raw query from denial audit details", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const rawQuery = "é".repeat(65);

    const res = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project", q: rawQuery });

    expect(res.status).toBe(422);
    expect(res.body?.details?.code).toBe("invalid_query");
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const denied = rows.find((row) => row.action === "issue.file_resource_list_denied");
    expect(denied?.details).toMatchObject({
      outcome: "denied",
      workspaceSelector: "project",
      mode: "all",
      denialReason: "invalid_query",
    });
    expect(JSON.stringify(denied?.details)).not.toContain(rawQuery);
  });

  it("rejects control characters in the path without crashing the audit log", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const nullByte = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=foo%00bar.ts`);
    expect(nullByte.status).toBe(422);
    expect(nullByte.body?.details?.code).toBe("invalid_path");

    const resolveNullByte = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve?workspace=project&path=foo%00bar.ts`);
    expect(resolveNullByte.status).toBe(422);
    expect(resolveNullByte.body?.details?.code).toBe("invalid_path");

    const otherControl = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=a%0Bb.ts`);
    expect(otherControl.status).toBe(422);
    expect(otherControl.body?.details?.code).toBe("invalid_path");
  });

  it("rejects traversal, encoded traversal, home-relative paths, backslash traversal, and double-encoding without double-decoding", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "safe.txt"), "safe\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    expect((await request(app).get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=..%2Fsecret.txt`)).status).toBe(403);
    expect((await request(app).get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=%2e%2e%2Fsecret.txt`)).status).toBe(403);
    expect((await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: "~/secret.txt" })).status).toBe(422);
    expect((await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: "..\\secret.txt" })).status).toBe(422);
    const doubleEncoded = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content?workspace=project&path=%252e%252e%252Fsecret.txt`);
    expect(doubleEncoded.status).toBe(404);
  });

  it("blocks symlink escapes and symlinks to denied sensitive files", async () => {
    const { root, projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(root, "outside-secret.txt"), "secret\n", "utf8");
    await fs.mkdir(path.join(projectRoot, "safe"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "safe", ".env"), "TOKEN=secret\n", "utf8");
    await fs.symlink(path.join(root, "outside-secret.txt"), path.join(projectRoot, "escape.txt"));
    await fs.symlink(path.join(projectRoot, "safe", ".env"), path.join(projectRoot, "linked-env"));

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const escape = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "escape.txt" });
    const linkedSecret = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "linked-env" });

    expect(escape.status).toBe(403);
    expect(linkedSecret.status).toBe(403);
  });

  it("rejects denied paths, non-regular files, oversized text and binary while returning HTML and SVG as text", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, ".git", "config"), "[core]\n", "utf8");
    await fs.mkdir(path.join(projectRoot, "folder"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "big.txt"), Buffer.alloc(WORKSPACE_FILE_TEXT_MAX_BYTES + 1, "a"));
    await fs.writeFile(path.join(projectRoot, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(projectRoot, "index.html"), "<script>alert(1)</script>", "utf8");
    await fs.writeFile(path.join(projectRoot, "icon.svg"), "<svg></svg>\n", "utf8");

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    for (const filePath of [".git/config", "folder", "big.txt", "blob.bin"]) {
      const res = await request(app)
        .get(`/api/issues/${graph.issueId}/file-resources/content`)
        .query({ workspace: "project", path: filePath });
      expect([403, 422]).toContain(res.status);
    }
    const svg = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "icon.svg" });
    expect(svg.status).toBe(200);
    expect(svg.body.resource.previewKind).toBe("text");
    expect(svg.body.content.data).toContain("<svg");
    const html = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "index.html" });
    expect(html.status).toBe(200);
    expect(html.headers["content-type"]).toContain("application/json");
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    expect(html.body.resource).toMatchObject({ contentType: "text/html", previewKind: "text", capabilities: { preview: true } });
    expect(html.body.content).toEqual({ encoding: "utf8", data: "<script>alert(1)</script>" });
    const downloaded = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ workspace: "project", path: "index.html", download: "1" });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers["content-disposition"]).toBe('attachment; filename="index.html"');
  });

  it("rejects remote workspaces without fetching provider resources", async () => {
    const { projectRoot } = await makeWorkspace();
    const graph = await seedGraph(db, {
      projectRoot,
      executionRoot: null,
      projectSourceType: "remote_managed",
    });

    const resolved = await workspaceFileResourceService(db).resolve(graph.issueId, {
      path: "README.md",
      workspace: "project",
    });
    expect(resolved.kind).toBe("remote_resource");
    expect(resolved.capabilities.preview).toBe(false);

    await expect(workspaceFileResourceService(db).readContent(graph.issueId, {
      path: "http://169.254.169.254/latest/meta-data/",
      workspace: "project",
    })).rejects.toMatchObject({ status: 422 });

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const listed = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/list`)
      .query({ workspace: "project" });
    expect(listed.status).toBe(200);
    expect(listed.body.state).toBe("unavailable");
    expect(listed.body.unavailableReason).toBe("remote_workspace");
    expect(listed.body.items).toEqual([]);
  });

  it("blocks agents and cross-company board users before content reads", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Secret\n", "utf8");
    const agentId = crypto.randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: graph.companyId,
      name: "File audit agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
    });

    const agentApp = createApp(db, {
      type: "agent",
      agentId,
      companyId: graph.companyId,
      source: "agent_key",
    });
    const boardApp = createApp(db, {
      type: "board",
      userId: "mallory",
      companyIds: [graph.otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    expect((await request(agentApp).get(`/api/issues/${graph.issueId}/file-resources/resolve`).query({ path: "README.md" })).status).toBe(403);
    expect((await request(boardApp).get(`/api/issues/${graph.issueId}/file-resources/resolve`).query({ path: "README.md" })).status).toBe(404);
    expect((await request(agentApp).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ path: "README.md" })).status).toBe(403);
    expect((await request(boardApp).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ path: "README.md" })).status).toBe(404);
    expect((await request(agentApp).get(`/api/issues/${graph.issueId}/file-resources/list`)).status).toBe(403);
    expect((await request(boardApp).get(`/api/issues/${graph.issueId}/file-resources/list`)).status).toBe(404);

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const listDenials = rows.filter((row) => row.action === "issue.file_resource_list_denied");
    const resolveDenials = rows.filter((row) => row.action === "issue.file_resource_resolve_denied");
    const contentDenials = rows.filter((row) => row.action === "issue.file_resource_content_denied");
    expect(listDenials).toHaveLength(2);
    expect(resolveDenials).toHaveLength(2);
    expect(contentDenials).toHaveLength(2);
    expect(JSON.stringify(listDenials.map((row) => row.details))).not.toContain("README.md");
    expect(JSON.stringify(rows.map((row) => row.details))).not.toContain(projectRoot);
  });

  it("logs successful content reads and denied security-relevant attempts", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Project\n", "utf8");
    await fs.writeFile(path.join(projectRoot, ".env"), "TOKEN=secret\n", "utf8");
    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: "README.md" });
    await request(app).get(`/api/issues/${graph.issueId}/file-resources/content`).query({ workspace: "project", path: ".env" });

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    expect(rows.some((row) => row.action === "issue.file_resource_content_read")).toBe(true);
    expect(rows.some((row) => row.action === "issue.file_resource_content_denied")).toBe(true);
    expect(JSON.stringify(rows.map((row) => row.details))).not.toContain(projectRoot);
  });

  it("logs successful resolves and resolve/content limiter denials", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Visible\n", "utf8");

    const app = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [graph.companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        limiter: createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 100, windowMs: 60_000 }),
      },
    );

    const resolved = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({ workspace: "project", path: "README.md" });
    expect(resolved.status).toBe(200);

    const rowsAfterResolve = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const resolveRead = rowsAfterResolve.find((row) => row.action === "issue.file_resource_resolve");
    expect(resolveRead?.details).toMatchObject({
      outcome: "success",
      workspaceKind: "project_workspace",
      displayPath: "README.md",
    });
    expect(JSON.stringify(resolveRead?.details)).not.toContain(projectRoot);

    let releaseSlowResolve: (() => void) | null = null;
    let slowResolveStarted: (() => void) | null = null;
    const slowResolve = new Promise<void>((resolve) => {
      releaseSlowResolve = resolve;
    });
    const resolveStarted = new Promise<void>((resolve) => {
      slowResolveStarted = resolve;
    });
    const resolveLimitedService: WorkspaceFileResourceService = {
      resolveIssueId: vi.fn(async (issueId: string) => issueId),
      getIssue: vi.fn(async () => ({ companyId: graph.companyId })),
      availability: vi.fn(async () => {
        throw new Error("not used");
      }),
      list: vi.fn(async () => {
        throw new Error("not used");
      }),
      resolve: vi.fn(async () => {
        slowResolveStarted?.();
        await slowResolve;
        return {
          kind: "file",
          provider: "local_fs",
          title: "README.md",
          displayPath: "README.md",
          workspaceLabel: "Workspace",
          workspaceKind: "project_workspace",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          previewKind: "text",
          capabilities: { preview: true, download: true, listChildren: false },
        };
      }),
      readContent: vi.fn(async () => {
        throw new Error("not used");
      }),
      prepareDownload: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const resolveLimitedApp = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [graph.companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        service: resolveLimitedService,
        limiter: createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 100, windowMs: 60_000 }),
      },
    );
    const firstResolve = request(resolveLimitedApp)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({ path: "README.md" });
    const firstResolveResponse = firstResolve.then((res) => res);
    await resolveStarted;
    const secondResolve = await request(resolveLimitedApp)
      .get(`/api/issues/${graph.issueId}/file-resources/resolve`)
      .query({ path: "README.md" });
    expect(secondResolve.status).toBe(429);
    releaseSlowResolve?.();
    expect((await firstResolveResponse).status).toBe(200);

    let releaseSlowContent: (() => void) | null = null;
    let slowContentStarted: (() => void) | null = null;
    const slowContent = new Promise<void>((resolve) => {
      releaseSlowContent = resolve;
    });
    const contentStarted = new Promise<void>((resolve) => {
      slowContentStarted = resolve;
    });
    const contentLimitedService: WorkspaceFileResourceService = {
      resolveIssueId: vi.fn(async (issueId: string) => issueId),
      getIssue: vi.fn(async () => ({ companyId: graph.companyId })),
      availability: vi.fn(async () => {
        throw new Error("not used");
      }),
      list: vi.fn(async () => {
        throw new Error("not used");
      }),
      resolve: vi.fn(async () => {
        throw new Error("not used");
      }),
      readContent: vi.fn(async () => {
        slowContentStarted?.();
        await slowContent;
        return {
          resource: {
            kind: "file",
            provider: "local_fs",
            title: "README.md",
            displayPath: "README.md",
            workspaceLabel: "Workspace",
            workspaceKind: "project_workspace",
            workspaceId: "11111111-1111-4111-8111-111111111111",
            previewKind: "text",
            capabilities: { preview: true, download: true, listChildren: false },
          },
          content: { encoding: "utf8", data: "# Visible\n" },
        };
      }),
      prepareDownload: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const contentLimitedApp = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [graph.companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        service: contentLimitedService,
        limiter: createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 100, windowMs: 60_000 }),
      },
    );
    const firstContent = request(contentLimitedApp)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ path: "README.md" });
    const firstContentResponse = firstContent.then((res) => res);
    await contentStarted;
    const secondContent = await request(contentLimitedApp)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ path: "README.md" });
    expect(secondContent.status).toBe(429);
    releaseSlowContent?.();
    expect((await firstContentResponse).status).toBe(200);

    const rowsAfterLimits = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    expect(rowsAfterLimits.some((row) => row.action === "issue.file_resource_resolve_denied")).toBe(true);
    expect(rowsAfterLimits.some((row) => row.action === "issue.file_resource_content_denied")).toBe(true);
    expect(JSON.stringify(rowsAfterLimits.map((row) => row.details))).not.toContain(projectRoot);
  });

  it("holds download concurrency slots until the file stream completes", async () => {
    if (process.platform === "win32") return;

    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    const fifoPath = path.join(projectRoot, "slow-download.bin");
    await execFileAsync("mkfifo", [fifoPath]);
    let slowDownloadStarted: (() => void) | null = null;
    const downloadStarted = new Promise<void>((resolve) => {
      slowDownloadStarted = resolve;
    });
    const service: WorkspaceFileResourceService = {
      resolveIssueId: vi.fn(async (issueId: string) => issueId),
      getIssue: vi.fn(async () => ({ companyId: graph.companyId })),
      availability: vi.fn(async () => {
        throw new Error("not used");
      }),
      list: vi.fn(async () => {
        throw new Error("not used");
      }),
      resolve: vi.fn(async () => {
        throw new Error("not used");
      }),
      readContent: vi.fn(async () => {
        throw new Error("not used");
      }),
      prepareDownload: vi.fn(async () => {
        slowDownloadStarted?.();
        return {
          resource: {
            kind: "file",
            provider: "local_fs",
            title: "slow-download.bin",
            displayPath: "slow-download.bin",
            workspaceLabel: "Workspace",
            workspaceKind: "project_workspace",
            workspaceId: "11111111-1111-4111-8111-111111111111",
            previewKind: "unsupported",
            contentType: "application/octet-stream",
            byteSize: null,
            capabilities: { preview: false, download: true, listChildren: false },
          },
          realPath: fifoPath,
        };
      }),
    };
    const app = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [graph.companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        service,
        limiter: createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 100, windowMs: 60_000 }),
      },
    );
    const firstDownload = request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ path: "slow-download.bin", download: "1" })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    const firstDownloadResponse = firstDownload.then((res) => res);

    await downloadStarted;
    await new Promise((resolve) => setImmediate(resolve));

    const secondDownload = await request(app)
      .get(`/api/issues/${graph.issueId}/file-resources/content`)
      .query({ path: "slow-download.bin", download: "1" });
    expect(secondDownload.status).toBe(429);

    const writer = await fs.open(fifoPath, "w");
    await writer.write(Buffer.from("slow"));
    await writer.close();

    const first = await firstDownloadResponse;
    expect(first.status).toBe(200);
    expect(first.headers["content-length"]).toBeUndefined();
    expect(first.headers["content-disposition"]).toBe('attachment; filename="slow-download.bin"');
    expect(Buffer.compare(first.body as Buffer, Buffer.from("slow"))).toBe(0);
  });

  it("uses tighter list-specific rate and concurrency limits", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    let releaseSlowList: (() => void) | null = null;
    let slowListStarted: (() => void) | null = null;
    const slowList = new Promise<void>((resolve) => {
      releaseSlowList = resolve;
    });
    const listStarted = new Promise<void>((resolve) => {
      slowListStarted = resolve;
    });
    const service: WorkspaceFileResourceService = {
      resolveIssueId: vi.fn(async (issueId: string) => issueId),
      getIssue: vi.fn(async () => ({ companyId: graph.companyId })),
      availability: vi.fn(async () => {
        throw new Error("not used");
      }),
      list: vi.fn(async () => {
        slowListStarted?.();
        await slowList;
        return {
          kind: "workspace_file_list",
          state: "available",
          workspace: {
            provider: "local_fs",
            workspaceLabel: "Workspace",
            workspaceKind: "project_workspace",
            workspaceId: "11111111-1111-4111-8111-111111111111",
          },
          query: {
            workspace: "auto",
            mode: "all",
            q: null,
            limit: 25,
          },
          items: [],
          scannedCount: 0,
          truncated: false,
        };
      }),
      resolve: vi.fn(async () => {
        throw new Error("not used");
      }),
      readContent: vi.fn(async () => {
        throw new Error("not used");
      }),
      prepareDownload: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const app = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [graph.companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        service,
        listLimiter: createFileResourceListLimiter({ maxConcurrent: 1, maxRequests: 2, windowMs: 60_000 }),
      },
    );

    const first = request(app).get(`/api/issues/${graph.issueId}/file-resources/list`);
    const firstResponse = first.then((res) => res);
    await listStarted;
    const second = await request(app).get(`/api/issues/${graph.issueId}/file-resources/list`);
    expect(second.status).toBe(429);
    releaseSlowList?.();
    expect((await firstResponse).status).toBe(200);
    const third = await request(app).get(`/api/issues/${graph.issueId}/file-resources/list`);
    expect(third.status).toBe(429);
  });

  it("returns mixed deduplicated availability results with one aggregate audit event", async () => {
    const { root, projectRoot, targetProjectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, {
      projectRoot,
      targetProjectRoot,
      executionRoot,
      targetProjectSourceType: "remote_managed",
    });
    await fs.mkdir(path.join(projectRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "README.md"), "# Visible\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "docs", "guide.md"), "# Guide\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "archive.bin"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(projectRoot, "large.txt"), Buffer.alloc(WORKSPACE_FILE_TEXT_MAX_BYTES + 1, "a"));
    await fs.writeFile(path.join(projectRoot, ".env"), "TOKEN=secret\n", "utf8");
    await fs.writeFile(path.join(root, "outside-secret.txt"), "outside\n", "utf8");
    await fs.symlink(path.join(root, "outside-secret.txt"), path.join(projectRoot, "escape.txt"));

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const response = await request(app)
      .post(`/api/issues/${graph.issueId}/file-resources/availability`)
      .send({
        queries: [
          { workspace: "project", path: "README.md" },
          { workspace: "project", path: "./README.md" },
          { workspace: "project", path: "docs/" },
          { workspace: "project", path: "archive.bin" },
          { workspace: "project", path: "large.txt" },
          { workspace: "project", path: ".env" },
          { workspace: "project", path: "../outside-secret.txt" },
          { workspace: "project", path: path.join(root, "host-secret.txt") },
          { workspace: "project", path: "escape.txt" },
          { workspace: "project", path: "missing.ts" },
          {
            workspace: "project",
            projectId: graph.targetProjectId,
            workspaceId: graph.targetProjectWorkspaceId,
            path: "remote.txt",
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.kind).toBe("workspace_file_availability");
    expect(response.body.results).toHaveLength(10);
    const byPath = new Map(response.body.results.map((result: { query: { path: string } }) => [result.query.path, result]));
    expect(byPath.get("README.md")).toMatchObject({ openable: true, resource: { kind: "file" } });
    expect(byPath.get("docs/")).toMatchObject({ openable: true, resource: { kind: "directory" } });
    expect(byPath.get("archive.bin")).toMatchObject({ openable: false, unavailableReason: "unsupported_content" });
    expect(byPath.get("large.txt")).toMatchObject({ openable: false, unavailableReason: "too_large" });
    expect(byPath.get(".env")).toMatchObject({ openable: false, unavailableReason: "denied_secret", resource: null });
    expect(byPath.get("../outside-secret.txt")).toMatchObject({
      openable: false,
      unavailableReason: "outside_workspace",
      resource: null,
    });
    expect(byPath.get("host-secret.txt")).toMatchObject({
      openable: false,
      unavailableReason: "invalid_path",
      resource: null,
    });
    expect(byPath.get("escape.txt")).toMatchObject({
      openable: false,
      unavailableReason: "outside_workspace",
      resource: null,
    });
    expect(byPath.get("missing.ts")).toMatchObject({ openable: false, unavailableReason: "not_found", resource: null });
    expect(byPath.get("remote.txt")).toMatchObject({
      openable: false,
      unavailableReason: "remote_workspace",
      resource: { kind: "remote_resource" },
    });
    expect(JSON.stringify(response.body)).not.toContain(root);

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, graph.issueId));
    const availabilityRows = rows.filter((row) => row.action === "issue.file_resource_availability");
    expect(availabilityRows).toHaveLength(1);
    expect(availabilityRows[0]?.details).toMatchObject({
      outcome: "success",
      requestedCount: 11,
      uniqueCount: 10,
      openableCount: 2,
      unavailableCount: 8,
    });
    expect(JSON.stringify(availabilityRows[0]?.details)).not.toContain(root);
  });

  it("reports ambiguous auto-discovery as one unavailable result", async () => {
    const { projectRoot, targetProjectRoot, executionRoot, root } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, targetProjectRoot, executionRoot });
    const extraRoot = path.join(root, "extra-project");
    await fs.mkdir(extraRoot, { recursive: true });
    await fs.writeFile(path.join(targetProjectRoot, "shared.md"), "target\n", "utf8");
    await fs.writeFile(path.join(extraRoot, "shared.md"), "extra\n", "utf8");
    const extraProjectId = crypto.randomUUID();
    await db.insert(projects).values({
      id: extraProjectId,
      companyId: graph.companyId,
      name: "Extra project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: crypto.randomUUID(),
      companyId: graph.companyId,
      projectId: extraProjectId,
      name: "Extra workspace",
      sourceType: "local_path",
      cwd: extraRoot,
      isPrimary: true,
    });

    const app = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const response = await request(app)
      .post(`/api/issues/${graph.issueId}/file-resources/availability`)
      .send({ queries: [{ path: "shared.md" }] });

    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([
      {
        query: { path: "shared.md", workspace: "auto", projectId: null, workspaceId: null },
        openable: false,
        unavailableReason: "ambiguous_workspace_path",
        resource: null,
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain(root);
  });

  it("enforces board access, company boundaries, and the 100-query cap", async () => {
    const { projectRoot, executionRoot } = await makeWorkspace();
    const graph = await seedGraph(db, { projectRoot, executionRoot });
    const agentId = crypto.randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: graph.companyId,
      name: "Availability audit agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
    });
    const agentApp = createApp(db, {
      type: "agent",
      agentId,
      companyId: graph.companyId,
      source: "agent_key",
    });
    const otherCompanyApp = createApp(db, {
      type: "board",
      userId: "other-board",
      companyIds: [graph.otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const boardApp = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [graph.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    expect((await request(agentApp)
      .post(`/api/issues/${graph.issueId}/file-resources/availability`)
      .send({ queries: [{ path: "README.md" }] })).status).toBe(403);
    expect((await request(otherCompanyApp)
      .post(`/api/issues/${graph.issueId}/file-resources/availability`)
      .send({ queries: [{ path: "README.md" }] })).status).toBe(404);
    expect((await request(boardApp)
      .post(`/api/issues/${graph.issueId}/file-resources/availability`)
      .send({ queries: Array.from({ length: 101 }, (_, index) => ({ path: `file-${index}.ts` })) })).status).toBe(400);
  });
});

describeEmbeddedPostgres("file resource route guards", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-file-resource-guards-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("enforces bounded rate and concurrency limits", async () => {
    const companyId = crypto.randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Rate limit company",
      issuePrefix: "RAT",
    });
    let releaseSlowRead: (() => void) | null = null;
    let slowReadStarted: (() => void) | null = null;
    const slowRead = new Promise<void>((resolve) => {
      releaseSlowRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      slowReadStarted = resolve;
    });
    const service: WorkspaceFileResourceService = {
      resolveIssueId: vi.fn(async (issueId: string) => issueId),
      getIssue: vi.fn(async () => ({ companyId })),
      availability: vi.fn(async () => {
        throw new Error("not used");
      }),
      list: vi.fn(async () => {
        throw new Error("not used");
      }),
      resolve: vi.fn(async () => {
        slowReadStarted?.();
        await slowRead;
        return {
          kind: "file",
          provider: "local_fs",
          title: "README.md",
          displayPath: "README.md",
          workspaceLabel: "Workspace",
          workspaceKind: "project_workspace",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          previewKind: "text",
          capabilities: { preview: true, download: true, listChildren: false },
        };
      }),
      readContent: vi.fn(async () => {
        throw new Error("not used");
      }),
      prepareDownload: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", fileResourceRoutes(db, {
      service,
      limiter: createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 2, windowMs: 60_000 }),
    }));
    app.use(errorHandler);

    const first = request(app).get("/api/issues/issue-1/file-resources/resolve").query({ path: "README.md" });
    const firstResponse = first.then((res) => res);
    await readStarted;
    const second = await request(app).get("/api/issues/issue-1/file-resources/resolve").query({ path: "README.md" });
    expect(second.status).toBe(429);
    releaseSlowRead?.();
    expect((await firstResponse).status).toBe(200);
    const third = await request(app).get("/api/issues/issue-1/file-resources/resolve").query({ path: "README.md" });
    expect(third.status).toBe(429);
  });

  it("uses a batch-specific availability limiter", async () => {
    const companyId = crypto.randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Availability rate limit company",
      issuePrefix: "AVL",
    });
    let releaseSlowAvailability: (() => void) | null = null;
    let slowAvailabilityStarted: (() => void) | null = null;
    const slowAvailability = new Promise<void>((resolve) => {
      releaseSlowAvailability = resolve;
    });
    const availabilityStarted = new Promise<void>((resolve) => {
      slowAvailabilityStarted = resolve;
    });
    const service: WorkspaceFileResourceService = {
      resolveIssueId: vi.fn(async (issueId: string) => issueId),
      getIssue: vi.fn(async () => ({ companyId })),
      availability: vi.fn(async () => {
        slowAvailabilityStarted?.();
        await slowAvailability;
        return { kind: "workspace_file_availability", results: [] };
      }),
      list: vi.fn(async () => { throw new Error("not used"); }),
      resolve: vi.fn(async () => { throw new Error("not used"); }),
      readContent: vi.fn(async () => { throw new Error("not used"); }),
      prepareDownload: vi.fn(async () => { throw new Error("not used"); }),
    };
    const app = createApp(
      db,
      {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        service,
        availabilityLimiter: createFileResourceAvailabilityLimiter({
          maxConcurrent: 1,
          maxRequests: 2,
          windowMs: 60_000,
        }),
      },
    );

    const firstRequest = request(app)
      .post("/api/issues/issue-availability/file-resources/availability")
      .send({ queries: [{ path: "README.md" }] });
    const firstResponse = firstRequest.then((response) => response);
    await availabilityStarted;
    expect((await request(app)
      .post("/api/issues/issue-availability/file-resources/availability")
      .send({ queries: [{ path: "README.md" }] })).status).toBe(429);
    releaseSlowAvailability?.();
    expect((await firstResponse).status).toBe(200);
    expect((await request(app)
      .post("/api/issues/issue-availability/file-resources/availability")
      .send({ queries: [{ path: "README.md" }] })).status).toBe(429);
  });
});
