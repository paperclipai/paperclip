import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { expect, it } from "vitest";
import {
  activityLog,
  agents,
  createDb,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

type Db = ReturnType<typeof createDb>;

/**
 * A shared_workspace-mode project's serialize gate
 * (`heartbeat.ts`'s `findSharedWorkspaceHolder` call) only runs for an issue
 * that carries `projectWorkspaceId`. An issue an agent creates for itself
 * mid-run — a self-raised follow-up or independent check, with no `parentId`
 * naming an already-bound issue — has to get that binding from somewhere.
 * `resolveRunIssueWorkspaceInheritanceSource` in `routes/issues.ts` is the
 * mechanism: it looks at the *creating run's own issue* and, if that issue is
 * itself project-bound, carries the binding onto the new issue.
 *
 * These tests exercise the real HTTP route end to end (embedded Postgres, no
 * mocks) and cover the two ways that mechanism went silently inert:
 *
 *   1. `hasExplicitIssueWorkspaceCreateSelection` treated an explicit
 *      `parentId: null` — an ordinary way for a JSON client to say "no
 *      parent" — the same as a caller naming a real parent, and skipped
 *      run-based inheritance entirely.
 *   2. The same function additionally required the run's context snapshot to
 *      already carry `executionWorkspaceId`, a field that is not the one the
 *      shared-workspace serialize gate reads and is not guaranteed to be
 *      present yet when an agent's very first turn creates an issue.
 */
function agentActorApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: (req.headers["x-test-agent-id"] as string) ?? undefined,
      companyId: (req.headers["x-test-company-id"] as string) ?? undefined,
      runId: (req.headers["x-test-run-id"] as string) ?? undefined,
      keyId: randomUUID(),
      source: "agent_key",
    };
    next();
  });
  app.use("/api", issueRoutes(db, {} as never));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("issue create inherits the creating run's project workspace", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-run-workspace-inheritance-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(projectWorkspaces);
      await db.delete(projects);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Run workspace inheritance");
    const companyId = company.companyId;

    const projectId = randomUUID();
    await ctx.db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Bound project",
      executionWorkspacePolicy: {
        enabled: true,
        sharedWorkspaceConcurrency: "serialize",
        defaultMode: "shared_workspace",
        allowIssueOverride: false,
      },
    });

    const projectWorkspaceId = randomUUID();
    await ctx.db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "primary",
      sourceType: "local_path",
      isPrimary: true,
    });

    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Self-check agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // The run's OWN issue: already bound, exactly as an agent's assigned
    // work-package issue would be after the project's shared workspace has
    // been established for it.
    const currentIssueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: currentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Assigned work package",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    // A second, unrelated bound issue, to prove an explicit parentId still
    // wins over run-based inheritance rather than being ignored.
    const otherBoundIssueId = randomUUID();
    const otherProjectWorkspaceId = randomUUID();
    await ctx.db.insert(projectWorkspaces).values({
      id: otherProjectWorkspaceId,
      companyId,
      projectId,
      name: "other",
      sourceType: "local_path",
      isPrimary: false,
    });
    await ctx.db.insert(issues).values({
      id: otherBoundIssueId,
      companyId,
      projectId,
      projectWorkspaceId: otherProjectWorkspaceId,
      title: "Other bound issue",
      status: "todo",
      priority: "medium",
    });

    return {
      companyId,
      projectId,
      projectWorkspaceId,
      agentId,
      currentIssueId,
      otherBoundIssueId,
      otherProjectWorkspaceId,
    };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  /**
   * `contextSnapshot` intentionally carries only `issueId` — no
   * `executionWorkspaceId` — mirroring a run early in its lifecycle, before
   * (or without) whatever later step in the dispatch flow might populate
   * that field. This is the shape `resolveRunIssueWorkspaceInheritanceSource`
   * silently refused to act on before this fix.
   */
  async function seedRun(seeded: Seeded, contextSnapshot: Record<string, unknown>) {
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({
      id: runId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "running",
      contextSnapshot,
    });
    return runId;
  }

  function postIssue(seeded: Seeded, runId: string, body: Record<string, unknown>) {
    return request(agentActorApp(ctx.db))
      .post(`/api/companies/${seeded.companyId}/issues`)
      .set("x-test-agent-id", seeded.agentId)
      .set("x-test-company-id", seeded.companyId)
      .set("x-test-run-id", runId)
      .send({ title: "Self-raised independent check", status: "todo", priority: "medium", ...body });
  }

  it("inherits projectId/projectWorkspaceId from the run's own issue when parentId is omitted", async () => {
    const seeded = await seed();
    const runId = await seedRun(seeded, { issueId: seeded.currentIssueId });

    const res = await postIssue(seeded, runId, {});

    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe(seeded.projectId);
    expect(res.body.projectWorkspaceId).toBe(seeded.projectWorkspaceId);
  });

  it("inherits projectId/projectWorkspaceId when the caller sends an explicit parentId: null", async () => {
    const seeded = await seed();
    const runId = await seedRun(seeded, { issueId: seeded.currentIssueId });

    const res = await postIssue(seeded, runId, { parentId: null });

    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe(seeded.projectId);
    expect(res.body.projectWorkspaceId).toBe(seeded.projectWorkspaceId);
  });

  it("still inherits when the run's context snapshot has no executionWorkspaceId at all", async () => {
    const seeded = await seed();
    // No `executionWorkspaceId` key whatsoever — the exact shape that made
    // the old `!readNonEmptyString(context.executionWorkspaceId)` gate return
    // null unconditionally.
    const runId = await seedRun(seeded, { issueId: seeded.currentIssueId, taskId: "some-task" });

    const res = await postIssue(seeded, runId, {});

    expect(res.status).toBe(201);
    expect(res.body.projectWorkspaceId).toBe(seeded.projectWorkspaceId);
  });

  it("does not fabricate a binding when the run's own issue has no project", async () => {
    const seeded = await seed();
    const unboundIssueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: unboundIssueId,
      companyId: seeded.companyId,
      title: "Unbound current issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: seeded.agentId,
    });
    const runId = await seedRun(seeded, { issueId: unboundIssueId });

    const res = await postIssue(seeded, runId, {});

    expect(res.status).toBe(201);
    expect(res.body.projectId).toBeNull();
    expect(res.body.projectWorkspaceId).toBeNull();
  });

  it("still prefers an explicit parentId naming a different issue over the run's own binding", async () => {
    const seeded = await seed();
    const runId = await seedRun(seeded, { issueId: seeded.currentIssueId });

    const res = await postIssue(seeded, runId, { parentId: seeded.otherBoundIssueId });

    expect(res.status).toBe(201);
    expect(res.body.projectWorkspaceId).toBe(seeded.otherProjectWorkspaceId);
  });
});
