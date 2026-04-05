import { createHmac, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  blogRuns,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routines service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine service live-execution coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts?: {
    wakeup?: (
      agentId: string,
      wakeupOpts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
    runBlogRunStep?: (runId: string) => Promise<unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{
      agentId: string;
      opts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      };
    }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          if (opts?.wakeup) return opts.wakeup(wakeupAgentId, wakeupOpts);
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({
              executionRunId: queuedRunId,
              executionLockedAt: new Date(),
            })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
        runBlogRunStep: opts?.runBlogRunStep,
      },
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, issueSvc, projectId, routine, svc, wakeups };
  }

  it("creates a fresh execution issue when the previous routine issue is open but idle", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue).toBeNull();

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const routineIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.id)).toContain(previousIssue.id);
    expect(routineIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("wakes the assignee when a routine creates a fresh execution issue", async () => {
    const { agentId, routine, svc, wakeups } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(wakeups).toEqual([
      {
        agentId,
        opts: {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: run.linkedIssueId, mutation: "create" },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: { issueId: run.linkedIssueId, source: "routine.dispatch" },
        },
      },
    ]);
  });

  it("waits for the assignee wakeup to be queued before returning the routine run", async () => {
    let wakeupResolved = false;
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeupResolved = true;
        return null;
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(wakeupResolved).toBe(true);
  });

  it("coalesces only when the existing routine issue has a live execution run", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue?.id).toBe(previousIssue.id);

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);
  });

  it("coalesces when an open routine issue already has an execution run id even if the heartbeat run is no longer live", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const finishedHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: finishedHeartbeatRunId,
      companyId,
      agentId: routine.assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
      completedAt: new Date("2026-03-20T12:05:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        executionRunId: finishedHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
  });

  it("serializes concurrent dispatches until the first execution issue is linked to a queued run", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async (wakeupAgentId, wakeupOpts) => {
        const issueId =
          (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
          (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
          null;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (!issueId) return null;
        const queuedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: queuedRunId,
          companyId: routine.companyId,
          agentId: wakeupAgentId,
          invocationSource: wakeupOpts.source ?? "assignment",
          triggerDetail: wakeupOpts.triggerDetail ?? null,
          status: "queued",
          contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
        });
        await db
          .update(issues)
          .set({
            executionRunId: queuedRunId,
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
        return { id: queuedRunId };
      },
    });

    const [first, second] = await Promise.all([
      svc.runRoutine(routine.id, { source: "manual" }),
      svc.runRoutine(routine.id, { source: "manual" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
  });

  it("fails the run and cleans up the execution issue when wakeup queueing fails", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        throw new Error("queue unavailable");
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("queue unavailable");
    expect(run.linkedIssueId).toBeNull();

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("creates and runs a blog run directly when executionMode=blog_run_create", async () => {
    const stubDir = await fs.mkdtemp("/tmp/paperclip-routine-blog-run-");
    const stubPath = `${stubDir}/create_article_quality_loop_run.cjs`;
    writeFileSync(stubPath, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, topic: 'Stub Topic', reused: false, run: { id: 'blog-run-1' } }));\n`);

    const runBlogRunStep = vi.fn().mockResolvedValue({ run: { id: "blog-run-1", status: "research_ready" } });
    const { routine, svc } = await seedFixture({ runBlogRunStep });

    await db.update(routines).set({
      metadata: {
        executionMode: "blog_run_create",
        vertical: "ai-tech",
        targetSite: "fluxaivory.com",
      },
    }).where(eq(routines.id, routine.id));

    const originalEnv = process.env.ARTICLE_LOOP_CREATOR_SCRIPT;
    const originalDbEnv = process.env.PAPERCLIP_DB_URL;
    process.env.ARTICLE_LOOP_CREATOR_SCRIPT = stubPath;
    process.env.PAPERCLIP_DB_URL = tempDb!.connectionString;
    try {
      const run = await svc.runRoutine(routine.id, { source: "manual" });
      expect(run.status).toBe("blog_run_created");
      expect(run.linkedIssueId).toBeNull();
      expect((run.triggerPayload as any)?.blogRunId).toBe("blog-run-1");
      expect(runBlogRunStep).toHaveBeenCalledWith("blog-run-1");
    } finally {
      if (originalEnv === undefined) delete process.env.ARTICLE_LOOP_CREATOR_SCRIPT;
      else process.env.ARTICLE_LOOP_CREATOR_SCRIPT = originalEnv;
      if (originalDbEnv === undefined) delete process.env.PAPERCLIP_DB_URL;
      else process.env.PAPERCLIP_DB_URL = originalDbEnv;
      await fs.rm(stubDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("writes traceability fields when blog_run_create reuses an existing run", async () => {
    const stubDir = await fs.mkdtemp("/tmp/paperclip-routine-blog-run-traceability-");
    const topicScoutPath = `${stubDir}/topic_scout_stub.py`;
    writeFileSync(
      topicScoutPath,
      [
        "import json",
        "import sys",
        "",
        "out_path = sys.argv[sys.argv.index('--out') + 1]",
        "with open(out_path, 'w', encoding='utf-8') as handle:",
        "    json.dump({'selected_topic': 'Reused Topic'}, handle)",
        "",
      ].join("\n"),
    );

    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture({
      runBlogRunStep: vi.fn().mockResolvedValue({ run: { id: "blog-run-reused", status: "research_ready" } }),
    });

    const originIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: "origin issue",
      description: "Origin issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "manual",
    });
    const invokingIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: "routine issue",
      description: "Routine issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "manual",
    });

    const existingRunId = randomUUID();
    await db.insert(blogRuns).values({
      id: existingRunId,
      companyId,
      projectId: routine.projectId,
      issueId: originIssue.id,
      topic: "Reused Topic",
      lane: "publish",
      targetSite: "fluxaivory.com",
      status: "draft_ready",
      currentStep: "draft",
      approvalMode: "manual",
      publishMode: "dry_run",
      contextJson: {
        topic: "Reused Topic",
        traceability: {
          originIssueIdentifier: originIssue.identifier,
          lastTouchedIssueIdentifier: originIssue.identifier,
          continuity: "created_new_run",
          lastTouchedAt: "2026-04-04T00:00:00Z",
          reuseReason: "initial_run",
        },
      },
    });

    await db.update(routines).set({
      metadata: {
        executionMode: "blog_run_create",
        vertical: "ai-tech",
        targetSite: "fluxaivory.com",
      },
    }).where(eq(routines.id, routine.id));

    const originalScriptEnv = process.env.ARTICLE_LOOP_CREATOR_SCRIPT;
    const originalTopicScoutEnv = process.env.ARTICLE_LOOP_TOPIC_SCOUT_SCRIPT;
    const originalRssRefreshEnv = process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT;
    const originalPublishedTitlesEnv = process.env.ARTICLE_LOOP_FETCH_PUBLISHED_TITLES;
    const originalDbEnv = process.env.PAPERCLIP_DB_URL;
    process.env.ARTICLE_LOOP_CREATOR_SCRIPT = "/Users/daehan/Documents/persona/paperclip/scripts/create_article_quality_loop_run.cjs";
    process.env.ARTICLE_LOOP_TOPIC_SCOUT_SCRIPT = topicScoutPath;
    process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT = "off";
    process.env.ARTICLE_LOOP_FETCH_PUBLISHED_TITLES = "false";
    process.env.PAPERCLIP_DB_URL = tempDb!.connectionString;
    try {
      const run = await svc.runRoutine(routine.id, {
        source: "manual",
        payload: {
          issueId: invokingIssue.id,
          vertical: "ai-tech",
        },
      });

      expect(run.status).toBe("blog_run_created");
      expect((run.triggerPayload as any)?.blogRunId).toBe(existingRunId);
      expect((run.triggerPayload as any)?.reusedBlogRun).toBe(true);

      const reusedRun = await db
        .select()
        .from(blogRuns)
        .where(eq(blogRuns.id, existingRunId))
        .then((rows) => rows[0] ?? null);

      expect((reusedRun?.contextJson as any)?.traceability).toMatchObject({
        originIssueIdentifier: originIssue.identifier,
        lastTouchedIssueIdentifier: invokingIssue.identifier,
        continuity: "reused_existing_run",
        reuseReason: "article_quality_loop_bridge",
      });
      expect(typeof (reusedRun?.contextJson as any)?.traceability?.lastTouchedAt).toBe("string");
      expect((reusedRun?.contextJson as any)?.sourceRoutineIssueId).toBe(invokingIssue.id);
    } finally {
      if (originalScriptEnv === undefined) delete process.env.ARTICLE_LOOP_CREATOR_SCRIPT;
      else process.env.ARTICLE_LOOP_CREATOR_SCRIPT = originalScriptEnv;
      if (originalTopicScoutEnv === undefined) delete process.env.ARTICLE_LOOP_TOPIC_SCOUT_SCRIPT;
      else process.env.ARTICLE_LOOP_TOPIC_SCOUT_SCRIPT = originalTopicScoutEnv;
      if (originalRssRefreshEnv === undefined) delete process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT;
      else process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT = originalRssRefreshEnv;
      if (originalPublishedTitlesEnv === undefined) delete process.env.ARTICLE_LOOP_FETCH_PUBLISHED_TITLES;
      else process.env.ARTICLE_LOOP_FETCH_PUBLISHED_TITLES = originalPublishedTitlesEnv;
      if (originalDbEnv === undefined) delete process.env.PAPERCLIP_DB_URL;
      else process.env.PAPERCLIP_DB_URL = originalDbEnv;
      await fs.rm(stubDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("persists topic-scout artifacts and initial traceability when blog_run_create opens a fresh run", async () => {
    const stubDir = await fs.mkdtemp("/tmp/paperclip-routine-blog-run-fresh-");
    const homeDir = await fs.mkdtemp("/tmp/paperclip-routine-blog-home-");
    const topicScoutPath = `${stubDir}/topic_scout_stub.py`;
    writeFileSync(
      topicScoutPath,
      [
        "import json",
        "import sys",
        "",
        "out_path = sys.argv[sys.argv.index('--out') + 1]",
        "with open(out_path, 'w', encoding='utf-8') as handle:",
        "    json.dump({",
        "        'selected_topic': 'Fresh Topic',",
        "        'selected_bucket': 'ai_updates',",
        "        'selection_reason': 'fresh_official_source',",
        "        'top10_candidates': [",
        "            {'rank': 1, 'title': 'Fresh Topic', 'bucket': 'ai_updates', 'link': 'https://example.com/fresh-topic'}",
        "        ]",
        "    }, handle)",
        "",
      ].join("\n"),
    );

    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture({
      runBlogRunStep: vi.fn().mockResolvedValue({ run: { id: "blog-run-fresh", status: "research_ready" } }),
    });

    const invokingIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: "fresh routine issue",
      description: "Fresh routine issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "manual",
    });

    await db.update(routines).set({
      metadata: {
        executionMode: "blog_run_create",
        vertical: "ai-tech",
        targetSite: "fluxaivory.com",
      },
    }).where(eq(routines.id, routine.id));

    const originalScriptEnv = process.env.ARTICLE_LOOP_CREATOR_SCRIPT;
    const originalTopicScoutEnv = process.env.ARTICLE_LOOP_TOPIC_SCOUT_SCRIPT;
    const originalRssRefreshEnv = process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT;
    const originalPublishedTitlesEnv = process.env.ARTICLE_LOOP_FETCH_PUBLISHED_TITLES;
    const originalDbEnv = process.env.PAPERCLIP_DB_URL;
    const originalHomeEnv = process.env.HOME;
    process.env.ARTICLE_LOOP_CREATOR_SCRIPT = "/Users/daehan/Documents/persona/paperclip/scripts/create_article_quality_loop_run.cjs";
    process.env.ARTICLE_LOOP_TOPIC_SCOUT_SCRIPT = topicScoutPath;
    process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT = "off";
    process.env.ARTICLE_LOOP_FETCH_PUBLISHED_TITLES = "false";
    process.env.PAPERCLIP_DB_URL = tempDb!.connectionString;
    process.env.HOME = homeDir;
    try {
      const routineRun = await svc.runRoutine(routine.id, {
        source: "manual",
        payload: {
          issueId: invokingIssue.id,
          vertical: "ai-tech",
        },
      });

      expect(routineRun.status).toBe("blog_run_created");
      expect((routineRun.triggerPayload as any)?.reusedBlogRun).toBe(false);

      const createdRun = await db
        .select()
        .from(blogRuns)
        .where(eq(blogRuns.id, String((routineRun.triggerPayload as any)?.blogRunId)))
        .then((rows) => rows[0] ?? null);

      expect((createdRun?.contextJson as any)?.traceability).toMatchObject({
        originIssueIdentifier: invokingIssue.identifier,
        lastTouchedIssueIdentifier: invokingIssue.identifier,
        continuity: "created_new_run",
      });
      expect((createdRun?.contextJson as any)?.sourceRoutineIssueId).toBe(invokingIssue.id);

      const topicScoutSnapshotPath = `${homeDir}/.paperclip/instances/default/data/blog-runs/${createdRun?.id}/topic-scout.json`;
      const topicScoutSnapshot = JSON.parse(await fs.readFile(topicScoutSnapshotPath, "utf8"));
      expect(topicScoutSnapshot).toMatchObject({
        selected_topic: "Fresh Topic",
        selected_bucket: "ai_updates",
      });
    } finally {
      if (originalScriptEnv === undefined) delete process.env.ARTICLE_LOOP_CREATOR_SCRIPT;
      else process.env.ARTICLE_LOOP_CREATOR_SCRIPT = originalScriptEnv;
      if (originalTopicScoutEnv === undefined) delete process.env.ARTICLE_LOOP_TOPIC_SCOUT_SCRIPT;
      else process.env.ARTICLE_LOOP_TOPIC_SCOUT_SCRIPT = originalTopicScoutEnv;
      if (originalRssRefreshEnv === undefined) delete process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT;
      else process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT = originalRssRefreshEnv;
      if (originalPublishedTitlesEnv === undefined) delete process.env.ARTICLE_LOOP_FETCH_PUBLISHED_TITLES;
      else process.env.ARTICLE_LOOP_FETCH_PUBLISHED_TITLES = originalPublishedTitlesEnv;
      if (originalDbEnv === undefined) delete process.env.PAPERCLIP_DB_URL;
      else process.env.PAPERCLIP_DB_URL = originalDbEnv;
      if (originalHomeEnv === undefined) delete process.env.HOME;
      else process.env.HOME = originalHomeEnv;
      await fs.rm(stubDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("accepts standard second-precision webhook timestamps for HMAC triggers", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      },
      {},
    );

    expect(trigger.publicId).toBeTruthy();
    expect(secretMaterial?.webhookSecret).toBeTruthy();

    const payload = { ok: true };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
  });
});
