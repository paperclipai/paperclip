import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseIssueLinks,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE,
  pipelineService,
  type PipelineActor,
} from "../services/pipelines.ts";
import { routineService } from "../services/routines.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pipeline service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipelineService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pipelineService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const userActor: PipelineActor = { type: "user", userId: "board-user" };
  const noopHeartbeat = { wakeup: async () => null };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipelines-service-");
    db = createDb(tempDb.connectionString);
    svc = pipelineService(db, { heartbeat: noopHeartbeat });
  }, 20_000);

  afterEach(async () => {
    await db.delete(pipelineAutomationExecutions);
    await db.delete(pipelineCaseBlockers);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(routines);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db.insert(companies).values({
      name: "Pipeline Co",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    }).returning();
    return company!;
  }

  async function seedPipeline(options?: { enforceTransitions?: boolean }) {
    const company = await seedCompany();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: `content-${randomUUID().slice(0, 8)}`,
      name: "Content",
      enforceTransitions: options?.enforceTransitions ?? false,
      actor: userActor,
    });
    const stages = await svc.listStages(company.id, pipeline.id);
    return { company, pipeline, stages, byKey: new Map(stages.map((stage) => [stage.key, stage])) };
  }

  async function seedRoutine(companyId: string, title = "Routine") {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: `${title} Agent`,
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return routineService(db, { heartbeat: noopHeartbeat }).create(companyId, {
      projectId: null,
      goalId: null,
      parentIssueId: null,
      title,
      description: null,
      assigneeAgentId: agent!.id,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "always_enqueue",
      catchUpPolicy: "skip_missed",
    }, {});
  }

  async function eventCount(caseId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pipelineCaseEvents)
      .where(eq(pipelineCaseEvents.caseId, caseId));
    return count ?? 0;
  }

  async function seedLinkedIssue(input: {
    companyId: string;
    caseId: string;
    role: "origin" | "conversation" | "work" | "automation";
    status?: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
    title?: string;
  }) {
    const [issue] = await db.insert(issues).values({
      companyId: input.companyId,
      title: input.title ?? `${input.role} issue`,
      status: input.status ?? "todo",
      priority: "medium",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId: input.companyId,
      caseId: input.caseId,
      issueId: issue!.id,
      role: input.role,
    });
    return issue!;
  }

  it("seeds default stages and protects non-empty stage deletion", async () => {
    const { company, pipeline, byKey } = await seedPipeline();

    expect([...byKey.keys()]).toEqual(["intake", "in_progress", "review", "done", "cancelled"]);
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "stage-delete",
      title: "Stage delete guard",
      actor: userActor,
    });

    await expect(
      svc.deleteStage({ companyId: company.id, pipelineId: pipeline.id, stageId: byKey.get("intake")!.id }),
    ).rejects.toMatchObject({ status: 422, details: { code: "stage_has_cases" } });

    await svc.deleteStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("intake")!.id,
      moveCasesToStageId: byKey.get("in_progress")!.id,
    });
    const [moved] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    expect(moved!.stageId).toBe(byKey.get("in_progress")!.id);
  });

  it("updates parent terminal counts when deleting a stage moves child cases to done", async () => {
    const { company, pipeline, byKey } = await seedPipeline();
    const parent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageKey: "in_progress",
      caseKey: "delete-stage-parent",
      title: "Delete stage parent",
      actor: userActor,
    });
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "delete-stage-child",
      title: "Delete stage child",
      parentCaseId: parent.case.id,
      actor: userActor,
    });

    await svc.deleteStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("intake")!.id,
      moveCasesToStageId: byKey.get("done")!.id,
    });

    const [freshParent] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, parent.case.id));
    const [freshChild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, child.case.id));
    expect(freshParent!.childCount).toBe(1);
    expect(freshParent!.terminalChildCount).toBe(1);
    expect(freshChild!.terminalKind).toBe("done");

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: parent.case.id,
        toStageKey: "done",
        expectedVersion: parent.case.version,
        actor: userActor,
      }),
    ).resolves.toMatchObject({ case: { terminalKind: "done" } });
  });

  it("implements idempotent single and batch ingest", async () => {
    const { company, pipeline } = await seedPipeline();

    const first = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "release-1",
      title: "Release 1",
      actor: userActor,
    });
    const second = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "release-1",
      title: "Duplicate title is ignored",
      actor: userActor,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.case.id).toBe(first.case.id);
    expect(await eventCount(first.case.id)).toBe(1);

    await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "existing-2",
      title: "Existing 2",
      actor: userActor,
    });
    const batch = await svc.ingestCases({
      companyId: company.id,
      pipelineId: pipeline.id,
      actor: userActor,
      items: [
        { caseKey: "new-1", title: "New 1" },
        { caseKey: "new-2", title: "New 2" },
        { caseKey: "release-1", title: "Existing 1" },
        { caseKey: "new-3", title: "New 3" },
        { caseKey: "existing-2", title: "Existing 2 again" },
      ],
    });

    expect(batch).toHaveLength(5);
    expect(batch.filter((item) => item.ok && item.created)).toHaveLength(3);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(pipelineCases);
    expect(count).toBe(5);
  });

  it("persists workspaceRef during ingest", async () => {
    const { company, pipeline } = await seedPipeline();
    const workspaceRef = {
      workspacePath: "exports/pipeline-case",
      name: "Pipeline case files",
    };

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "workspace-ref",
      title: "Workspace ref",
      workspaceRef,
      actor: userActor,
    });

    expect(created.case.workspaceRef).toEqual(workspaceRef);
    const [stored] = await db
      .select({ workspaceRef: pipelineCases.workspaceRef })
      .from(pipelineCases)
      .where(eq(pipelineCases.id, created.case.id));
    expect(stored?.workspaceRef).toEqual(workspaceRef);
  });

  it("rejects stale content PATCH without writing an event", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "patch",
      title: "Patch me",
      actor: userActor,
    });
    await svc.patchCaseContent({
      companyId: company.id,
      caseId: created.case.id,
      title: "Patched",
      expectedVersion: 1,
      actor: userActor,
    });
    const before = await eventCount(created.case.id);

    await expect(
      svc.patchCaseContent({
        companyId: company.id,
        caseId: created.case.id,
        title: "Stale",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "version_conflict", version: 2 } });
    expect(await eventCount(created.case.id)).toBe(before);
  });

  it("lets exactly one parallel transition with the same expectedVersion succeed", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "parallel",
      title: "Parallel transition",
      actor: userActor,
    });

    const attempts = await Promise.allSettled([
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: userActor,
      }),
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "review",
        expectedVersion: 1,
        actor: userActor,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const [row] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    expect(row!.version).toBe(2);
    expect(await eventCount(created.case.id)).toBe(2);
  });

  it("enforces active leases and lets the holder transition with the lease token", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "lease",
      title: "Leased case",
      actor: userActor,
    });
    const owner: PipelineActor = { type: "user", userId: "owner" };
    const other: PipelineActor = { type: "user", userId: "other" };

    const claimed = await svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: owner });
    await expect(svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: other })).rejects.toMatchObject({
      status: 409,
      details: { code: "lease_held" },
    });
    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: other,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "lease_held" } });

    const transitioned = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      leaseToken: claimed.leaseToken,
      actor: owner,
    });
    expect(transitioned.case.version).toBe(2);
    expect(await eventCount(created.case.id)).toBe(3);
  });

  it("expires leases on read before a new claim", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "expired-lease",
      title: "Expired lease",
      actor: userActor,
    });
    await db.update(pipelineCases).set({
      leaseOwnerType: "user",
      leaseUserId: "old-owner",
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 5_000),
    }).where(eq(pipelineCases.id, created.case.id));

    const claimed = await svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: { type: "user", userId: "new-owner" } });

    expect(claimed.leaseUserId).toBe("new-owner");
    const events = await svc.listCaseEvents(company.id, created.case.id);
    expect(events.map((event) => event.type)).toEqual(["ingested", "lease_expired", "claimed"]);
  });

  it("enforces transition edges only when enforceTransitions is enabled", async () => {
    const { company, pipeline } = await seedPipeline({ enforceTransitions: true });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "edges",
      title: "Transition edges",
      actor: userActor,
    });

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "done",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "transition_not_allowed" } });

    await db.update(pipelines).set({ enforceTransitions: false }).where(eq(pipelines.id, pipeline.id));
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.case.terminalKind).toBe("done");
  });

  it("blocks transitions while blockers are not done", async () => {
    const { company, pipeline } = await seedPipeline();
    const blocked = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocked",
      title: "Blocked case",
      actor: userActor,
    });
    const blocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocker",
      title: "Blocking case",
      actor: userActor,
    });
    await svc.replaceBlockers({
      companyId: company.id,
      caseId: blocked.case.id,
      blockedByCaseIds: [blocker.case.id],
      actor: userActor,
    });

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: blocked.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "blocked" } });

    const reviewMove = await svc.transitionCase({
      companyId: company.id,
      caseId: blocked.case.id,
      toStageKey: "review",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(reviewMove.case.version).toBe(2);

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: blocked.case.id,
        toStageKey: "done",
        expectedVersion: 2,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "blocked" } });

    await svc.transitionCase({
      companyId: company.id,
      caseId: blocker.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: blocked.case.id,
      toStageKey: "in_progress",
      expectedVersion: 2,
      actor: userActor,
    });
    expect(moved.case.version).toBe(3);
    const events = await svc.listCaseEvents(company.id, blocked.case.id);
    expect(events.map((event) => event.type)).toContain("blockers_resolved");
  });

  it("emits blockers_resolved once for each fresh blocker set", async () => {
    const { company, pipeline } = await seedPipeline();
    const blocked = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocked-again",
      title: "Blocked again",
      actor: userActor,
    });
    const firstBlocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "first-blocker",
      title: "First blocker",
      actor: userActor,
    });
    const secondBlocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "second-blocker",
      title: "Second blocker",
      actor: userActor,
    });
    const workIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: blocked.case.id,
      role: "work",
      title: "Blocked work",
    });

    await svc.replaceBlockers({
      companyId: company.id,
      caseId: blocked.case.id,
      blockedByCaseIds: [firstBlocker.case.id],
      actor: userActor,
    });
    await svc.transitionCase({
      companyId: company.id,
      caseId: firstBlocker.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });

    await svc.replaceBlockers({
      companyId: company.id,
      caseId: blocked.case.id,
      blockedByCaseIds: [secondBlocker.case.id],
      actor: userActor,
    });
    await svc.transitionCase({
      companyId: company.id,
      caseId: secondBlocker.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });

    const events = await svc.listCaseEvents(company.id, blocked.case.id);
    expect(events.filter((event) => event.type === "blockers_resolved")).toHaveLength(2);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, workIssue.id));
    expect(comments).toHaveLength(2);
    expect(comments.map((comment) => comment.body).join("\n")).toContain(firstBlocker.case.id);
    expect(comments.map((comment) => comment.body).join("\n")).toContain(secondBlocker.case.id);
  });

  it("keeps cancelled blockers unsatisfied until replaced", async () => {
    const { company, pipeline } = await seedPipeline();
    const blocked = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocked-cancelled",
      title: "Blocked case",
      actor: userActor,
    });
    const blocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocker-cancelled",
      title: "Cancelled blocker",
      actor: userActor,
    });
    await svc.replaceBlockers({
      companyId: company.id,
      caseId: blocked.case.id,
      blockedByCaseIds: [blocker.case.id],
      actor: userActor,
    });
    await svc.transitionCase({
      companyId: company.id,
      caseId: blocker.case.id,
      toStageKey: "cancelled",
      expectedVersion: 1,
      actor: userActor,
    });

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: blocked.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "blocked" } });

    await svc.replaceBlockers({ companyId: company.id, caseId: blocked.case.id, blockedByCaseIds: [], actor: userActor });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: blocked.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.case.version).toBe(2);
  });

  it("posts upstream drift notices to active dependent work issues only", async () => {
    const { company, pipeline } = await seedPipeline();
    const upstream = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "draft",
      title: "Draft",
      actor: userActor,
    });
    const workDependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "asset-work",
      title: "Asset work",
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const conversationDependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "asset-conversation",
      title: "Asset conversation",
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const workIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: workDependent.case.id,
      role: "work",
      title: "Asset work issue",
    });
    const conversationIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: conversationDependent.case.id,
      role: "conversation",
      title: "Conversation issue",
    });

    const updated = await svc.patchCaseContent({
      companyId: company.id,
      caseId: upstream.case.id,
      title: "Draft v2",
      expectedVersion: 1,
      actor: userActor,
    });

    expect(updated.version).toBe(2);
    const workComments = await db.select().from(issueComments).where(eq(issueComments.issueId, workIssue.id));
    expect(workComments).toHaveLength(1);
    expect(workComments[0]!.authorType).toBe("system");
    expect(workComments[0]!.body).toBe(
      `Upstream case [draft](/PAP/pipelines/${pipeline.id}/cases/${upstream.case.id}) changed (v1→v2).`,
    );
    const conversationComments = await db.select().from(issueComments).where(eq(issueComments.issueId, conversationIssue.id));
    expect(conversationComments).toHaveLength(0);
  });

  it("skips upstream drift notices for terminal dependents and dependents without work issues", async () => {
    const { company, pipeline } = await seedPipeline();
    const upstream = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "source",
      title: "Source",
      actor: userActor,
    });
    const terminalDependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageKey: "done",
      caseKey: "terminal-dependent",
      title: "Terminal dependent",
      actor: userActor,
    });
    await svc.replaceBlockers({
      companyId: company.id,
      caseId: terminalDependent.case.id,
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const noWorkDependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "no-work-dependent",
      title: "No work dependent",
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const terminalIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: terminalDependent.case.id,
      role: "work",
      title: "Terminal work issue",
    });
    const conversationIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: noWorkDependent.case.id,
      role: "conversation",
      title: "Non-work issue",
    });

    await svc.patchCaseContent({
      companyId: company.id,
      caseId: upstream.case.id,
      summary: "Updated source",
      expectedVersion: 1,
      actor: userActor,
    });

    const terminalComments = await db.select().from(issueComments).where(eq(issueComments.issueId, terminalIssue.id));
    expect(terminalComments).toHaveLength(0);
    const conversationComments = await db.select().from(issueComments).where(eq(issueComments.issueId, conversationIssue.id));
    expect(conversationComments).toHaveLength(0);
  });

  it("does not bump versions or notify dependents on no-op content patches", async () => {
    const { company, pipeline } = await seedPipeline();
    const upstream = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "noop-source",
      title: "No-op source",
      fields: { channel: "blog" },
      actor: userActor,
    });
    const dependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "noop-dependent",
      title: "No-op dependent",
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const workIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: dependent.case.id,
      role: "work",
      title: "No-op work issue",
    });
    const beforeEvents = await eventCount(upstream.case.id);

    const patched = await svc.patchCaseContent({
      companyId: company.id,
      caseId: upstream.case.id,
      title: "No-op source",
      fields: { channel: "blog" },
      expectedVersion: 1,
      actor: userActor,
    });

    expect(patched.version).toBe(1);
    expect(await eventCount(upstream.case.id)).toBe(beforeEvents);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, workIssue.id));
    expect(comments).toHaveLength(0);
  });

  it("resolves in-batch forward blocker case keys", async () => {
    const { company, pipeline } = await seedPipeline();

    const results = await svc.ingestCases({
      companyId: company.id,
      pipelineId: pipeline.id,
      items: [
        { caseKey: "tweet", title: "Tweet", blockedByCaseKeys: ["image", "post"] },
        { caseKey: "image", title: "Image" },
        { caseKey: "post", title: "Post" },
      ],
      actor: userActor,
    });

    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    const successful = results.filter((result): result is Extract<(typeof results)[number], { ok: true }> => result.ok);
    const byKey = new Map(successful
      .map((result) => [result.case.caseKey, result.case.id]));
    const blockers = await db
      .select()
      .from(pipelineCaseBlockers)
      .where(eq(pipelineCaseBlockers.caseId, byKey.get("tweet")!));
    expect(blockers.map((row) => row.blockedByCaseId).sort()).toEqual([
      byKey.get("image")!,
      byKey.get("post")!,
    ].sort());
    const events = await svc.listCaseEvents(company.id, byKey.get("tweet")!);
    const blockersEvent = events.find((event) => event.type === "blockers_set");
    expect(blockersEvent?.payload).toMatchObject({
      blockedByCaseIds: expect.arrayContaining([byKey.get("image")!, byKey.get("post")!]),
      blockedByCaseKeys: ["image", "post"],
    });
  });

  it("resolves blocker case keys against existing cases", async () => {
    const { company, pipeline } = await seedPipeline();
    const asset = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "asset",
      title: "Asset",
      actor: userActor,
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "tweet",
      title: "Tweet",
      blockedByCaseKeys: ["asset"],
      actor: userActor,
    });

    const blockers = await db
      .select()
      .from(pipelineCaseBlockers)
      .where(eq(pipelineCaseBlockers.caseId, created.case.id));
    expect(blockers.map((row) => row.blockedByCaseId)).toEqual([asset.case.id]);
  });

  it("fails only unresolved blocker-key rows in batch ingest", async () => {
    const { company, pipeline } = await seedPipeline();

    const results = await svc.ingestCases({
      companyId: company.id,
      pipelineId: pipeline.id,
      items: [
        { caseKey: "ok", title: "OK" },
        { caseKey: "missing", title: "Missing", blockedByCaseKeys: ["does-not-exist"] },
        { caseKey: "after", title: "After" },
      ],
      actor: userActor,
    });

    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({
      ok: false,
      caseKey: "missing",
      error: {
        status: 404,
        details: { code: "blocker_case_key_not_found", missingCaseKeys: ["does-not-exist"] },
      },
    });
    expect(results[2]).toMatchObject({ ok: true });
    const rows = await db.select().from(pipelineCases).where(eq(pipelineCases.pipelineId, pipeline.id));
    expect(rows.map((row) => row.caseKey).sort()).toEqual(["after", "ok"]);
  });

  it("rejects blocker cycles declared by batch case keys", async () => {
    const { company, pipeline } = await seedPipeline();

    const results = await svc.ingestCases({
      companyId: company.id,
      pipelineId: pipeline.id,
      items: [
        { caseKey: "a", title: "A", blockedByCaseKeys: ["b"] },
        { caseKey: "b", title: "B", blockedByCaseKeys: ["a"] },
      ],
      actor: userActor,
    });

    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        caseKey: "a",
        error: expect.objectContaining({ status: 409, details: { code: "blocker_cycle", blockedByCaseKeys: ["b"] } }),
      }),
      expect.objectContaining({
        ok: false,
        caseKey: "b",
        error: expect.objectContaining({ status: 409, details: { code: "blocker_cycle", blockedByCaseKeys: ["a"] } }),
      }),
    ]);
    const rows = await db.select().from(pipelineCases).where(eq(pipelineCases.pipelineId, pipeline.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects parent and blocker cycles and enforces parent depth", async () => {
    const { company, pipeline } = await seedPipeline();
    const a = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "a", title: "A", actor: userActor });
    const b = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "b",
      title: "B",
      parentCaseId: a.case.id,
      actor: userActor,
    });

    await expect(
      svc.patchCaseContent({
        companyId: company.id,
        caseId: a.case.id,
        parentCaseId: b.case.id,
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "parent_cycle" } });

    await svc.replaceBlockers({ companyId: company.id, caseId: a.case.id, blockedByCaseIds: [b.case.id], actor: userActor });
    await expect(
      svc.replaceBlockers({ companyId: company.id, caseId: b.case.id, blockedByCaseIds: [a.case.id], actor: userActor }),
    ).rejects.toMatchObject({ status: 409, details: { code: "blocker_cycle" } });

    let parentCaseId: string | null = null;
    for (let index = 0; index < 32; index += 1) {
      const created = await svc.ingestCase({
        companyId: company.id,
        pipelineId: pipeline.id,
        caseKey: `chain-${index}`,
        title: `Chain ${index}`,
        parentCaseId,
        actor: userActor,
      });
      parentCaseId = created.case.id;
    }
    await expect(
      svc.ingestCase({
        companyId: company.id,
        pipelineId: pipeline.id,
        caseKey: "too-deep",
        title: "Too deep",
        parentCaseId,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "parent_depth_exceeded" } });
  });

  it("rolls up a three-level tree, updates counters, and emits children_terminal once", async () => {
    const { company, pipeline } = await seedPipeline();
    const root = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "root", title: "Root", actor: userActor });
    const [linkedIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Root conversation",
      status: "todo",
      priority: "medium",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId: company.id,
      caseId: root.case.id,
      issueId: linkedIssue!.id,
      role: "conversation",
    });
    const childA = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "child-a",
      title: "Child A",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    const childB = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "child-b",
      title: "Child B",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    const childC = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "child-c",
      title: "Child C",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    const grandA = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "grand-a",
      title: "Grand A",
      parentCaseId: childA.case.id,
      actor: userActor,
    });
    const grandB = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "grand-b",
      title: "Grand B",
      parentCaseId: childA.case.id,
      actor: userActor,
    });

    await svc.transitionCase({ companyId: company.id, caseId: childB.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });
    await svc.transitionCase({ companyId: company.id, caseId: childC.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });
    await svc.transitionCase({ companyId: company.id, caseId: grandA.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });
    await svc.transitionCase({ companyId: company.id, caseId: grandB.case.id, toStageKey: "cancelled", expectedVersion: 1, actor: userActor });
    await svc.transitionCase({ companyId: company.id, caseId: childA.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });

    expect(await svc.getCaseRollup(company.id, root.case.id)).toEqual({
      total: 5,
      done: 4,
      cancelled: 1,
      open: 0,
      complete: true,
    });
    const [freshRoot] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, root.case.id));
    const [freshChildA] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, childA.case.id));
    expect(freshRoot!.childCount).toBe(3);
    expect(freshRoot!.terminalChildCount).toBe(3);
    expect(freshChildA!.childCount).toBe(2);
    expect(freshChildA!.terminalChildCount).toBe(2);
    const rootEvents = await svc.listCaseEvents(company.id, root.case.id);
    expect(rootEvents.filter((event) => event.type === "children_terminal")).toHaveLength(1);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, linkedIssue!.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toContain("All child cases");
  });

  it("auto-advances a parent when all descendants are terminal", async () => {
    const company = await seedCompany();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "auto-children",
      name: "Auto children",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open", config: { autoAdvanceOnChildrenTerminal: "done" } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const root = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "auto-root", title: "Root", actor: userActor });
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "auto-child",
      title: "Child",
      parentCaseId: root.case.id,
      actor: userActor,
    });

    await svc.transitionCase({ companyId: company.id, caseId: child.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });

    const [freshRoot] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, root.case.id));
    expect(freshRoot!.terminalKind).toBe("done");
    expect(freshRoot!.version).toBe(2);
    const rootEvents = await svc.listCaseEvents(company.id, root.case.id);
    expect(rootEvents.map((event) => event.type)).toEqual(["ingested", "children_terminal", "transitioned"]);
  });

  it("auto-advances a leased parent when child completion triggers a system transition", async () => {
    const company = await seedCompany();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "auto-children-lease",
      name: "Auto children lease",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open", config: { autoAdvanceOnChildrenTerminal: "done" } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const root = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "leased-root", title: "Root", actor: userActor });
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "leased-child",
      title: "Child",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    await svc.claimCase({
      companyId: company.id,
      caseId: root.case.id,
      actor: { type: "user", userId: "reviewer" },
    });

    await svc.transitionCase({ companyId: company.id, caseId: child.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });

    const [freshRoot] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, root.case.id));
    expect(freshRoot!.terminalKind).toBe("done");
    expect(freshRoot!.leaseToken).toBeNull();
    const rootEvents = await svc.listCaseEvents(company.id, root.case.id);
    expect(rootEvents.map((event) => event.type)).toEqual(["ingested", "claimed", "children_terminal", "transitioned"]);
  });

  it("keeps child completion committed when parent children-terminal auto-advance is gated", async () => {
    const company = await seedCompany();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "auto-children-blocked",
      name: "Auto children blocked",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open", config: { autoAdvanceOnChildrenTerminal: "done" } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const root = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "blocked-root", title: "Root", actor: userActor });
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocked-child",
      title: "Child",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    const blocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "open-blocker",
      title: "Open blocker",
      actor: userActor,
    });
    await svc.replaceBlockers({
      companyId: company.id,
      caseId: root.case.id,
      blockedByCaseIds: [blocker.case.id],
      actor: userActor,
    });

    await expect(
      svc.transitionCase({ companyId: company.id, caseId: child.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor }),
    ).resolves.toMatchObject({ case: { terminalKind: "done" } });

    const [freshRoot] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, root.case.id));
    const [freshChild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, child.case.id));
    expect(freshRoot!.terminalKind).toBeNull();
    expect(freshRoot!.terminalChildCount).toBe(1);
    expect(freshChild!.terminalKind).toBe("done");
    const rootEvents = await svc.listCaseEvents(company.id, root.case.id);
    expect(rootEvents.map((event) => event.type)).toEqual(["ingested", "blockers_set", "children_terminal"]);
  });

  it("records suggestion supersede, accept, and dismiss lifecycles", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "suggest-accept",
      title: "Suggestion accept",
      actor: userActor,
    });
    const first = await svc.suggestTransition({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "review",
      rationale: "Needs review",
      actor: userActor,
    });
    const second = await svc.suggestTransition({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      rationale: "Actually draft first",
      actor: userActor,
    });
    expect(second.suggestion.id).not.toBe(first.suggestion.id);

    const accepted = await svc.resolveSuggestion({
      companyId: company.id,
      caseId: created.case.id,
      suggestionId: second.suggestion.id,
      decision: "accept",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(accepted.case.version).toBe(2);
    const acceptEvents = await svc.listCaseEvents(company.id, created.case.id);
    expect(acceptEvents.map((event) => event.type)).toEqual([
      "ingested",
      "transition_suggested",
      "transition_suggested",
      "transitioned",
      "suggestion_resolved",
    ]);

    const dismissCase = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "suggest-dismiss",
      title: "Suggestion dismiss",
      actor: userActor,
    });
    const suggestion = await svc.suggestTransition({
      companyId: company.id,
      caseId: dismissCase.case.id,
      toStageKey: "review",
      rationale: "Maybe review",
      actor: userActor,
    });
    await svc.resolveSuggestion({
      companyId: company.id,
      caseId: dismissCase.case.id,
      suggestionId: suggestion.suggestion.id,
      decision: "dismiss",
      reason: "Not ready",
      actor: userActor,
    });
    const [dismissed] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, dismissCase.case.id));
    expect(dismissed!.pendingSuggestion).toBeNull();
    expect(dismissed!.version).toBe(1);
  });

  it("writes an event for each case mutation and rejects agent mutations without run provenance", async () => {
    const { company, pipeline } = await seedPipeline();
    const agentActor = { type: "agent", agentId: randomUUID() } as PipelineActor;
    await expect(
      svc.ingestCase({
        companyId: company.id,
        pipelineId: pipeline.id,
        caseKey: "bad-agent",
        title: "Bad provenance",
        actor: agentActor,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "run_id_required" } });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "events",
      title: "Events",
      actor: userActor,
    });
    expect(await eventCount(created.case.id)).toBe(1);
    await svc.patchCaseContent({ companyId: company.id, caseId: created.case.id, title: "Updated", actor: userActor });
    expect(await eventCount(created.case.id)).toBe(2);
    const claimed = await svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: { type: "user", userId: "claimer" } });
    expect(await eventCount(created.case.id)).toBe(3);
    await svc.releaseCase({ companyId: company.id, caseId: created.case.id, leaseToken: claimed.leaseToken, actor: { type: "user", userId: "claimer" } });
    expect(await eventCount(created.case.id)).toBe(4);
    await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 2,
      actor: userActor,
    });
    expect(await eventCount(created.case.id)).toBe(5);
  });

  it("fires a stage-entry automation routine once and keeps crash-retry idempotent", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Draft on enter");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "automation",
      name: "Automation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "automation",
      title: "Automation case",
      actor: userActor,
    });

    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.automationLedger?.routineId).toBe(routine.id);
    expect(moved.automationExecution.status).toBe("succeeded");
    const ledgers = await db.select().from(pipelineAutomationExecutions);
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]!.triggeringEventId).toBe(moved.event.id);
    expect(ledgers[0]!.executionIssueId).toBeTruthy();
    const runsAfterTransition = await db.select().from(routineRuns);
    expect(runsAfterTransition).toHaveLength(1);
    const linksAfterTransition = await db.select().from(pipelineCaseIssueLinks);
    expect(linksAfterTransition).toHaveLength(1);
    expect(linksAfterTransition[0]!.role).toBe("automation");

    const [issue] = await db.select().from(issues).where(eq(issues.id, ledgers[0]!.executionIssueId!));
    expect(issue!.description).toContain("Pipeline Case Context");
    expect(issue!.description).toContain("untrustedContent");

    const triggerEvent = await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: created.case.id,
      type: "transitioned",
      actorType: "system",
      toStageId: moved.case.stageId,
      payload: { simulatedCrash: true },
    }).returning();
    const automationId = ledgers[0]!.automationId;
    await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: created.case.id,
      automationId,
      triggeringEventId: triggerEvent[0]!.id,
      routineId: routine.id,
      status: "failed",
      error: "pending_dispatch",
    });

    const firstRetry = await svc.retryAutomation({
      companyId: company.id,
      caseId: created.case.id,
      automationId,
      actor: userActor,
    });
    const secondRetry = await svc.retryAutomation({
      companyId: company.id,
      caseId: created.case.id,
      automationId,
      actor: userActor,
    });
    expect(firstRetry.status).toBe("succeeded");
    expect(secondRetry.status).toBe("succeeded");
    const runsAfterRetries = await db.select().from(routineRuns);
    expect(runsAfterRetries).toHaveLength(2);
    const crashExecutions = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.triggeringEventId, triggerEvent[0]!.id));
    expect(crashExecutions).toHaveLength(1);
    expect(crashExecutions[0]!.executionIssueId).toBeTruthy();
    const crashLinks = await db
      .select()
      .from(pipelineCaseIssueLinks)
      .where(eq(pipelineCaseIssueLinks.issueId, crashExecutions[0]!.executionIssueId!));
    expect(crashLinks).toHaveLength(1);
  });

  it("carries saved stage automation workspace context into the execution issue", async () => {
    const { company, pipeline, byKey } = await seedPipeline();
    const routineSeed = await seedRoutine(company.id, "Workspace automation seed");
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(projects).values({
      id: projectId,
      companyId: company.id,
      name: "Automation project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId: company.id,
      projectId,
      name: "Automation workspace",
      isPrimary: true,
      sharedWorkspaceKey: "pipeline-automation-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId: company.id,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Automation worktree",
      status: "active",
      providerType: "git_worktree",
    });

    const updatedStage = await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: {
        config: {
          automation: {
            assigneeAgentId: routineSeed.assigneeAgentId,
            instructionsBody: "Use the selected workspace.",
            projectId,
            projectWorkspaceId,
            executionWorkspaceId,
            executionWorkspacePreference: "reuse_existing",
            executionWorkspaceSettings: { mode: "isolated_workspace" },
          },
        },
      },
      actor: userActor,
    });
    expect((updatedStage.config as { onEnter?: unknown }).onEnter).toMatchObject({
      type: "run_routine",
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "workspace-context",
      title: "Workspace context case",
      actor: userActor,
    });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      actor: userActor,
    });

    expect(moved.automationExecution.status).toBe("succeeded");
    const executionIssueId = moved.automationExecution.status === "succeeded"
      ? moved.automationExecution.execution.executionIssueId
      : null;
    const [issue] = await db
      .select({
        projectId: issues.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, executionIssueId!));

    expect(issue).toEqual({
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("defaults, preserves, and interpolates pipeline automation issue title templates", async () => {
    const { company, pipeline, byKey } = await seedPipeline();
    const routineSeed = await seedRoutine(company.id, "Automation seed");
    const stageId = byKey.get("in_progress")!.id;

    const firstSave = await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId,
      patch: {
        config: {
          automation: {
            assigneeAgentId: routineSeed.assigneeAgentId,
            instructionsBody: "Draft from {{body}} for {{case_title}}.",
          },
        },
      },
      actor: userActor,
    });
    const firstRoutineId = (firstSave.config as { onEnter?: { routineId?: string } }).onEnter?.routineId;
    expect(firstRoutineId).toBeTruthy();
    const [defaultRoutine] = await db.select().from(routines).where(eq(routines.id, firstRoutineId!));
    expect(defaultRoutine!.title).toBe(PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE);
    expect((defaultRoutine!.variables ?? []).map((variable) => variable.name)).toEqual([
      "pipeline_name",
      "stage_name",
      "case_title",
      "body",
    ]);

    await db
      .update(routines)
      .set({ title: "Custom {{case_key}}: {{case_title}}" })
      .where(eq(routines.id, firstRoutineId!));
    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId,
      patch: {
        config: {
          automation: {
            assigneeAgentId: routineSeed.assigneeAgentId,
            instructionsBody: "Updated instructions for {{case_title}}.",
          },
        },
      },
      actor: userActor,
    });
    const [customRoutine] = await db.select().from(routines).where(eq(routines.id, firstRoutineId!));
    expect(customRoutine!.title).toBe("Custom {{case_key}}: {{case_title}}");
    expect((customRoutine!.variables ?? []).map((variable) => variable.name)).toContain("case_key");

    await db
      .update(routines)
      .set({ title: "In progress automation" })
      .where(eq(routines.id, firstRoutineId!));
    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId,
      patch: {
        config: {
          automation: {
            assigneeAgentId: routineSeed.assigneeAgentId,
            instructionsBody: "Runtime interpolation for {{case_title}}.",
          },
        },
      },
      actor: userActor,
    });
    const [upgradedRoutine] = await db.select().from(routines).where(eq(routines.id, firstRoutineId!));
    expect(upgradedRoutine!.title).toBe(PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE);

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "pulpit-opinion",
      title: "Pulpit opinion piece",
      body: "Agentic work should be composed, not rebuilt",
      actor: userActor,
    });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.automationExecution.status).toBe("succeeded");
    const executionIssueId = moved.automationExecution.status === "succeeded"
      ? moved.automationExecution.execution.executionIssueId
      : null;
    const [issue] = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, executionIssueId!));
    expect(issue!.title).toBe("Content / In progress: Pulpit opinion piece");
  });

  it("rejects cross-company stage automation routines at save and execution", async () => {
    const company = await seedCompany();
    const otherCompany = await seedCompany();
    const routine = await seedRoutine(company.id, "Own routine");
    const otherRoutine = await seedRoutine(otherCompany.id, "Other routine");

    await expect(svc.createPipeline({
      companyId: company.id,
      key: "bad-automation",
      name: "Bad automation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: otherRoutine.id } } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    })).rejects.toMatchObject({ status: 422, details: { code: "validation" } });

    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "execution-automation",
      name: "Execution automation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "cross-company-execution",
      title: "Cross-company execution",
      actor: userActor,
    });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.automationExecution.status).toBe("succeeded");

    const [triggerEvent] = await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: created.case.id,
      type: "transitioned",
      actorType: "system",
      toStageId: moved.case.stageId,
      payload: { crossCompanyRoutine: true },
    }).returning();
    const [badExecution] = await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: created.case.id,
      automationId: moved.automationLedger!.automationId,
      triggeringEventId: triggerEvent!.id,
      routineId: otherRoutine.id,
      status: "failed",
      error: "pending_dispatch",
    }).returning();

    const retried = await svc.retryAutomation({
      companyId: company.id,
      caseId: created.case.id,
      automationId: moved.automationLedger!.automationId,
      actor: userActor,
    });
    expect(retried.status).toBe("failed");
    const [execution] = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.id, badExecution!.id));
    expect(execution!.error).toContain("same company");
    const events = await svc.listCaseEvents(company.id, created.case.id);
    expect(events.filter((event) => event.type === "automation_failed")).toHaveLength(1);
  });

  it("auto-advances after retry creates a fresh terminal child rollup", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Retry child cleanup");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "retry-child-cleanup",
      name: "Retry child cleanup",
      actor: userActor,
      stages: [
        {
          key: "build",
          name: "Build",
          kind: "working",
          config: {
            autoAdvanceOnChildrenTerminal: "review",
            onEnter: {
              type: "run_routine",
              id: "build-children",
              routineId: routine.id,
            },
          },
        },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const parent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "parent",
      title: "Parent",
      actor: userActor,
    });
    const [event] = await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: parent.case.id,
      type: "transitioned",
      actorType: "system",
      toStageId: parent.case.stageId,
      payload: { test: true },
    }).returning();
    const [attempt] = await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: parent.case.id,
      automationId: "build-children",
      triggeringEventId: event!.id,
      routineId: routine.id,
      status: "failed",
      error: "boom",
    }).returning();
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "child",
      title: "Child",
      parentCaseId: parent.case.id,
      actor: userActor,
    });
    await db
      .update(pipelineCases)
      .set({ automationAttemptId: attempt!.id })
      .where(eq(pipelineCases.id, child.case.id));
    await svc.transitionCase({
      companyId: company.id,
      caseId: child.case.id,
      toStageKey: "done",
      expectedVersion: child.case.version,
      actor: userActor,
    });
    const [reviewingParent] = await db
      .select({ version: pipelineCases.version, stageKey: pipelineStages.key })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
      .where(eq(pipelineCases.id, parent.case.id));
    expect(reviewingParent!.stageKey).toBe("review");

    const retry = await svc.retryStageAutomation({
      companyId: company.id,
      caseId: parent.case.id,
      scope: "previous_stage",
      targetStageId: event!.toStageId,
      expectedVersion: reviewingParent!.version,
      cleanup: {
        retireDirectChildren: true,
        retireDescendants: true,
        cancelLinkedAutomationIssues: true,
      },
      actor: userActor,
    });
    const retryChild = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "retry-child",
      title: "Retry child",
      parentCaseId: parent.case.id,
      actor: userActor,
    });
    await db
      .update(pipelineCases)
      .set({ automationAttemptId: retry.automationLedger.id })
      .where(eq(pipelineCases.id, retryChild.case.id));
    await svc.transitionCase({
      companyId: company.id,
      caseId: retryChild.case.id,
      toStageKey: "done",
      expectedVersion: retryChild.case.version,
      actor: userActor,
    });

    const [freshParent] = await db
      .select({ childCount: pipelineCases.childCount, terminalChildCount: pipelineCases.terminalChildCount, stageKey: pipelineStages.key })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
      .where(eq(pipelineCases.id, parent.case.id));
    const [freshChild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, child.case.id));
    expect(freshParent!.childCount).toBe(2);
    expect(freshParent!.terminalChildCount).toBe(2);
    expect(freshParent!.stageKey).toBe("review");
    expect(freshChild!.terminalKind).toBe("cancelled");
    expect(freshChild!.retiredReason).toBe("automation_retry");
    const events = await svc.listCaseEvents(company.id, parent.case.id);
    expect(events.filter((pipelineEvent) => pipelineEvent.type === "children_terminal")).toHaveLength(2);
  });

  it("updates intermediate terminal counts when retry retires descendants only", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Retry descendants only");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "retry-descendants-only",
      name: "Retry descendants only",
      actor: userActor,
      stages: [
        {
          key: "build",
          name: "Build",
          kind: "working",
          config: {
            onEnter: {
              type: "run_routine",
              id: "build-descendants",
              routineId: routine.id,
            },
          },
        },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const parent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "descendants-parent",
      title: "Descendants parent",
      actor: userActor,
    });
    const [event] = await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: parent.case.id,
      type: "transitioned",
      actorType: "system",
      toStageId: parent.case.stageId,
      payload: { test: true },
    }).returning();
    const [attempt] = await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: parent.case.id,
      automationId: "build-descendants",
      triggeringEventId: event!.id,
      routineId: routine.id,
      status: "failed",
      error: "boom",
    }).returning();
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "descendants-child",
      title: "Descendants child",
      parentCaseId: parent.case.id,
      actor: userActor,
    });
    await db
      .update(pipelineCases)
      .set({ automationAttemptId: attempt!.id })
      .where(eq(pipelineCases.id, child.case.id));
    const grandchild = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "descendants-grandchild",
      title: "Descendants grandchild",
      parentCaseId: child.case.id,
      actor: userActor,
    });

    await svc.retryStageAutomation({
      companyId: company.id,
      caseId: parent.case.id,
      scope: "current_stage",
      expectedVersion: parent.case.version,
      cleanup: {
        retireDirectChildren: false,
        retireDescendants: true,
        cancelLinkedAutomationIssues: false,
      },
      actor: userActor,
    });

    const [freshParent] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, parent.case.id));
    const [freshChild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, child.case.id));
    const [freshGrandchild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, grandchild.case.id));
    expect(freshParent!.terminalChildCount).toBe(0);
    expect(freshChild!.terminalKind).toBeNull();
    expect(freshChild!.terminalChildCount).toBe(1);
    expect(freshGrandchild!.terminalKind).toBe("cancelled");
    expect(freshGrandchild!.retiredReason).toBe("automation_retry");
  });
});
