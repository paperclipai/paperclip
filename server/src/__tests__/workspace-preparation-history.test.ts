import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, executionWorkspaceRepositories, executionWorkspaceRepositoryRoots, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { authorizationService, canActorReadExecutionWorkspace } from "../services/authorization.js";
import { assertExecutionWorkspaceRecordAccess, assertTaskWorkspaceExecutionAccess } from "../services/task-workspace-access.js";
import { executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { taskWorkspaceRoutes } from "../routes/task-workspaces.js";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addPoisonedWorkspaceHistory, addReadyWorkspaceHistoryRepository, createWorkspacePreparationHistoryFixture } from "./helpers/workspace-preparation-history-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("filesystem history is not execution authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  let fixture: Awaited<ReturnType<typeof createWorkspacePreparationHistoryFixture>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    database = await startEmbeddedPostgresTestDatabase("workspace-preparation-history-regression-");
    db = createDb(database.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-preparation-history-regression-"));
    fixture = await createWorkspacePreparationHistoryFixture(db, path.join(directory, "private-shared-source"), {
      workspaces: 40, sharedRoots: 20, sources: 30, readers: 8, privateHistory: true,
    });
    await addPoisonedWorkspaceHistory(db, fixture);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  function record() {
    const queries: string[] = [];
    const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: query => queries.push(query) } }) as unknown as typeof db;
    return { queries, recorded, service: executionWorkspaceRepositoryService(recorded) };
  }

  function expectNoHistory(queries: string[]) {
    expect(queries.filter(query => /execution_workspace_repository_(?:access|roots)/.test(query))).toEqual([]);
    expect(queries.filter(query => /from "heartbeat_runs"/.test(query) && /\bin\s*\(/i.test(query))).toEqual([]);
    expect(queries.filter(query => /from "(?:execution_workspaces|project_workspaces)"/.test(query)
      && !/"(?:execution_workspaces|project_workspaces)"\."id"\s*=/.test(query))).toEqual([]);
  }

  it("admits the current task despite private sources, deleted readers and a sticky root classification", async () => {
    const { queries, recorded, service } = record();
    await expect(assertTaskWorkspaceExecutionAccess(recorded, fixture.actor, fixture.companyId, {
      issueId: fixture.issueId, workspaceId: fixture.workspaceId,
    })).resolves.toMatchObject({ task: { id: fixture.issueId }, workspace: { id: fixture.workspaceId } });
    await expect(service.prepareForAdmission(fixture.input)).resolves.toEqual([]);
    await expect(service.assertPublicationAllowed(fixture.input)).resolves.toBeUndefined();
    await expect(service.assertRecoveryBinding(fixture.input)).resolves.toBeUndefined();
    const recheck = await service.prepareConfiguredRepositoryCopy({ ...fixture.input, sourceCwd: fixture.cwd });
    await expect(recheck()).resolves.toBeUndefined();
    expectNoHistory(queries);
    expect(await fs.readFile(path.join(fixture.cwd, "result.txt"), "utf8")).toBe("Synthetic task workspace\n");
  });

  it("keeps historical task content and full workspace records private", async () => {
    const authorization = authorizationService(db);
    const decision = await authorization.decide({ actor: fixture.actor, action: "issue:read",
      resource: { type: "issue", companyId: fixture.companyId, issueId: fixture.historyTaskIds[0] } });
    expect(decision.allowed).toBe(false);
    expect(await canActorReadExecutionWorkspace(db, fixture.actor, fixture.workspaceId)).toBe(false);
    await expect(assertExecutionWorkspaceRecordAccess(db, fixture.actor, fixture.companyId, fixture.workspaceId)).rejects.toThrow();
  });

  it.each(["task_directory", "configured_source", "existing"] as const)("applies a saved %s selection after the old workspace source becomes private", async kind => {
    const current = await createWorkspacePreparationHistoryFixture(db, path.join(directory, `escape-${kind}`), {
      workspaces: 0, sharedRoots: 0, sources: 0, readers: 0,
    });
    const [oldProject, nextProject] = await db.insert(projects).values([
      { companyId: current.companyId, name: "Old source" }, { companyId: current.companyId, name: "New source" },
    ]).returning();
    const [oldSource, nextSource] = await db.insert(projectWorkspaces).values([
      { companyId: current.companyId, projectId: oldProject.id, name: "Old source", cwd: current.cwd },
      { companyId: current.companyId, projectId: nextProject.id, name: "New source", cwd: current.cwd },
    ]).returning();
    await db.update(issues).set({ projectWorkspaceId: oldSource.id }).where(eq(issues.id, current.issueId));
    await db.update(executionWorkspaces).set({ projectId: oldProject.id, projectWorkspaceId: oldSource.id })
      .where(eq(executionWorkspaces.id, current.workspaceId));
    const [nextWorkspace] = await db.insert(executionWorkspaces).values({ companyId: current.companyId, name: "New workspace",
      sourceIssueId: current.issueId, cwd: current.cwd, mode: "shared_workspace", strategyType: "task_directory" }).returning();
    const selection = kind === "task_directory" ? { kind } : kind === "existing" ? { kind, workspaceId: nextWorkspace.id }
      : { kind, projectWorkspaceId: nextSource.id, mode: "shared" as const };
    const service = executionWorkspaceService(db);
    await service.selectTaskWorkspace({ companyId: current.companyId, issueId: current.issueId, actor: current.actor,
      selection, expectedBindingRevision: 0, requestKey: randomUUID() });
    await db.update(projects).set({ visibility: "private", privacyOwnerUserId: current.principals[1].userId })
      .where(eq(projects.id, oldProject.id));
    await expect(assertTaskWorkspaceExecutionAccess(db, current.actor, current.companyId, {
      issueId: current.issueId, projectWorkspaceId: null,
    })).rejects.toThrow();
    await expect(service.applyPendingTaskWorkspaceSelection({ ...current.input, actor: current.actor })).resolves.toBe(true);
    const [task] = await db.select().from(issues).where(eq(issues.id, current.issueId));
    expect(task).toMatchObject({ projectId: null, workspacePendingSelection: null, workspaceSelection: { selection },
      executionWorkspaceId: kind === "existing" ? nextWorkspace.id : null,
      projectWorkspaceId: kind === "configured_source" ? nextSource.id : null });
  });

  it("accepts only persisted selection context and keeps current-task and new-source authorization", async () => {
    const current = await createWorkspacePreparationHistoryFixture(db, path.join(directory, "selection-authority"), {
      workspaces: 0, sharedRoots: 0, sources: 0, readers: 0,
    });
    const taskDirectory = { kind: "task_directory" as const };
    const context = { issueId: current.issueId, persistedSelection: taskDirectory };
    await expect(assertTaskWorkspaceExecutionAccess(db, current.actor, current.companyId, context))
      .rejects.toThrow("not a current persisted intent");
    await db.update(issues).set({ workspacePendingSelection: { version: 1, requestKey: "stale", expectedBindingRevision: 1,
      intent: { version: 1, source: "explicit", selection: taskDirectory } } }).where(eq(issues.id, current.issueId));
    await expect(assertTaskWorkspaceExecutionAccess(db, current.actor, current.companyId, context))
      .rejects.toThrow("not a current persisted intent");
    await db.update(issues).set({ workspacePendingSelection: null }).where(eq(issues.id, current.issueId));
    const service = executionWorkspaceService(db);
    await service.selectTaskWorkspace({ companyId: current.companyId, issueId: current.issueId, actor: current.actor,
      selection: taskDirectory, expectedBindingRevision: 0, requestKey: randomUUID() });
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: current.issueId,
      responsibleUserId: current.principals[1].userId }).where(eq(issues.id, current.issueId));
    await expect(service.applyPendingTaskWorkspaceSelection({ ...current.input, actor: current.actor })).rejects.toThrow();
    await db.update(issues).set({ visibility: "open", privacyRootIssueId: null, responsibleUserId: current.userId })
      .where(eq(issues.id, current.issueId));
    const [project] = await db.insert(projects).values({ companyId: current.companyId, name: "Next source" }).returning();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: current.companyId, projectId: project.id,
      name: "Next source", cwd: current.cwd }).returning();
    await service.selectTaskWorkspace({ companyId: current.companyId, issueId: current.issueId, actor: current.actor,
      selection: { kind: "configured_source", projectWorkspaceId: source.id, mode: "shared" },
      expectedBindingRevision: 1, requestKey: randomUUID() });
    await db.update(projects).set({ visibility: "private", privacyOwnerUserId: current.principals[1].userId })
      .where(eq(projects.id, project.id));
    await expect(service.applyPendingTaskWorkspaceSelection({ ...current.input, actor: current.actor })).rejects.toThrow();
  });

  it("routes current-task repository requests and new selections independently from full workspace disclosure", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: fixture.userId, companyIds: [fixture.companyId] };
      next();
    });
    app.use("/api", taskWorkspaceRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    const endpoint = `/api/issues/${fixture.issueId}/workspace`;
    const hidden = await request(app).get(endpoint);
    expect({ status: hidden.status, body: hidden.body }).toMatchObject({ status: 404 });
    let repositoryId: string | undefined;
    try {
      const repository = await request(app).post(`${endpoint}/repositories`).send({
        repository: { kind: "url", url: "https://github.com/paperclip-synthetic/route-request" }, requestKey: randomUUID(),
      }).expect(200);
      repositoryId = repository.body.operationId;
      expect(repository.body.kind).toBe("requires_next_admission");
      await request(app).put(endpoint).send({ selection: { kind: "existing", workspaceId: fixture.workspaceId },
        expectedBindingRevision: 0, requestKey: randomUUID() }).expect(404);
      const selection = await request(app).put(endpoint).send({ selection: { kind: "task_directory" },
        expectedBindingRevision: 0, requestKey: randomUUID() }).expect(200);
      expect(selection.body).toMatchObject({ kind: "scheduled", applies: "next_normal_admission" });
      await request(app).get(endpoint).expect(404);
    } finally {
      if (repositoryId) await db.delete(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, repositoryId));
      await db.update(issues).set({ workspacePendingSelection: null, workspaceBindingRevision: 0 })
        .where(eq(issues.id, fixture.issueId));
    }
  });

  it("rejects invalid current run, company and workspace bindings without consulting history", async () => {
    for (const change of [
      { runId: randomUUID() },
      { workspaceId: fixture.foreignWorkspaceId },
      { companyId: fixture.foreignCompanyId },
      { responsibleUserId: fixture.principals[1].userId },
      { responsibleUserId: null },
    ]) {
      const { queries, service } = record();
      await expect(service.prepareForAdmission({ ...fixture.input, ...change })).rejects.toThrow();
      expectNoHistory(queries);
    }
  });

  it("requires access to the directly selected private project", async () => {
    const [project] = await db.insert(projects).values({ companyId: fixture.companyId, name: "Private selected configuration",
      visibility: "private", privacyOwnerUserId: fixture.principals[1].userId }).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, fixture.issueId));
    try {
      const { queries, service } = record();
      await expect(service.prepareForAdmission(fixture.input)).rejects.toThrow();
      expectNoHistory(queries);
    } finally {
      await db.update(issues).set({ projectId: null }).where(eq(issues.id, fixture.issueId));
    }
  });

  it("rechecks the current task's private app access", async () => {
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: fixture.issueId,
      responsibleUserId: fixture.principals[1].userId }).where(eq(issues.id, fixture.issueId));
    try {
      await expect(executionWorkspaceRepositoryService(db).prepareForAdmission(fixture.input)).rejects.toThrow();
    } finally {
      await db.update(issues).set({ visibility: "open", privacyRootIssueId: null, responsibleUserId: fixture.userId })
        .where(eq(issues.id, fixture.issueId));
    }
  });

  it("permits a current trusted repository request despite a historical anonymous-only root", async () => {
    const { queries, service } = record();
    const intent = await service.request({ companyId: fixture.companyId, issueId: fixture.issueId, actor: fixture.actor,
      request: { repository: { kind: "url", url: "https://github.com/paperclip-synthetic/new-current-request" }, requestKey: randomUUID() } });
    expect(intent.kind).toBe("requires_next_admission");
    expectNoHistory(queries);
    await db.delete(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, intent.operationId));
  });

  it("keeps current low-trust acquisition restrictions even though directory policy is retired", async () => {
    const intent = await executionWorkspaceRepositoryService(db).request({ companyId: fixture.companyId, issueId: fixture.issueId,
      actor: fixture.actor, request: { repository: { kind: "url", url: "https://github.com/paperclip-synthetic/low-trust-request" },
        requestKey: randomUUID() } });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: fixture.issueId, executionPolicy: {
      trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: {
        mode: "low_trust_review", companyId: fixture.companyId, rootIssueId: fixture.issueId,
      } },
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    try {
      const { queries, service } = record();
      await expect(service.prepareForAdmission(fixture.input)).rejects.toThrow(/trusted task|acquisition|Low-trust/);
      expectNoHistory(queries);
    } finally {
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: fixture.issueId } }).where(eq(heartbeatRuns.id, fixture.runId));
      await db.delete(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, intent.operationId));
    }
  });

  it("admits current low-trust execution with no acquisition despite a historical managed directory", async () => {
    await db.update(executionWorkspaceRepositoryRoots).set({ mode: "managed" })
      .where(eq(executionWorkspaceRepositoryRoots.companyId, fixture.companyId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: fixture.issueId, executionPolicy: {
      trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: {
        mode: "low_trust_review", companyId: fixture.companyId, rootIssueId: fixture.issueId,
      } },
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    try {
      const { queries, service } = record();
      await expect(service.prepareForAdmission(fixture.input)).resolves.toEqual([]);
      expectNoHistory(queries);
    } finally {
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: fixture.issueId } }).where(eq(heartbeatRuns.id, fixture.runId));
      await db.update(executionWorkspaceRepositoryRoots).set({ mode: "anonymous_only" })
        .where(eq(executionWorkspaceRepositoryRoots.companyId, fixture.companyId));
    }
  });

  it("surfaces an actual source OS failure without a historical-privacy fallback", async () => {
    const actual = fs.realpath;
    vi.spyOn(fs, "realpath").mockImplementation((async pathname => {
      if (String(pathname) === fixture.cwd) throw Object.assign(new Error("Synthetic OS denied selected source"), { code: "EACCES" });
      return actual(pathname);
    }) as typeof fs.realpath);
    await expect(executionWorkspaceRepositoryService(db).prepareConfiguredRepositoryCopy({ ...fixture.input, sourceCwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "EACCES" });
  });

  it("reuses a real public checkout whose exact ownership receipt belongs to an unreadable historical task", async () => {
    const ready = await addReadyWorkspaceHistoryRepository(db, fixture, { matchingHistoricalReceipts: true });
    try {
      const { queries, service } = record();
      await expect(service.prepareForAdmission(fixture.input)).resolves.toEqual([
        expect.objectContaining({ id: ready.row.id, cwd: ready.checkout, pinnedCommit: fixture.pin }),
      ]);
      expectNoHistory(queries);
    } finally { await db.delete(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, ready.row.id)); }
  });

  it("keeps SQL and path-check counts fixed when unrelated history grows to thousands of workspaces", async () => {
    const cases = [
      { workspaces: 8, sharedRoots: 5, sources: 6, readers: 2 },
      { workspaces: 2500, sharedRoots: 1500, sources: 1700, readers: 50 },
    ];
    const observations = [];
    for (const [index, config] of cases.entries()) {
      const current = await createWorkspacePreparationHistoryFixture(db, path.join(directory, `query-count-${index}`), config);
      const { queries, service } = record();
      const paths = vi.spyOn(fs, "realpath");
      await service.prepareForAdmission(current.input);
      await service.assertPublicationAllowed(current.input);
      const guard = await service.prepareConfiguredRepositoryCopy({ ...current.input, sourceCwd: current.cwd });
      await guard();
      await service.assertRecoveryBinding(current.input);
      observations.push({ queries: queries.length, paths: paths.mock.calls.length });
      expectNoHistory(queries);
      expect(paths.mock.calls.map(call => String(call[0])).every(value => value === current.cwd || value.startsWith(`${current.cwd}${path.sep}`))).toBe(true);
      paths.mockRestore();
    }
    expect(observations[1]).toEqual(observations[0]);
  }, 60_000);
});
