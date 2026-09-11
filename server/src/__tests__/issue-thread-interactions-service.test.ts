import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  instanceSettings,
  issueRelations,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND, type AskUserQuestionsResult } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { recoveryService } from "../services/recovery/service.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueThreadInteractionService", () => {
  let db!: ReturnType<typeof createDb>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-thread-interactions-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
    interactionsSvc = issueThreadInteractionService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(workspaceOperations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedConfirmationIssue(title = "Comment supersede") {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title,
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });

    return { companyId, goalId, issueId };
  }

  async function attachPlanDocument(companyId: string, issueId: string) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "# Plan",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "# Plan",
    });
    return {
      type: "issue_document" as const,
      issueId,
      documentId,
      key: "plan",
      revisionId,
      revisionNumber: 1,
    };
  }

  async function recordReviewTransition(args: {
    companyId: string;
    issueId: string;
    interactionId: string;
    actorId?: string;
  }) {
    await db.insert(activityLog).values({
      companyId: args.companyId,
      actorType: "user",
      actorId: args.actorId ?? "local-board",
      action: "issue.updated",
      entityType: "issue",
      entityId: args.issueId,
      details: {
        status: "in_review",
        reviewInteractionId: args.interactionId,
        _previous: { status: "in_progress" },
      },
    });
  }

  it("creates idempotent, human-addressed connection intents and supersedes older runs", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Connection intent");
    const agentId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Researcher",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: firstRunId,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "user-board",
        contextSnapshot: { issueId },
      },
      {
        id: secondRunId,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "user-board",
        contextSnapshot: { issueId },
      },
    ]);
    const payload = {
      version: 1 as const,
      serviceSlug: "notion",
      serviceName: "Notion",
      serviceLogoUrl: null,
      requestingAgentId: agentId,
      requestingAgentName: "Researcher",
      phase: "requested" as const,
    };
    const first = await interactionsSvc.createConnectionIntent(
      { id: issueId, companyId },
      {
        payload,
        sourceRunId: firstRunId,
        addresseeUserId: "user-board",
        idempotencyKey: `connection-intent:${firstRunId}:notion`,
      },
    );
    expect(first).toMatchObject({
      kind: "connection_intent",
      status: "pending",
      continuationPolicy: "wake_assignee",
      addresseeUserId: "user-board",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      payload,
    });
    const repeated = await interactionsSvc.createConnectionIntent(
      { id: issueId, companyId },
      {
        payload,
        sourceRunId: firstRunId,
        addresseeUserId: "user-board",
        idempotencyKey: `connection-intent:${firstRunId}:notion`,
      },
    );
    expect(repeated.id).toBe(first.id);

    const newer = await interactionsSvc.createConnectionIntent(
      { id: issueId, companyId },
      {
        payload,
        sourceRunId: secondRunId,
        addresseeUserId: "user-board",
        idempotencyKey: `connection-intent:${secondRunId}:notion`,
      },
    );
    const superseded = await interactionsSvc.getById(first.id);
    expect(superseded).toMatchObject({
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded",
        supersededByInteractionId: newer.id,
      },
    });

    const [expiredByComment] = await interactionsSvc.expireRequestConfirmationsSupersededByComment(
      { id: issueId, companyId },
      {
        id: randomUUID(),
        createdAt: new Date(Date.now() + 1_000),
        authorUserId: "user-board",
        createdByRunId: null,
      },
      { userId: "user-board" },
    );
    expect(expiredByComment).toMatchObject({
      id: newer.id,
      status: "expired",
      result: {
        version: 1,
        outcome: "expired",
        reason: "Superseded by a newer user comment",
      },
    });
  });

  it("persists addressees without allowing them to bypass human-only governance", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Agent-addressed interaction");
    const creatorAgentId = randomUUID();
    const addresseeAgentId = randomUUID();
    const unrelatedAgentId = randomUUID();
    const addresseeRunId = randomUUID();
    const unrelatedRunId = randomUUID();
    const agentRows = [
      { id: creatorAgentId, name: "Creator" },
      { id: addresseeAgentId, name: "Addressee" },
      { id: unrelatedAgentId, name: "Unrelated" },
    ].map((agent) => ({
      ...agent,
      companyId,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }));
    await db.insert(agents).values(agentRows);
    await db.insert(heartbeatRuns).values([
      {
        id: addresseeRunId,
        companyId,
        agentId: addresseeAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date("2026-07-25T12:00:00.000Z"),
      },
      {
        id: unrelatedRunId,
        companyId,
        agentId: unrelatedAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date("2026-07-25T12:01:00.000Z"),
      },
    ]);

    const input = {
      kind: "ask_user_questions" as const,
      resolverPolicy: "board_or_agents" as const,
      addresseeAgentId,
      continuationPolicy: "wake_assignee" as const,
      payload: {
        version: 1 as const,
        questions: [{
          id: "scope",
          prompt: "Which scope?",
          selectionMode: "single" as const,
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    };
    const created = await interactionsSvc.create(
      { id: issueId, companyId },
      input,
      { agentId: creatorAgentId },
    );
    expect(created).toMatchObject({
      addresseeAgentId,
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
    });

    const answered = await interactionsSvc.answerQuestions(
      { id: issueId, companyId },
      created.id,
      { answers: [{ questionId: "scope", optionIds: ["phase-1"] }] },
      { agentId: addresseeAgentId, runId: addresseeRunId },
    );
    expect(answered).toMatchObject({
      status: "answered",
      addresseeAgentId,
      resolvedByAgentId: addresseeAgentId,
      resolvedByRunId: addresseeRunId,
    });

    const second = await interactionsSvc.create(
      { id: issueId, companyId },
      { ...input, idempotencyKey: "addressed:second" },
      { agentId: creatorAgentId },
    );
    await expect(interactionsSvc.answerQuestions(
      { id: issueId, companyId },
      second.id,
      { answers: [{ questionId: "scope", optionIds: ["phase-1"] }] },
      { agentId: unrelatedAgentId, runId: unrelatedRunId },
    )).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("addressed agent"),
    });

    const boardOnly = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        ...input,
        resolverPolicy: "board_only",
        idempotencyKey: "addressed:board-only",
      },
      { agentId: creatorAgentId },
    );
    await expect(interactionsSvc.answerQuestions(
      { id: issueId, companyId },
      boardOnly.id,
      { answers: [{ questionId: "scope", optionIds: ["phase-1"] }] },
      { agentId: addresseeAgentId, runId: addresseeRunId },
    )).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("human-only"),
    });

    await expect(interactionsSvc.create(
      { id: issueId, companyId },
      { ...input, addresseeAgentId: creatorAgentId },
      { agentId: creatorAgentId },
    )).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("themselves"),
    });
  });

  it("cancels addressed interactions before deleting the addressee", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Deleted interaction addressee");
    const creatorAgentId = randomUUID();
    const addresseeAgentId = randomUUID();
    const unrelatedAgentId = randomUUID();
    const unrelatedRunId = randomUUID();
    await db.insert(agents).values([
      { id: creatorAgentId, name: "Creator" },
      { id: addresseeAgentId, name: "Addressee" },
      { id: unrelatedAgentId, name: "Unrelated" },
    ].map((agent) => ({
      ...agent,
      companyId,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    await db.insert(heartbeatRuns).values({
      id: unrelatedRunId,
      companyId,
      agentId: unrelatedAgentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date("2026-07-25T12:02:00.000Z"),
    });

    const created = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "ask_user_questions",
        resolverPolicy: "board_or_agents",
        addresseeAgentId,
        payload: {
          version: 1,
          questions: [{
            id: "scope",
            prompt: "Which scope?",
            selectionMode: "single",
            options: [{ id: "phase-1", label: "Phase 1" }],
          }],
        },
      },
      { agentId: creatorAgentId },
    );

    await agentService(db).remove(addresseeAgentId);

    const cancelled = await interactionsSvc.getById(created.id);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      addresseeAgentId: null,
      resolvedByAgentId: null,
      resolvedByRunId: null,
      resolvedByUserId: null,
      result: {
        version: 1,
        outcome: "addressee_deleted",
        reason: "Cancelled because the addressed agent was deleted",
      },
    });
    await expect(interactionsSvc.answerQuestions(
      { id: issueId, companyId },
      created.id,
      { answers: [{ questionId: "scope", optionIds: ["phase-1"] }] },
      { agentId: unrelatedAgentId, runId: unrelatedRunId },
    )).rejects.toMatchObject({
      status: 409,
      message: "Interaction has already been resolved",
    });
  });

  it.each(["paused", "pending_approval", "terminated"])(
    "rejects %s interaction addressees",
    async (status) => {
      const { companyId, issueId } = await seedConfirmationIssue(`Reject ${status} addressee`);
      const creatorAgentId = randomUUID();
      const addresseeAgentId = randomUUID();
      await db.insert(agents).values([
        {
          id: creatorAgentId,
          companyId,
          name: "Creator",
          role: "engineer",
          status: "active",
        },
        {
          id: addresseeAgentId,
          companyId,
          name: "Unavailable addressee",
          role: "engineer",
          status,
        },
      ]);

      await expect(interactionsSvc.create(
        { id: issueId, companyId },
        {
          kind: "ask_user_questions",
          addresseeAgentId,
          payload: {
            version: 1,
            questions: [{
              id: "scope",
              prompt: "Which scope?",
              selectionMode: "single",
              options: [{ id: "phase-1", label: "Phase 1" }],
            }],
          },
        },
        { agentId: creatorAgentId },
      )).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("invokable agent"),
        details: expect.objectContaining({ reason: status }),
      });
    },
  );

  it("rejects interaction addressees with an invalid reporting chain", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Reject uninvokable addressee chain");
    const creatorAgentId = randomUUID();
    const managerAgentId = randomUUID();
    const addresseeAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "Creator",
        role: "engineer",
        status: "active",
      },
      {
        id: managerAgentId,
        companyId,
        name: "Terminated manager",
        role: "manager",
        status: "terminated",
      },
      {
        id: addresseeAgentId,
        companyId,
        name: "Unavailable addressee",
        role: "engineer",
        status: "active",
        reportsTo: managerAgentId,
      },
    ]);

    await expect(interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "ask_user_questions",
        addresseeAgentId,
        payload: {
          version: 1,
          questions: [{
            id: "scope",
            prompt: "Which scope?",
            selectionMode: "single",
            options: [{ id: "phase-1", label: "Phase 1" }],
          }],
        },
      },
      { agentId: creatorAgentId },
    )).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("invokable agent"),
      details: expect.objectContaining({
        reason: "manager_terminated",
        managerId: managerAgentId,
      }),
    });
  });

  it("accepts suggested tasks by creating a rooted issue tree under the current issue", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const assigneeAgentId = randomUUID();
    const responsibleUserId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Persist thread interactions",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 2,
      responsibleUserId,
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [
          {
            clientKey: "root",
            title: "Create the root follow-up",
            workMode: "planning",
            assigneeAgentId,
          },
          {
            clientKey: "child",
            parentClientKey: "root",
            title: "Create the nested follow-up",
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    expect(created.status).toBe("pending");

    const accepted = await interactionsSvc.acceptSuggestedTasks({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.interaction.kind).toBe("suggest_tasks");
    expect(accepted.interaction.status).toBe("accepted");
    expect(accepted.interaction.result).toMatchObject({
      version: 1,
      createdTasks: [
        expect.objectContaining({ clientKey: "root", parentIssueId: issueId }),
        expect.objectContaining({ clientKey: "child" }),
      ],
    });
    expect(accepted.createdIssues).toEqual([
      expect.objectContaining({
        assigneeAgentId,
        status: "todo",
      }),
      expect.objectContaining({
        assigneeAgentId: null,
        status: "todo",
      }),
    ]);
    const createdIssueRows = await db
      .select({
        title: issues.title,
        workMode: issues.workMode,
        responsibleUserId: issues.responsibleUserId,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(createdIssueRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Create the root follow-up", workMode: "planning" }),
        expect.objectContaining({ title: "Create the nested follow-up", workMode: "standard" }),
      ]),
    );
    expect(createdIssueRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Create the root follow-up", responsibleUserId }),
        expect.objectContaining({ title: "Create the nested follow-up", responsibleUserId }),
      ]),
    );

    const children = await issuesSvc.list(companyId, { parentId: issueId });
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe("Create the root follow-up");

    const nestedChildren = await issuesSvc.list(companyId, { parentId: children[0]!.id });
    expect(nestedChildren).toHaveLength(1);
    expect(nestedChildren[0]?.title).toBe("Create the nested follow-up");
    expect(nestedChildren[0]?.requestDepth).toBe(4);

    const listed = await interactionsSvc.listForIssue(issueId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("accepted");

    await expect(interactionsSvc.acceptSuggestedTasks({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    })).rejects.toThrow("Interaction has already been resolved");

    const childrenAfterDuplicateAccept = await issuesSvc.list(companyId, { parentId: issueId });
    expect(childrenAfterDuplicateAccept).toHaveLength(1);
  });

  it("accepts a selected subset of suggested tasks and records the skipped drafts", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Selectively persist thread interactions",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 2,
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [
          {
            clientKey: "root",
            title: "Create the root follow-up",
          },
          {
            clientKey: "child",
            parentClientKey: "root",
            title: "Create the nested follow-up",
          },
          {
            clientKey: "sibling",
            title: "Create the sibling follow-up",
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    const accepted = await interactionsSvc.acceptSuggestedTasks({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedClientKeys: ["root"],
    }, {
      userId: "local-board",
    });

    expect(accepted.interaction.result).toMatchObject({
      version: 1,
      createdTasks: [
        expect.objectContaining({ clientKey: "root", parentIssueId: issueId }),
      ],
      skippedClientKeys: ["child", "sibling"],
    });

    const children = await issuesSvc.list(companyId, { parentId: issueId });
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe("Create the root follow-up");
  });

  it("rejects partial acceptance when a selected task omits its selected-tree parent", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Validate selective acceptance",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [
          {
            clientKey: "root",
            title: "Create the root follow-up",
          },
          {
            clientKey: "child",
            parentClientKey: "root",
            title: "Create the nested follow-up",
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    await expect(
      interactionsSvc.acceptSuggestedTasks({
        id: issueId,
        companyId,
        goalId,
        projectId: null,
      }, created.id, {
        selectedClientKeys: ["child"],
      }, {
        userId: "local-board",
      }),
    ).rejects.toThrow("requires its parent");
  });

  it("persists validated answers for ask_user_questions interactions", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Persist question answers",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Question parent",
      status: "todo",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Choose the scope",
            selectionMode: "single",
            required: true,
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          },
          {
            id: "extras",
            prompt: "Optional extras",
            selectionMode: "multi",
            options: [
              { id: "tests", label: "Tests" },
              { id: "docs", label: "Docs" },
            ],
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    const answered = await interactionsSvc.answerQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      answers: [
        { questionId: "scope", optionIds: [], otherText: "Custom Phase 1" },
        {
          questionId: "extras",
          optionIds: ["docs", "tests", "docs"],
          otherText: "  Pair with release notes  ",
        },
      ],
      summaryMarkdown: "Ship Phase 1 with tests and docs.",
    }, {
      userId: "local-board",
    });

    expect(answered.status).toBe("answered");
    expect(answered.result).toEqual({
      version: 1,
      answers: [
        { questionId: "scope", optionIds: [], otherText: "Custom Phase 1" },
        { questionId: "extras", optionIds: ["docs", "tests"], otherText: "Pair with release notes" },
      ],
      summaryMarkdown: "Ship Phase 1 with tests and docs.",
    });

    await expect(interactionsSvc.answerQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      answers: [
        { questionId: "scope", optionIds: ["phase-2"] },
      ],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Interaction has already been resolved");
  });

  it("persists cancelled ask_user_questions interactions without answer data", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Cancel question answers",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Question parent",
      status: "in_review",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          required: true,
          options: [
            { id: "phase-1", label: "Phase 1" },
            { id: "phase-2", label: "Phase 2" },
          ],
        }],
      },
    }, {
      userId: "local-board",
    });

    const cancelled = await interactionsSvc.cancelQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      reason: "Not needed anymore",
    }, {
      userId: "local-board",
    });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.result).toEqual({
      version: 1,
      answers: [],
      cancelled: true,
      cancellationReason: "Not needed anymore",
      summaryMarkdown: null,
    });

    await expect(interactionsSvc.answerQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      answers: [{ questionId: "scope", optionIds: ["phase-1"] }],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Interaction has already been resolved");
  });

  it("skips every durable interaction kind exactly once and retains partial item verdicts", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Universal composer Skip");
    const inputs = [
      {
        kind: "suggest_tasks" as const,
        payload: { version: 1 as const, tasks: [{ clientKey: "child", title: "Create child" }] },
      },
      {
        kind: "ask_user_questions" as const,
        payload: {
          version: 1 as const,
          questions: [{
            id: "scope",
            prompt: "Scope?",
            selectionMode: "single" as const,
            options: [{ id: "one", label: "One" }],
          }],
        },
      },
      {
        kind: "request_confirmation" as const,
        payload: { version: 1 as const, prompt: "Proceed?" },
      },
      {
        kind: "request_checkbox_confirmation" as const,
        payload: { version: 1 as const, prompt: "Select", options: [{ id: "one", label: "One" }] },
      },
    ];

    for (const input of inputs) {
      const created = await interactionsSvc.create({ id: issueId, companyId }, input, { userId: "local-board" });
      const skipped = await interactionsSvc.skipInteraction(
        { id: issueId, companyId, status: "in_progress" },
        created.id,
        {},
        { userId: "local-board" },
      );
      expect(skipped).toMatchObject({ status: "cancelled", result: { version: 1, outcome: "skipped" } });
      if (skipped.kind === "ask_user_questions") {
        expect(skipped.result).toMatchObject({ answers: [], cancelled: true });
      }
      await expect(interactionsSvc.skipInteraction(
        { id: issueId, companyId, status: "in_progress" },
        created.id,
        {},
        { userId: "local-board" },
      )).rejects.toThrow("Interaction has already been resolved");
    }

    const verdicts = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review items",
        items: [{ id: "one", label: "One" }, { id: "two", label: "Two" }],
      },
    }, { userId: "local-board" });
    await interactionsSvc.submitItemVerdicts(
      { id: issueId, companyId },
      verdicts.id,
      { verdicts: [{ id: "one", verdict: "approve" }] },
      { userId: "local-board" },
    );
    const skippedVerdicts = await interactionsSvc.skipInteraction(
      { id: issueId, companyId, status: "in_progress" },
      verdicts.id,
      {},
      { userId: "local-board" },
    );
    expect(skippedVerdicts).toMatchObject({
      status: "cancelled",
      result: { outcome: "skipped", complete: false, items: [{ id: "one", verdict: "approve" }] },
    });
  });

  it("expires ask_user_questions interactions by default when a user comments after creation", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Question supersede");
    const commentId = randomUUID();

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "local-board",
    });

    expect(created).toMatchObject({
      kind: "ask_user_questions",
      payload: {
        supersedeOnUserComment: true,
      },
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      kind: "ask_user_questions",
      status: "expired",
      result: {
        version: 1,
        answers: [],
        expirationReason: "superseded_by_comment",
        commentId,
        summaryMarkdown: null,
      },
      resolvedByUserId: "local-board",
    });
  });

  it("keeps ask_user_questions pending when user-comment supersede is explicitly disabled", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Question supersede opt-out");

    await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        supersedeOnUserComment: false,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(Date.now() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("does not supersede ask_user_questions for agent, system, or older user comments", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Question supersede exclusions");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "local-board",
    });
    const createdAtMs = new Date(created.createdAt).getTime();

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs + 1_000),
      authorUserId: null,
    }, {
      agentId: randomUUID(),
    })).resolves.toHaveLength(0);

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs + 1_000),
      authorUserId: null,
    }, {})).resolves.toHaveLength(0);

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs - 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    })).resolves.toHaveLength(0);

    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("repairs historical ask_user_questions superseded by later user comments idempotently", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Historical question supersede");
    const commentId = randomUUID();
    const createdAt = new Date("2026-05-18T12:00:00.000Z");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
    }, {
      userId: "local-board",
    });
    await db
      .update(issueThreadInteractions)
      .set({ createdAt, updatedAt: createdAt })
      .where(eq(issueThreadInteractions.id, created.id));

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorType: "system",
      body: "System-side progress note.",
      createdAt: new Date("2026-05-18T12:00:30.000Z"),
      updatedAt: new Date("2026-05-18T12:00:30.000Z"),
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "local-board",
      authorType: "user",
      body: "Please revise this first.",
      createdAt: new Date("2026-05-18T12:01:00.000Z"),
      updatedAt: new Date("2026-05-18T12:01:00.000Z"),
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      kind: "ask_user_questions",
      status: "expired",
      result: {
        version: 1,
        answers: [],
        expirationReason: "superseded_by_comment",
        commentId,
        summaryMarkdown: null,
      },
      resolvedByAgentId: null,
      resolvedByUserId: "local-board",
    });

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    })).resolves.toEqual([]);
  });

  it("reuses the existing interaction when the same idempotency key is submitted twice", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Interaction dedupe",
      level: "task",
      status: "active",
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
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date("2026-04-20T12:00:00.000Z"),
    });

    const input = {
      kind: "ask_user_questions" as const,
      idempotencyKey: "run-1:questionnaire",
      sourceRunId: runId,
      continuationPolicy: "wake_assignee" as const,
      payload: {
        version: 1 as const,
        questions: [
          {
            id: "scope",
            prompt: "Pick a scope",
            selectionMode: "single" as const,
            options: [{ id: "phase-2", label: "Phase 2" }],
          },
        ],
      },
    };

    const first = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, input, {
      agentId,
    });

    const second = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, input, {
      agentId,
    });

    expect(second.id).toBe(first.id);
    expect(second.sourceRunId).toBe(runId);

    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe("run-1:questionnaire");
  });

  it("supersedes older pending confirmations from the same agent without crossing agent or kind", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Newer confirmation supersedes older");
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "First agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "Second agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const older = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      idempotencyKey: "confirmation:first:older",
      payload: { version: 1, prompt: "Approve the older draft?" },
    }, { agentId: firstAgentId });
    const otherKind = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_checkbox_confirmation",
      idempotencyKey: "checkbox:first",
      payload: {
        version: 1,
        prompt: "Select regions",
        options: [{ id: "us", label: "US" }],
      },
    }, { agentId: firstAgentId });
    const otherAgent = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      idempotencyKey: "confirmation:second",
      payload: { version: 1, prompt: "Approve the second agent's draft?" },
    }, { agentId: secondAgentId });
    const replacement = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      idempotencyKey: "confirmation:first:newer",
      payload: { version: 1, prompt: "Approve the newer draft?" },
    }, { agentId: firstAgentId });

    const interactions = await interactionsSvc.listForIssue(issueId);
    expect(interactions.find((interaction) => interaction.id === older.id)).toMatchObject({
      status: "expired",
      resolvedByAgentId: firstAgentId,
      result: {
        outcome: "superseded_by_newer_request",
        supersededByInteractionId: replacement.id,
      },
    });
    expect(interactions.find((interaction) => interaction.id === replacement.id)?.status).toBe("pending");
    expect(interactions.find((interaction) => interaction.id === otherAgent.id)?.status).toBe("pending");
    expect(interactions.find((interaction) => interaction.id === otherKind.id)?.status).toBe("pending");
  });

  it("supersedes an agent's own older pending ask_user_questions without crossing agent, kind, or issue", async () => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue("Question supersedes older sibling");
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      goalId,
      title: "Other issue",
      status: "in_progress",
      priority: "medium",
    });

    const probingAgentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: probingAgentId,
        companyId,
        name: "Probing agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const question = (prompt: string) => ({
      kind: "ask_user_questions" as const,
      payload: {
        version: 1 as const,
        questions: [{
          id: "q",
          prompt,
          selectionMode: "single" as const,
          options: [{ id: "opt", label: "Option" }],
        }],
      },
    });

    const older = await interactionsSvc.create(
      { id: issueId, companyId }, question("Older question"), { agentId: probingAgentId },
    );
    const otherKind = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Approve the draft?" },
    }, { agentId: probingAgentId });
    const otherAgentQuestion = await interactionsSvc.create(
      { id: issueId, companyId }, question("Other agent question"), { agentId: otherAgentId },
    );
    const otherIssueQuestion = await interactionsSvc.create(
      { id: otherIssueId, companyId }, question("Other issue question"), { agentId: probingAgentId },
    );
    const replacement = await interactionsSvc.create(
      { id: issueId, companyId }, question("Newer question"), { agentId: probingAgentId },
    );

    const interactions = await interactionsSvc.listForIssue(issueId);
    expect(interactions.find((interaction) => interaction.id === older.id)).toMatchObject({
      status: "expired",
      resolvedByAgentId: probingAgentId,
      result: {
        answers: [],
        expirationReason: "superseded_by_newer_interaction",
        supersededByInteractionId: replacement.id,
      },
    });
    expect(interactions.find((interaction) => interaction.id === replacement.id)?.status).toBe("pending");
    // A different agent's pending question is untouched.
    expect(interactions.find((interaction) => interaction.id === otherAgentQuestion.id)?.status).toBe("pending");
    // A different kind from the same agent is untouched.
    expect(interactions.find((interaction) => interaction.id === otherKind.id)?.status).toBe("pending");

    // The same agent's question on a different issue is untouched.
    const otherIssueInteractions = await interactionsSvc.listForIssue(otherIssueId);
    expect(otherIssueInteractions.find((interaction) => interaction.id === otherIssueQuestion.id)?.status)
      .toBe("pending");
  });

  it("leaves exactly one pending ask_user_questions on the onboarding first task after probe cards and the real question arrive", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Chief of staff",
      role: "chief_of_staff",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Your first task",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Your first task",
      status: "in_progress",
      priority: "medium",
      originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND,
      assigneeAgentId: agentId,
    });

    // Reproduces PAP-436: the assigned agent posts two throwaway schema probes
    // (title/prompt/option "t"/"p"/"L") before the genuine question.
    const probe = (prompt: string) => ({
      kind: "ask_user_questions" as const,
      payload: {
        version: 1 as const,
        questions: [{
          id: "q",
          prompt,
          selectionMode: "single" as const,
          options: [{ id: "L", label: "L" }],
        }],
      },
    });
    await interactionsSvc.create({ id: issueId, companyId }, probe("t"), { agentId });
    await interactionsSvc.create({ id: issueId, companyId }, probe("p"), { agentId });
    await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "focus",
          prompt: "What would you like your team to focus on first?",
          selectionMode: "single",
          options: [
            { id: "mvp", label: "Ship the MVP" },
            { id: "bugs", label: "Fix bugs" },
          ],
        }],
      },
    }, { agentId });

    const interactions = await interactionsSvc.listForIssue(issueId);
    const pendingQuestions = interactions.filter(
      (interaction) => interaction.kind === "ask_user_questions" && interaction.status === "pending",
    );
    expect(pendingQuestions).toHaveLength(1);
    expect(pendingQuestions[0]?.kind).toBe("ask_user_questions");
    const [remaining] = pendingQuestions;
    if (remaining?.kind === "ask_user_questions") {
      expect(remaining.payload.questions[0]?.prompt).toContain("focus on first");
    }

    // Both probe cards auto-expired with the sibling-supersede reason.
    const expiredQuestions = interactions.filter(
      (interaction) => interaction.kind === "ask_user_questions" && interaction.status === "expired",
    );
    expect(expiredQuestions).toHaveLength(2);
    for (const card of expiredQuestions) {
      expect(card.result).toMatchObject({ expirationReason: "superseded_by_newer_interaction" });
    }
  });

  it("sweeps historical confirmation pile-ups idempotently per issue, kind, and agent", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Historical confirmation sweep");
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "First agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "Second agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const firstAgentIds = [randomUUID(), randomUUID(), randomUUID()];
    const secondAgentIds = [randomUUID(), randomUUID()];
    const checkboxId = randomUUID();
    await db.insert(issueThreadInteractions).values([
      ...firstAgentIds.map((id, index) => ({
        id,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: firstAgentId,
        payload: { version: 1 as const, prompt: `First agent draft ${index + 1}` },
        createdAt: new Date(`2026-07-01T12:0${index}:00.000Z`),
        updatedAt: new Date(`2026-07-01T12:0${index}:00.000Z`),
      })),
      ...secondAgentIds.map((id, index) => ({
        id,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: secondAgentId,
        payload: { version: 1 as const, prompt: `Second agent draft ${index + 1}` },
        createdAt: new Date(`2026-07-01T13:0${index}:00.000Z`),
        updatedAt: new Date(`2026-07-01T13:0${index}:00.000Z`),
      })),
      {
        id: checkboxId,
        companyId,
        issueId,
        kind: "request_checkbox_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: firstAgentId,
        payload: { version: 1, prompt: "Select one", options: [{ id: "one", label: "One" }] },
        createdAt: new Date("2026-07-01T14:00:00.000Z"),
        updatedAt: new Date("2026-07-01T14:00:00.000Z"),
      },
    ]);

    await expect(interactionsSvc.sweepSupersededPendingRequestConfirmations())
      .resolves.toEqual({ expired: 3 });
    await expect(interactionsSvc.sweepSupersededPendingRequestConfirmations())
      .resolves.toEqual({ expired: 0 });

    const interactions = await interactionsSvc.listForIssue(issueId);
    for (const id of firstAgentIds.slice(0, -1)) {
      expect(interactions.find((interaction) => interaction.id === id)).toMatchObject({
        status: "expired",
        result: {
          outcome: "superseded_by_newer_request",
          supersededByInteractionId: firstAgentIds.at(-1),
        },
      });
    }
    expect(interactions.find((interaction) => interaction.id === firstAgentIds.at(-1))?.status).toBe("pending");
    expect(interactions.find((interaction) => interaction.id === secondAgentIds[0])).toMatchObject({
      status: "expired",
      result: {
        outcome: "superseded_by_newer_request",
        supersededByInteractionId: secondAgentIds[1],
      },
    });
    expect(interactions.find((interaction) => interaction.id === secondAgentIds[1])?.status).toBe("pending");
    expect(interactions.find((interaction) => interaction.id === checkboxId)?.status).toBe("pending");
  });

  it("refuses to create an interaction on a closed issue", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Closed issue create guard");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    await expect(interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Approve after close?" },
    }, {
      userId: "local-board",
    })).rejects.toMatchObject({ status: 409 });

    const rows = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    expect(rows).toHaveLength(0);
  });

  it("accepts request_confirmation interactions without creating child issues", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Confirm a request",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Apply this plan?",
        acceptLabel: "Apply",
        rejectLabel: "Keep editing",
        detailsMarkdown: "Creates follow-up work after acceptance.",
      },
    }, {
      userId: "local-board",
    });

    expect(created.kind).toBe("request_confirmation");
    expect(created.status).toBe("pending");

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.createdIssues).toEqual([]);
    expect(accepted.interaction).toMatchObject({
      kind: "request_confirmation",
      status: "accepted",
      result: {
        version: 1,
        outcome: "accepted",
      },
      resolvedByUserId: "local-board",
    });

    const requiresReason = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Decline only with a reason?",
        rejectRequiresReason: true,
      },
    }, {
      userId: "local-board",
    });

    await expect(interactionsSvc.rejectInteraction({
      id: issueId,
      companyId,
    }, requiresReason.id, {}, {
      userId: "local-board",
    })).rejects.toThrow("A decline reason is required for this confirmation");
  });

  it("reopens an in-review issue before waking the assignee after rejection", async () => {
    const { companyId, issueId } = await seedConfirmationIssue(
      "Continue after review rejection",
    );
    const created = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Continue the next turn?",
          rejectLabel: "Continue work",
          rejectRequiresReason: true,
          target: {
            type: "custom",
            key: "warm_turn_1",
            revisionId: "warm-turn-1",
          },
        },
      },
      {
        userId: "local-board",
      },
    );
    await db
      .update(issues)
      .set({ status: "in_review" })
      .where(eq(issues.id, issueId));

    await interactionsSvc.rejectInteraction(
      {
        id: issueId,
        companyId,
        status: "in_review",
      },
      created.id,
      {
        reason: "Proceed with turn two.",
      },
      {
        userId: "local-board",
      },
    );

    await expect(issuesSvc.getById(issueId)).resolves.toMatchObject({
      status: "todo",
    });
  });

  it("records an authorized agent as the review-confirmation resolver", async () => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue("Agent review verdict");
    const resolverAgentId = randomUUID();
    const resolverRunId = randomUUID();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    await db.insert(agents).values({
      id: resolverAgentId,
      companyId,
      name: "Review agent",
      role: "reviewer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: resolverRunId,
      companyId,
      agentId: resolverAgentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
    });
    const created = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Approve this review?" },
      resolverPolicy: "anyone",
    }, {
      userId: "local-board",
    });
    await recordReviewTransition({ companyId, issueId, interactionId: created.id });

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      agentId: resolverAgentId,
      runId: resolverRunId,
      resolverPolicyRestriction: "anyone",
    });

    expect(accepted.interaction).toMatchObject({
      status: "accepted",
      resolvedByAgentId: resolverAgentId,
      resolvedByRunId: resolverRunId,
      resolvedByUserId: null,
    });
  });

  it.each(["accept", "reject"] as const)(
    "revalidates review policy under the issue lock before interaction %s",
    async (action) => {
      const { companyId, goalId, issueId } = await seedConfirmationIssue(`Locked ${action} policy`);
      const resolverAgentId = randomUUID();
      const resolverRunId = randomUUID();
      await db.insert(agents).values({
        id: resolverAgentId,
        companyId,
        name: "Review agent",
        role: "reviewer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: resolverRunId,
        companyId,
        agentId: resolverAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      });
      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        payload: { version: 1, prompt: "Approve this review?" },
      }, {
        userId: "local-board",
      });
      await db.update(issues)
        .set({ status: "in_review", reviewPolicy: "anyone" })
        .where(eq(issues.id, issueId));
      await recordReviewTransition({ companyId, issueId, interactionId: created.id });

      let releasePolicyLock!: () => void;
      let policyLockReady!: () => void;
      const holdPolicyLock = new Promise<void>((resolve) => {
        releasePolicyLock = resolve;
      });
      const policyLocked = new Promise<void>((resolve) => {
        policyLockReady = resolve;
      });
      const tightenPolicy = db.transaction(async (tx) => {
        await tx.select({ id: issues.id })
          .from(issues)
          .where(eq(issues.id, issueId))
          .for("update");
        await tx.update(issues)
          .set({ reviewPolicy: "human_only" })
          .where(eq(issues.id, issueId));
        policyLockReady();
        await holdPolicyLock;
      });
      await policyLocked;

      const actor = {
        agentId: resolverAgentId,
        runId: resolverRunId,
        reviewVerdictAuthorized: true,
      };
      const verdict = action === "accept"
        ? interactionsSvc.acceptInteraction({
            id: issueId,
            companyId,
            goalId,
            projectId: null,
            status: "in_review",
          }, created.id, {}, actor)
        : interactionsSvc.rejectInteraction({
            id: issueId,
            companyId,
            status: "in_review",
          }, created.id, { reason: "Needs changes" }, actor);
      let verdictSettled = false;
      void verdict.then(
        () => { verdictSettled = true; },
        () => { verdictSettled = true; },
      );
      const denied = expect(verdict).rejects.toMatchObject({
        status: 403,
        details: expect.objectContaining({
          code: "review_policy_denied",
          policy: "human_only",
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(verdictSettled).toBe(false);
      releasePolicyLock();
      await tightenPolicy;
      await denied;

      const persisted = await db.select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id))
        .then((rows) => rows[0]);
      expect(persisted?.status).toBe("pending");
    },
  );

  it("preserves creator and same-run guards for authorized agent review verdicts", async () => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue("Guard agent review verdicts");
    const resolverAgentId = randomUUID();
    const resolverRunId = randomUUID();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    await db.insert(agents).values({
      id: resolverAgentId,
      companyId,
      name: "Review agent",
      role: "reviewer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: resolverRunId,
      companyId,
      agentId: resolverAgentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
    });

    const createdByResolver = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Approve your own request?" },
      resolverPolicy: "anyone",
    }, {
      userId: "local-board",
    });
    await db.update(issueThreadInteractions)
      .set({ createdByAgentId: resolverAgentId })
      .where(eq(issueThreadInteractions.id, createdByResolver.id));
    await recordReviewTransition({ companyId, issueId, interactionId: createdByResolver.id });

    const createdBySameRun = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Approve the same run?",
        options: [{ id: "approve", label: "Approve" }],
      },
      resolverPolicy: "anyone",
    }, {
      userId: "local-board",
    });
    await db.update(issueThreadInteractions)
      .set({ sourceRunId: resolverRunId })
      .where(eq(issueThreadInteractions.id, createdBySameRun.id));

    const issue = { id: issueId, companyId, goalId, projectId: null };
    const actor = {
      agentId: resolverAgentId,
      runId: resolverRunId,
      resolverPolicyRestriction: "not_creator",
    };
    await expect(interactionsSvc.acceptInteraction(issue, createdByResolver.id, {}, actor))
      .rejects.toThrow("requires a resolver other than its creator or creating run");
    await db.update(activityLog).set({
      details: {
        status: "in_review",
        reviewInteractionId: createdBySameRun.id,
        _previous: { status: "in_progress" },
      },
    }).where(eq(activityLog.entityId, issueId));
    await expect(interactionsSvc.acceptInteraction(issue, createdBySameRun.id, {
      selectedOptionIds: ["approve"],
    }, actor)).rejects.toThrow("requires a resolver other than its creator or creating run");
  });

  it("accepts request_checkbox_confirmation interactions with selected option ids", async () => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue("Checkbox confirmation accept");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Which files should be deleted?",
        options: [
          { id: "file-a", label: "a.txt" },
          { id: "file-b", label: "b.txt" },
          { id: "file-c", label: "c.txt" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 0,
        maxSelected: 2,
      },
    }, {
      userId: "local-board",
    });

    expect(created).toMatchObject({
      kind: "request_checkbox_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: {
        supersedeOnUserComment: true,
        allowDeclineReason: true,
      },
    });

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedOptionIds: ["file-c", "file-a"],
    }, {
      userId: "local-board",
    });

    expect(accepted.createdIssues).toEqual([]);
    expect(accepted.interaction).toMatchObject({
      kind: "request_checkbox_confirmation",
      status: "accepted",
      result: {
        version: 1,
        outcome: "accepted",
        selectedOptionIds: ["file-a", "file-c"],
      },
      resolvedByUserId: "local-board",
    });
  });

  it("enforces request_checkbox_confirmation selected option references and bounds", async () => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue("Checkbox confirmation bounds");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Pick one or two options.",
        options: [
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
          { id: "three", label: "Three" },
        ],
        defaultSelectedOptionIds: ["one"],
        minSelected: 1,
        maxSelected: 2,
      },
    }, {
      userId: "local-board",
    });

    await expect(interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedOptionIds: [],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Select at least 1 checkbox confirmation option(s)");

    await expect(interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedOptionIds: ["missing"],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Unknown checkbox confirmation optionId: missing");

    await expect(interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedOptionIds: ["one", "two", "three"],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Select no more than 2 checkbox confirmation option(s)");
  });

  it("expires request_checkbox_confirmation interactions when a user comments after creation", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Checkbox confirmation supersede");
    const commentId = randomUUID();

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Which files should be deleted?",
        options: [{ id: "file-a", label: "a.txt" }],
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      kind: "request_checkbox_confirmation",
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        commentId,
      },
    });
  });

  it("submits request_item_verdicts partially and completes when all items are resolved", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Item verdict partial submit");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review generated artifacts.",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs" },
          { id: "tests", label: "Tests" },
        ],
      },
    }, {
      userId: "local-board",
    });

    expect(created).toMatchObject({
      kind: "request_item_verdicts",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: {
        verdicts: ["approve", "reject"],
        requireReasonOn: ["reject"],
        allowBulkApprove: true,
        supersedeOnUserComment: true,
      },
    });

    const first = await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "docs", verdict: "reject", reason: "Missing examples" }],
    }, {
      userId: "local-board",
    });

    expect(first.newlyResolvedItemIds).toEqual(["docs"]);
    expect(first.interaction).toMatchObject({
      kind: "request_item_verdicts",
      status: "pending",
      result: {
        version: 1,
        outcome: "resolved",
        complete: false,
        items: [
          {
            id: "docs",
            verdict: "reject",
            reason: "Missing examples",
            resolvedByUserId: "local-board",
          },
        ],
      },
      resolvedAt: null,
    });

    const duplicate = await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "docs", verdict: "reject" }],
    }, {
      userId: "local-board",
    });

    expect(duplicate.newlyResolvedItemIds).toEqual([]);
    expect(duplicate.interaction).toMatchObject({
      status: "pending",
      result: {
        complete: false,
        items: [
          {
            id: "docs",
            verdict: "reject",
            reason: "Missing examples",
          },
        ],
      },
    });

    const completed = await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [
        { id: "api", verdict: "approve" },
        { id: "tests", verdict: "reject", reason: "No route coverage" },
      ],
    }, {
      userId: "local-board",
    });

    expect(completed.newlyResolvedItemIds).toEqual(["api", "tests"]);
    expect(completed.interaction).toMatchObject({
      kind: "request_item_verdicts",
      status: "answered",
      result: {
        version: 1,
        outcome: "resolved",
        complete: true,
        items: [
          { id: "api", verdict: "approve" },
          { id: "docs", verdict: "reject", reason: "Missing examples" },
          { id: "tests", verdict: "reject", reason: "No route coverage" },
        ],
      },
      resolvedByUserId: "local-board",
    });

    const duplicateAfterComplete = await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "api", verdict: "approve" }],
    }, {
      userId: "local-board",
    });
    expect(duplicateAfterComplete.newlyResolvedItemIds).toEqual([]);
    expect(duplicateAfterComplete.interaction.status).toBe("answered");
  });

  it("enforces request_item_verdicts ids, enabled verdicts, and required reasons", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Item verdict validation");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review generated artifacts.",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs" },
        ],
      },
    }, {
      userId: "local-board",
    });

    await expect(interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "missing", verdict: "approve" }],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Unknown item verdict id: missing");

    await expect(interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "api", verdict: "defer" }],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Verdict defer is not enabled");

    await expect(interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "docs", verdict: "reject" }],
    }, {
      userId: "local-board",
    })).rejects.toThrow("A reason is required when verdict is reject");
  });

  it("preserves resolved request_item_verdicts items when a later user comment supersedes the pending remainder", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Item verdict supersede");
    const commentId = randomUUID();

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review generated artifacts.",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs" },
        ],
      },
    }, {
      userId: "local-board",
    });

    await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "api", verdict: "approve" }],
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      kind: "request_item_verdicts",
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        complete: false,
        commentId,
        items: [
          {
            id: "api",
            verdict: "approve",
            resolvedByUserId: "local-board",
          },
        ],
      },
    });
  });

  it("returns accepted agent confirmations from review without resetting active work", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Confirm a request",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Senior Product Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Review the plan",
      status: "in_review",
      priority: "medium",
      assigneeUserId: "local-board",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        acceptLabel: "Approve plan",
        rejectLabel: "Ask for changes",
      },
    }, {
      agentId,
    });

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.continuationIssue).toEqual({
      id: issueId,
      assigneeAgentId: agentId,
      assigneeUserId: null,
      status: "todo",
    });

    const updatedIssue = (await db.select().from(issues)).find((issue) => issue.id === issueId);
    expect(updatedIssue).toMatchObject({
      id: issueId,
      status: "todo",
      assigneeAgentId: agentId,
      assigneeUserId: null,
    });

    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: agentId,
        assigneeUserId: null,
      })
      .where(eq(issues.id, issueId));

    const agentOwnedConfirmation = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Approve the next step?",
      },
    }, {
      agentId,
    });

    const resumed = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, agentOwnedConfirmation.id, {}, {
      userId: "local-board",
    });

    expect(resumed.continuationIssue).toEqual({
      id: issueId,
      assigneeAgentId: agentId,
      assigneeUserId: null,
      status: "todo",
    });

    const resumedIssue = (await db.select().from(issues)).find((issue) => issue.id === issueId);
    expect(resumedIssue).toMatchObject({
      id: issueId,
      status: "todo",
      assigneeAgentId: agentId,
      assigneeUserId: null,
    });

    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, issueId));

    const activeConfirmation = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Approve while work is active?",
      },
    }, {
      agentId,
    });

    const acceptedWhileActive = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, activeConfirmation.id, {}, {
      userId: "local-board",
    });

    expect(acceptedWhileActive.continuationIssue).toBeNull();
    const activeIssue = (await db.select().from(issues)).find((issue) => issue.id === issueId);
    expect(activeIssue).toMatchObject({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
    });
  });

  it("atomically returns an accepted Plan-mode issue to its agent in Auto mode", async () => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue("Accept a plan into Auto mode");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plan owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(issues).set({
      status: "in_review",
      workMode: "planning",
      assigneeAgentId: agentId,
    }).where(eq(issues.id, issueId));
    const target = await attachPlanDocument(companyId, issueId);
    const created = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      payload: { version: 1, prompt: "Accept this plan?", target },
    }, { agentId });

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, { userId: "local-board" });

    expect(accepted.interaction).toMatchObject({
      id: created.id,
      status: "accepted",
      result: { outcome: "accepted" },
    });
    expect(accepted.continuationIssue).toEqual({
      id: issueId,
      assigneeAgentId: agentId,
      assigneeUserId: null,
      status: "todo",
      workMode: "standard",
    });
    await expect(db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0])).resolves.toMatchObject({
      status: "todo",
      workMode: "standard",
      assigneeAgentId: agentId,
      assigneeUserId: null,
    });
  });

  it("keeps Plan mode for non-plan and checkbox confirmations", async () => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue("Do not auto-transition other confirmations");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plan owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(issues).set({
      status: "in_review",
      workMode: "planning",
      assigneeAgentId: agentId,
    }).where(eq(issues.id, issueId));

    const nonPlan = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Accept this unrelated decision?" },
    }, { agentId });
    await interactionsSvc.acceptInteraction({ id: issueId, companyId, goalId, projectId: null }, nonPlan.id, {}, {
      userId: "local-board",
    });
    await expect(db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.workMode))
      .resolves.toBe("planning");

    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    const target = await attachPlanDocument(companyId, issueId);
    const checkbox = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Select approved plan sections",
        options: [{ id: "phase-1", label: "Phase 1" }],
        target,
      },
    }, { agentId });
    await interactionsSvc.acceptInteraction({ id: issueId, companyId, goalId, projectId: null }, checkbox.id, {
      selectedOptionIds: ["phase-1"],
    }, { userId: "local-board" });
    await expect(db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.workMode))
      .resolves.toBe("planning");
  });

  it.each(["ask", "standard"] as const)("keeps %s mode when accepting a plan confirmation", async (workMode) => {
    const { companyId, goalId, issueId } = await seedConfirmationIssue(`Keep ${workMode} mode`);
    await db.update(issues).set({ workMode }).where(eq(issues.id, issueId));
    const target = await attachPlanDocument(companyId, issueId);
    const created = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Accept this plan?", target },
    }, { userId: "local-board" });

    await interactionsSvc.acceptInteraction({ id: issueId, companyId, goalId, projectId: null }, created.id, {}, {
      userId: "local-board",
    });

    await expect(db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.workMode))
      .resolves.toBe(workMode);
  });

  it("keeps Plan mode when a plan confirmation is rejected", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Reject a plan");
    await db.update(issues).set({ workMode: "planning" }).where(eq(issues.id, issueId));
    const target = await attachPlanDocument(companyId, issueId);
    const created = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Accept this plan?", target },
    }, { userId: "local-board" });

    const rejected = await interactionsSvc.rejectInteraction({ id: issueId, companyId }, created.id, {
      reason: "Revise the plan",
    }, { userId: "local-board" });

    expect(rejected.status).toBe("rejected");
    await expect(db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.workMode))
      .resolves.toBe("planning");
  });

  it("expires request confirmations by default when a user comments after creation", async () => {
    const { companyId, issueId } = await seedConfirmationIssue();
    const commentId = randomUUID();

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });

    expect(created).toMatchObject({
      payload: {
        supersedeOnUserComment: true,
      },
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        commentId,
      },
      resolvedByUserId: "local-board",
    });
  });

  it("keeps request confirmations pending when user-comment supersede is explicitly disabled", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Comment supersede opt-out");

    await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
        supersedeOnUserComment: false,
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(Date.now() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("keeps legacy request confirmations pending when comment supersede was not stored", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Legacy confirmation without comment supersede flag");

    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: { kind: "none" },
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
      createdByUserId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(Date.now() + 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("lists interactions whose stored result predates the current schema without throwing (LOOA-629)", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Legacy result outcome");

    // Simulate a row persisted by an older build: a resolved confirmation whose
    // result.outcome is a value no longer in the current enum. A hard parse
    // would 500 the whole listForIssue call and brick every consumer (web
    // thread + Slack gateway notifier/digest/aging).
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "cancelled",
      continuationPolicy: { kind: "none" },
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
      result: {
        version: 1,
        outcome: "withdrawn_by_creator",
      },
      createdByUserId: "local-board",
    });

    const listed = await interactionsSvc.listForIssue(issueId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.kind).toBe("request_confirmation");
    // The unparseable result degrades to null; the interaction still lists.
    expect(listed[0]?.result).toBeNull();
    expect(listed[0]?.status).toBe("cancelled");
  });

  it("derives legacy pending interactions as expired on closed issues without mutating the GET", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Legacy pending interaction on closed issue");
    const created = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Proceed?" },
    }, { userId: "local-board" });

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    const listed = await interactionsSvc.listForIssue(issueId);
    expect(listed[0]).toMatchObject({
      id: created.id,
      status: "expired",
      result: { version: 1, outcome: "issue_closed" },
    });

    const stored = await db
      .select({ status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, created.id))
      .then((rows) => rows[0]);
    expect(stored?.status).toBe("pending");

    await expect(interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      projectId: null,
      goalId: null,
      status: "done",
    }, created.id, {}, { userId: "local-board" })).rejects.toThrow(
      "Interaction is no longer actionable because the issue is closed",
    );
    await expect(interactionsSvc.withdrawInteraction({ id: issueId, companyId, status: "done" }, created.id, {}, {
      userId: "local-board",
    })).rejects.toThrow("Interaction is no longer actionable because the issue is closed");
  });

  it("does not supersede request confirmations for agent, system, or older user comments", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Comment supersede exclusions");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });
    const createdAtMs = new Date(created.createdAt).getTime();

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs + 1_000),
      authorUserId: null,
    }, {
      agentId: randomUUID(),
    })).resolves.toHaveLength(0);

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs + 1_000),
      authorUserId: null,
    }, {})).resolves.toHaveLength(0);

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(createdAtMs - 1_000),
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    })).resolves.toHaveLength(0);

    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("does not supersede request confirmations for run-originated comments even under user auth", async () => {
    // Local-CLI agents post under user auth, so authorUserId is set nondeterministically.
    // A comment carrying createdByRunId is machine-originated and must never expire a
    // pending decision card.
    const { companyId, issueId } = await seedConfirmationIssue("Run-originated comment supersede exclusion");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: randomUUID(),
      createdAt: new Date(new Date(created.createdAt).getTime() + 1_000),
      authorUserId: "local-board",
      createdByRunId: randomUUID(),
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(0);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("repairs historical request confirmations superseded by later user comments idempotently", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Historical comment supersede");
    const commentId = randomUUID();
    const createdAt = new Date("2026-05-18T12:00:00.000Z");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });
    await db
      .update(issueThreadInteractions)
      .set({ createdAt, updatedAt: createdAt })
      .where(eq(issueThreadInteractions.id, created.id));

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorType: "system",
      body: "System-side progress note.",
      createdAt: new Date("2026-05-18T12:00:30.000Z"),
      updatedAt: new Date("2026-05-18T12:00:30.000Z"),
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "local-board",
      authorType: "user",
      body: "Please revise this first.",
      createdAt: new Date("2026-05-18T12:01:00.000Z"),
      updatedAt: new Date("2026-05-18T12:01:00.000Z"),
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        commentId,
      },
      resolvedByAgentId: null,
      resolvedByUserId: "local-board",
    });

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    })).resolves.toEqual([]);
  });

  it("does not repair historical confirmations from run-originated comments", async () => {
    // The repair sweep must ignore machine-originated comments (createdByRunId set) even
    // when authorUserId is present under user auth.
    const { companyId, issueId } = await seedConfirmationIssue("Historical run-originated exclusion");
    const agentId = randomUUID();
    const runId = randomUUID();
    const createdAt = new Date("2026-05-18T12:00:00.000Z");

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
      },
    }, {
      userId: "local-board",
    });
    await db
      .update(issueThreadInteractions)
      .set({ createdAt, updatedAt: createdAt })
      .where(eq(issueThreadInteractions.id, created.id));

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GiskardCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorUserId: "local-board",
      authorType: "user",
      createdByRunId: runId,
      body: "SLA escalation relay posted from a heartbeat run.",
      createdAt: new Date("2026-05-18T12:01:00.000Z"),
      updatedAt: new Date("2026-05-18T12:01:00.000Z"),
    });

    await expect(interactionsSvc.expireRequestConfirmationsSupersededByHistoricalComments({
      id: issueId,
      companyId,
    })).resolves.toEqual([]);
    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("expires request confirmations when the watched issue document revision changes", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const nextRevisionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Document target confirmation",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "v1",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "v1",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Apply the plan document?",
        target: {
          type: "issue_document",
          issueId,
          documentId,
          key: "plan",
          revisionId,
          revisionNumber: 1,
        },
      },
    }, {
      userId: "local-board",
    });

    await db.insert(documentRevisions).values({
      id: nextRevisionId,
      companyId,
      documentId,
      revisionNumber: 2,
      title: "Plan",
      format: "markdown",
      body: "v2",
    });
    await db.update(documents).set({
      latestBody: "v2",
      latestRevisionId: nextRevisionId,
      latestRevisionNumber: 2,
    });

    await expect(interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "interaction_stale_target" },
    });

    const expired = await interactionsSvc.getForIssue({ id: issueId, companyId }, created.id);
    expect(expired).toMatchObject({
      id: created.id,
      status: "expired",
      payload: {
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: nextRevisionId,
          revisionNumber: 2,
        },
      },
      result: {
        version: 1,
        outcome: "stale_target",
        staleTarget: {
          type: "issue_document",
          key: "plan",
          revisionId,
        },
      },
    });
  });

  it("rejects creating a plan confirmation against a stale document revision and accepts the current one", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const nextRevisionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Stale plan confirmation",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.update(issues).set({ workMode: "planning" }).where(eq(issues.id, issueId));
    // Document is already at revision 2 — revision 1 is stale.
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "v2",
      latestRevisionId: nextRevisionId,
      latestRevisionNumber: 2,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });
    await db.insert(documentRevisions).values([
      {
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Plan",
        format: "markdown",
        body: "v1",
      },
      {
        id: nextRevisionId,
        companyId,
        documentId,
        revisionNumber: 2,
        title: "Plan",
        format: "markdown",
        body: "v2",
      },
    ]);

    const staleTarget = {
      type: "issue_document" as const,
      issueId,
      documentId,
      key: "plan",
      revisionId,
      revisionNumber: 1,
    };

    // The revision check runs inside the create transaction (locking the
    // document row), so a target pointing at an older revision is rejected
    // atomically with the would-be insert rather than by a racy pre-check.
    await expect(interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Apply the plan document?",
        target: staleTarget,
      },
    }, {
      userId: "local-board",
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("current issue document revision"),
    });

    const noRows = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    expect(noRows).toHaveLength(0);

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Apply the plan document?",
        target: {
          ...staleTarget,
          revisionId: nextRevisionId,
          revisionNumber: 2,
        },
      },
    }, {
      userId: "local-board",
    });
    expect(created).toMatchObject({ status: "pending", kind: "request_confirmation" });
    await expect(interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    })).resolves.toMatchObject({
      interaction: { status: "accepted" },
      continuationIssue: { id: issueId },
    });
    await expect(issueService(db).getById(issueId)).resolves.toMatchObject({
      workMode: "standard",
    });
  });

  it("preserves resolved request_item_verdicts items when the watched issue document revision changes", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const nextRevisionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Document target verdicts",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "v1",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "v1",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_item_verdicts",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Review generated artifacts.",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs" },
        ],
        target: {
          type: "issue_document",
          issueId,
          documentId,
          key: "plan",
          revisionId,
          revisionNumber: 1,
        },
      },
    }, {
      userId: "local-board",
    });

    await interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "api", verdict: "approve" }],
    }, {
      userId: "local-board",
    });

    await db.insert(documentRevisions).values({
      id: nextRevisionId,
      companyId,
      documentId,
      revisionNumber: 2,
      title: "Plan",
      format: "markdown",
      body: "v2",
    });
    await db.update(documents).set({
      latestBody: "v2",
      latestRevisionId: nextRevisionId,
      latestRevisionNumber: 2,
    });

    await expect(interactionsSvc.submitItemVerdicts({
      id: issueId,
      companyId,
    }, created.id, {
      verdicts: [{ id: "docs", verdict: "approve" }],
    }, {
      userId: "local-board",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "interaction_stale_target" },
    });

    const stale = await interactionsSvc.getForIssue({ id: issueId, companyId }, created.id);
    expect(stale).toMatchObject({
      id: created.id,
      status: "expired",
      payload: {
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: nextRevisionId,
          revisionNumber: 2,
        },
      },
      result: {
        version: 1,
        outcome: "stale_target",
        complete: false,
        staleTarget: {
          type: "issue_document",
          key: "plan",
          revisionId,
        },
        items: [
          {
            id: "api",
            verdict: "approve",
            resolvedByUserId: "local-board",
          },
        ],
      },
    });
  });

  describe("workspace_finalize accept gate", () => {
    type AcceptGateInteractionKind = "request_confirmation" | "request_checkbox_confirmation";

    async function seedAcceptGateFixture(options?: {
      kind?: AcceptGateInteractionKind;
      sourceRunId?: string | null;
      sourceRunStatus?: string;
    }) {
      const companyId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const executionWorkspaceId = randomUUID();
      const issueId = randomUUID();
      const goalId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId =
        options?.sourceRunId === null ? null : options?.sourceRunId ?? randomUUID();
      const foreignRunId = randomUUID();
      const kind = options?.kind ?? "request_confirmation";

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Workspace",
        sourceType: "local_path",
        visibility: "default",
        isPrimary: true,
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
      const sourceRunStatus = options?.sourceRunStatus ?? "succeeded";
      const sourceRunTerminal = sourceRunStatus !== "running";
      await db.insert(heartbeatRuns).values([
        ...(sourceRunId
          ? [
              {
                id: sourceRunId,
                companyId,
                agentId,
                invocationSource: "manual",
                status: sourceRunStatus,
                startedAt: new Date("2026-05-23T21:55:00.000Z"),
                finishedAt: sourceRunTerminal ? new Date("2026-05-23T22:05:00.000Z") : null,
              },
            ]
          : []),
        {
          id: foreignRunId,
          companyId,
          agentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date("2026-05-23T22:10:00.000Z"),
        },
      ]);
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "exec",
        status: "active",
        providerType: "git_worktree",
      });
      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Accept gate fixture",
        level: "task",
        status: "active",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        projectId,
        goalId,
        title: "Issue with execution workspace",
        status: "in_progress",
        priority: "medium",
        executionWorkspaceId,
      });

      const payload = kind === "request_checkbox_confirmation"
        ? {
            version: 1 as const,
            prompt: "Which files should be accepted?",
            options: [
              { id: "file-a", label: "a.txt" },
              { id: "file-b", label: "b.txt" },
            ],
            minSelected: 0,
            maxSelected: 2,
          }
        : {
            version: 1 as const,
            prompt: "Mark this issue done?",
          };

      const created = await interactionsSvc.create({
        id: issueId,
        companyId,
      }, {
        kind,
        continuationPolicy: "wake_assignee",
        sourceRunId,
        payload,
      }, {
        userId: "local-board",
      });

      return {
        companyId,
        projectId,
        executionWorkspaceId,
        issueId,
        goalId,
        interactionId: created.id,
        sourceRunId,
        foreignRunId,
      };
    }

    it("allows request_confirmation accept when the source run finalized but a foreign run is mid-flight", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId, foreignRunId } =
        await seedAcceptGateFixture();

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:00:00.000Z"),
      });
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_confirmation",
        status: "accepted",
      });
    });

    it("refuses request_confirmation accept until the source run records a successful workspace_finalize", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId } =
        await seedAcceptGateFixture();

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:00:00.000Z"),
      });

      await expect(
        interactionsSvc.acceptInteraction(
          { id: issueId, companyId, goalId, projectId: null },
          interactionId,
          {},
          { userId: "local-board" },
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(
          "the run that created this interaction has not finished syncing its workspace",
        ),
        details: { executionWorkspaceId, sourceRunId },
      });

      const row = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0]);
      expect(row?.status).toBe("pending");

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:05:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_confirmation",
        status: "accepted",
      });
    });

    it("allows request_confirmation accept when the source run's workspace_finalize failed", async () => {
      // A sync-back that ran and FAILED is terminal. The run will not retry it, so
      // the confirmation must not stay wedged behind a misleading "still syncing"
      // error — the user can merge/act manually.
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId } =
        await seedAcceptGateFixture({ sourceRunStatus: "failed" });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_config_freshness",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:00:00.000Z"),
      });
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "failed",
        startedAt: new Date("2026-05-23T22:05:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_confirmation",
        status: "accepted",
      });
    });

    it("allows request_confirmation accept when a running workspace_finalize is stale (source run ended)", async () => {
      // The source run died mid-finalize, leaving a `running` op that will never
      // advance. A terminal/missing owner run means the record is stale, so the
      // gate must not wait on it forever.
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId } =
        await seedAcceptGateFixture({ sourceRunStatus: "failed" });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "running",
        startedAt: new Date("2026-05-23T22:05:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_confirmation",
        status: "accepted",
      });
    });

    it("refuses request_confirmation accept while a workspace_finalize is running on a live source run", async () => {
      // A genuinely in-flight sync-back on a still-active run must still block, so
      // the confirmation cannot race commits that are actively being synced back.
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId } =
        await seedAcceptGateFixture({ sourceRunStatus: "running" });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "running",
        startedAt: new Date("2026-05-23T22:05:00.000Z"),
      });

      await expect(
        interactionsSvc.acceptInteraction(
          { id: issueId, companyId, goalId, projectId: null },
          interactionId,
          {},
          { userId: "local-board" },
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(
          "the run that created this interaction has not finished syncing its workspace",
        ),
        details: { executionWorkspaceId, sourceRunId },
      });
    });

    it("allows request_confirmation accept when sourceRunId is null", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, foreignRunId } =
        await seedAcceptGateFixture({ sourceRunId: null });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_confirmation",
        status: "accepted",
      });
    });

    it("allows request_checkbox_confirmation accept when the source run finalized but a foreign run is mid-flight", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId, foreignRunId } =
        await seedAcceptGateFixture({ kind: "request_checkbox_confirmation" });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:00:00.000Z"),
      });
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        { selectedOptionIds: ["file-b"] },
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_checkbox_confirmation",
        status: "accepted",
        result: {
          selectedOptionIds: ["file-b"],
        },
      });
    });

    it("refuses request_checkbox_confirmation accept until the source run records a successful workspace_finalize", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, sourceRunId } =
        await seedAcceptGateFixture({ kind: "request_checkbox_confirmation" });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:00:00.000Z"),
      });

      await expect(
        interactionsSvc.acceptInteraction(
          { id: issueId, companyId, goalId, projectId: null },
          interactionId,
          { selectedOptionIds: ["file-a"] },
          { userId: "local-board" },
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(
          "the run that created this interaction has not finished syncing its workspace",
        ),
        details: { executionWorkspaceId, sourceRunId },
      });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: sourceRunId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        { selectedOptionIds: ["file-a"] },
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_checkbox_confirmation",
        status: "accepted",
      });
    });

    it("allows request_checkbox_confirmation accept when sourceRunId is null", async () => {
      const { companyId, executionWorkspaceId, issueId, goalId, interactionId, foreignRunId } =
        await seedAcceptGateFixture({ kind: "request_checkbox_confirmation", sourceRunId: null });

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-23T22:10:00.000Z"),
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        { selectedOptionIds: ["file-a"] },
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: interactionId,
        kind: "request_checkbox_confirmation",
        status: "accepted",
      });
    });

    it("allows accept of suggest_tasks even when no successful workspace_finalize has landed", async () => {
      // suggest_tasks acceptance only creates follow-up issues; it does not
      // approve code state or move the source workspace forward, so the
      // workspace_finalize gate (PAPA-440) must not apply here. Without this
      // carve-out the board cannot triage suggested tasks on an issue whose
      // latest workspace op is still worktree_prepare.
      const { companyId, executionWorkspaceId, issueId, goalId, foreignRunId } = await seedAcceptGateFixture();

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        heartbeatRunId: foreignRunId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-05-28T22:00:00.000Z"),
      });

      const created = await interactionsSvc.create({
        id: issueId,
        companyId,
      }, {
        kind: "suggest_tasks",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          tasks: [
            {
              clientKey: "follow-up",
              title: "Created from suggest_tasks accept under prepare-only workspace",
            },
          ],
        },
      }, {
        userId: "local-board",
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        created.id,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: created.id,
        kind: "suggest_tasks",
        status: "accepted",
      });
    });

    it("allows accept when the issue has no execution workspace attached", async () => {
      const { companyId, issueId } = await seedConfirmationIssue("No execution workspace accept");

      const created = await interactionsSvc.create({
        id: issueId,
        companyId,
      }, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Mark this issue done?",
        },
      }, {
        userId: "local-board",
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId: null, projectId: null },
        created.id,
        {},
        { userId: "local-board" },
      );

      expect(accepted.interaction).toMatchObject({
        id: created.id,
        status: "accepted",
      });
    });
  });

  describe("pinned code review confirmations", () => {
    const PINNED_MODEL = "claude-bridge/claude-fable-5";
    const DRIFTED_MODEL = "codex/gpt-5.6-sol";
    const REVISION = "0123456789abcdef0123456789abcdef01234567";

    async function seedPinnedReview(options?: { reviewerModel?: string | null }) {
      const { companyId, goalId, issueId } = await seedConfirmationIssue("Pinned code review");
      const authorAgentId = randomUUID();
      const reviewerAgentId = randomUUID();
      const authorRunId = randomUUID();
      const reviewerRunId = randomUUID();
      await db.insert(agents).values([
        {
          id: authorAgentId,
          companyId,
          name: "Candidate author",
          role: "engineer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: { model: DRIFTED_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: reviewerAgentId,
          companyId,
          name: "Pinned reviewer",
          role: "reviewer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: options?.reviewerModel === null
            ? {}
            : { model: options?.reviewerModel ?? PINNED_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
      ]);
      await db.insert(heartbeatRuns).values([
        {
          id: authorRunId,
          companyId,
          agentId: authorAgentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date(),
        },
        {
          id: reviewerRunId,
          companyId,
          agentId: reviewerAgentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date(),
        },
      ]);
      return { companyId, goalId, issueId, authorAgentId, reviewerAgentId, authorRunId, reviewerRunId };
    }

    function pinnedReviewPayload(overrides?: { revision?: string; workspaceKey?: string }) {
      return {
        version: 1 as const,
        prompt: "Approve the reviewed candidate?",
        review: {
          candidate: {
            workspaceKey: overrides?.workspaceKey ?? "lane-7",
            revision: overrides?.revision ?? REVISION,
          },
          expectedModel: PINNED_MODEL,
        },
      };
    }

    it("creates and accepts a pinned code review without moving the issue out of progress", async () => {
      const { companyId, goalId, issueId, authorAgentId, reviewerAgentId, reviewerRunId } =
        await seedPinnedReview();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        addresseeAgentId: reviewerAgentId,
        payload: pinnedReviewPayload(),
      }, { agentId: authorAgentId });

      expect(created).toMatchObject({
        kind: "request_confirmation",
        status: "pending",
        addresseeAgentId: reviewerAgentId,
        createdByAgentId: authorAgentId,
        payload: {
          review: {
            candidate: { workspaceKey: "lane-7", revision: REVISION },
            expectedModel: PINNED_MODEL,
          },
        },
      });

      const accepted = await interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        created.id,
        {},
        { agentId: reviewerAgentId, runId: reviewerRunId },
      );

      expect(accepted.interaction).toMatchObject({
        id: created.id,
        status: "accepted",
        resolvedByAgentId: reviewerAgentId,
        result: { version: 1, outcome: "accepted" },
      });
      expect(accepted.continuationIssue).toBeNull();
      const [issueRow] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
      expect(issueRow?.status).toBe("in_progress");
    });

    it("refuses to create a pinned code review when the reviewer's configured model differs from the pin", async () => {
      const { companyId, issueId, authorAgentId, reviewerAgentId } =
        await seedPinnedReview({ reviewerModel: DRIFTED_MODEL });

      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        addresseeAgentId: reviewerAgentId,
        payload: pinnedReviewPayload(),
      }, { agentId: authorAgentId })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("configured model does not match"),
        details: expect.objectContaining({
          code: "interaction_review_model_mismatch",
          expectedModel: PINNED_MODEL,
          configuredModel: DRIFTED_MODEL,
        }),
      });
      await expect(interactionsSvc.listForIssue(issueId)).resolves.toEqual([]);
    });

    it("refuses to accept a pinned code review after the reviewer's configured model changes", async () => {
      const { companyId, goalId, issueId, authorAgentId, reviewerAgentId, reviewerRunId } =
        await seedPinnedReview();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        addresseeAgentId: reviewerAgentId,
        payload: pinnedReviewPayload(),
      }, { agentId: authorAgentId });

      await db.update(agents)
        .set({ adapterConfig: { model: DRIFTED_MODEL } })
        .where(eq(agents.id, reviewerAgentId));

      await expect(interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        created.id,
        {},
        { agentId: reviewerAgentId, runId: reviewerRunId },
      )).rejects.toMatchObject({
        status: 409,
        details: expect.objectContaining({
          code: "interaction_stale_target",
          expectedModel: PINNED_MODEL,
          configuredModel: DRIFTED_MODEL,
        }),
      });

      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row).toMatchObject({ status: "pending", result: null });
    });

    it("refuses to let the candidate author resolve their own pinned code review", async () => {
      const { companyId, goalId, issueId, authorAgentId, authorRunId } = await seedPinnedReview();
      const interactionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "none",
        createdByAgentId: authorAgentId,
        addresseeAgentId: authorAgentId,
        payload: pinnedReviewPayload(),
      });

      await expect(interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { agentId: authorAgentId, runId: authorRunId },
      )).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("author of a code-review candidate"),
        details: expect.objectContaining({ code: "interaction_creator_excluded" }),
      });

      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(row).toMatchObject({ status: "pending", result: null });
    });

    it("refuses a reviewer whose own run produced the candidate", async () => {
      const { companyId, goalId, issueId, reviewerAgentId, reviewerRunId } = await seedPinnedReview();
      const interactionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "none",
        createdByUserId: "local-board",
        addresseeAgentId: reviewerAgentId,
        sourceRunId: reviewerRunId,
        payload: pinnedReviewPayload(),
      });

      await expect(interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        interactionId,
        {},
        { agentId: reviewerAgentId, runId: reviewerRunId },
      )).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("author of a code-review candidate"),
        details: expect.objectContaining({ code: "interaction_creator_excluded" }),
      });

      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(row).toMatchObject({ status: "pending", result: null });
    });

    it("refuses a human board override on a pinned code review", async () => {
      const { companyId, goalId, issueId, authorAgentId, reviewerAgentId } = await seedPinnedReview();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        addresseeAgentId: reviewerAgentId,
        payload: pinnedReviewPayload(),
      }, { agentId: authorAgentId });

      await expect(interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        created.id,
        {},
        { userId: "local-board" },
      )).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("addressed reviewer agent"),
        details: expect.objectContaining({ code: "interaction_addressee_mismatch" }),
      });
    });

    it("refuses a code-review pin mixed with a target", async () => {
      const { companyId, issueId, authorAgentId, reviewerAgentId } = await seedPinnedReview();

      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        addresseeAgentId: reviewerAgentId,
        payload: {
          ...pinnedReviewPayload(),
          target: { type: "custom", key: "plan" },
        },
      }, { agentId: authorAgentId })).rejects.toThrow(/cannot be combined with target/);
    });

    it("rejects path-shaped candidate fields and non-hex revisions", async () => {
      const { companyId, issueId, authorAgentId, reviewerAgentId } = await seedPinnedReview();
      const base = { kind: "request_confirmation" as const, addresseeAgentId: reviewerAgentId };
      const candidate = pinnedReviewPayload().review.candidate;
      const payloadWithHostPath = {
        ...pinnedReviewPayload(),
        review: {
          ...pinnedReviewPayload().review,
          candidate: { ...candidate, path: "/tmp/secret" },
        },
      };

      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        ...base,
        payload: pinnedReviewPayload({ workspaceKey: "/Users/mirko/repo" }),
      }, { agentId: authorAgentId })).rejects.toThrow(/lane key/);

      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        ...base,
        payload: pinnedReviewPayload({ revision: "abc123" }),
      }, { agentId: authorAgentId })).rejects.toThrow(/40- or 64-character/);

      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        ...base,
        payload: payloadWithHostPath,
      }, { agentId: authorAgentId })).rejects.toThrow();
    });

    it("refuses a coordinator-created review addressed to the issue's current assignee", async () => {
      const { companyId, issueId, authorAgentId, reviewerAgentId } = await seedPinnedReview();
      await db.update(issues).set({ assigneeAgentId: reviewerAgentId }).where(eq(issues.id, issueId));

      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        addresseeAgentId: reviewerAgentId,
        payload: pinnedReviewPayload(),
      }, { agentId: authorAgentId })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("current assignee"),
        details: expect.objectContaining({
          code: "interaction_review_assignee_independence_required",
          reviewerAgentId,
          assigneeAgentId: reviewerAgentId,
        }),
      });

      await expect(interactionsSvc.listForIssue(issueId)).resolves.toEqual([]);
    });

    it("refuses accept and reject once the reviewer becomes the issue assignee", async () => {
      const { companyId, goalId, issueId, authorAgentId, reviewerAgentId, reviewerRunId } =
        await seedPinnedReview();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        addresseeAgentId: reviewerAgentId,
        payload: pinnedReviewPayload(),
      }, { agentId: authorAgentId });
      expect(created.status).toBe("pending");

      await db.update(issues).set({ assigneeAgentId: reviewerAgentId }).where(eq(issues.id, issueId));

      const issue = { id: issueId, companyId, goalId, projectId: null };
      const reviewer = { agentId: reviewerAgentId, runId: reviewerRunId };
      await expect(interactionsSvc.acceptInteraction(issue, created.id, {}, reviewer))
        .rejects.toMatchObject({
          status: 403,
          message: expect.stringContaining("current assignee"),
          details: expect.objectContaining({
            code: "interaction_creator_excluded",
            requiredResolver: "reviewer_other_than_issue_assignee",
          }),
        });
      await expect(interactionsSvc.rejectInteraction(issue, created.id, {}, reviewer))
        .rejects.toMatchObject({
          status: 403,
          details: expect.objectContaining({ requiredResolver: "reviewer_other_than_issue_assignee" }),
        });

      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row).toMatchObject({ status: "pending", result: null });
    });

    it.each(["matching review stage", "outside policy", "implementation owner"] as const)(
      "resolves a temporarily assigned reviewer only with independent native stage evidence: %s", async (scenario) => {
      const { companyId, goalId, issueId, authorAgentId, reviewerAgentId, reviewerRunId } =
        await seedPinnedReview();
      const stageId = randomUUID();
      await issuesSvc.update(issueId, {
        status: "in_progress",
        assigneeAgentId: authorAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{
            id: stageId,
            type: "review",
            participants: [{ id: randomUUID(), type: "agent", agentId: scenario === "outside policy" ? authorAgentId : reviewerAgentId, userId: null }],
            approvalsNeeded: 1,
          }],
        },
      });
      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        addresseeAgentId: reviewerAgentId,
        payload: pinnedReviewPayload(),
      }, { agentId: authorAgentId });
      await db.update(issues).set({
        assigneeAgentId: reviewerAgentId,
        executionState: {
          status: "pending",
          currentStageIndex: 0,
          currentStageId: stageId,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: scenario === "implementation owner" ? reviewerAgentId : authorAgentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
          monitor: null,
        },
      }).where(eq(issues.id, issueId));

      const resolution = interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        created.id,
        {},
        { agentId: reviewerAgentId, runId: reviewerRunId },
      );
      if (scenario === "matching review stage") {
        await expect(resolution).resolves.toMatchObject({ interaction: { status: "accepted" } });
      } else {
        await expect(resolution).rejects.toMatchObject({
          status: 403,
          details: expect.objectContaining({ requiredResolver: "reviewer_other_than_issue_assignee" }),
        });
      }
    });

    it("refuses a tampered stored review:null pin instead of downgrading it to a generic confirmation", async () => {
      const { companyId, goalId, issueId, authorAgentId, reviewerAgentId, reviewerRunId } =
        await seedPinnedReview();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        addresseeAgentId: reviewerAgentId,
        payload: pinnedReviewPayload(),
      }, { agentId: authorAgentId });

      await db.execute(sql`
        update issue_thread_interactions
        set payload = payload || '{"review": null}'::jsonb
        where id = ${created.id}
      `);

      await expect(interactionsSvc.acceptInteraction(
        { id: issueId, companyId, goalId, projectId: null },
        created.id,
        {},
        { agentId: reviewerAgentId, runId: reviewerRunId },
      )).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("unusable code-review pin"),
        details: expect.objectContaining({ code: "interaction_stale_target" }),
      });

      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row).toMatchObject({ status: "pending", result: null });
    });
  });

  describe("advisor advice consultations", () => {
    const PINNED_ADVISOR_MODEL = "openai-codex/gpt-5.6-sol";
    const DRIFTED_MODEL = "dsv4/deepseek-v4-flash";
    const REVISION = "0123456789abcdef0123456789abcdef01234567";
    const OTHER_REVISION = "fedcba9876543210fedcba9876543210fedcba98";

    async function seedAdviceActors(options?: { advisorModel?: string | null }) {
      const { companyId, goalId, issueId } = await seedConfirmationIssue("Advisor advice");
      const workerAgentId = randomUUID();
      const advisorAgentId = randomUUID();
      const otherAgentId = randomUUID();
      const workerRunId = randomUUID();
      const advisorRunId = randomUUID();
      const otherRunId = randomUUID();
      await db.insert(agents).values([
        {
          id: workerAgentId,
          companyId,
          name: "Implementation worker",
          role: "engineer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: { model: DRIFTED_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: advisorAgentId,
          companyId,
          name: "SOL advisor",
          role: "reviewer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: options?.advisorModel === null
            ? {}
            : { model: options?.advisorModel ?? PINNED_ADVISOR_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: otherAgentId,
          companyId,
          name: "Bystander agent",
          role: "engineer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: { model: DRIFTED_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
      ]);
      await db.insert(heartbeatRuns).values([
        {
          id: workerRunId,
          companyId,
          agentId: workerAgentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date(),
        },
        {
          id: advisorRunId,
          companyId,
          agentId: advisorAgentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date(),
        },
        {
          id: otherRunId,
          companyId,
          agentId: otherAgentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date(),
        },
      ]);
      return { companyId, goalId, issueId, workerAgentId, advisorAgentId, otherAgentId, workerRunId, advisorRunId, otherRunId };
    }

    function advicePayload(overrides?: { revision?: string; withoutCandidate?: boolean }) {
      return {
        version: 1 as const,
        questions: [{
          id: "advice",
          prompt: "How should I sequence the cache invalidation fix?",
          selectionMode: "single" as const,
          options: [{ id: "free_text", label: "Type your advice", freeText: true }],
        }],
        advice: {
          expectedModel: PINNED_ADVISOR_MODEL,
          expectedThinking: "high" as const,
          ...(overrides?.withoutCandidate ? {} : {
            candidate: {
              workspaceKey: "lane-7",
              revision: overrides?.revision ?? REVISION,
            },
          }),
        },
      };
    }

    const adviceAnswer = {
      answers: [{ questionId: "advice", optionIds: ["free_text"], otherText: "Fix the reader path before the writer path." }],
    };

    it("answers as the addressed advisor and records attributable evidence without approval effects", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId, workerRunId, advisorRunId } =
        await seedAdviceActors();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        addresseeAgentId: advisorAgentId,
        payload: advicePayload(),
      }, { agentId: workerAgentId, runId: workerRunId });

      expect(created).toMatchObject({
        kind: "ask_user_questions",
        status: "pending",
        title: "Implementation advice",
        continuationPolicy: "wake_assignee",
        addresseeAgentId: advisorAgentId,
        createdByAgentId: workerAgentId,
        requestedResolverPolicy: "anyone",
        effectiveResolverPolicy: "anyone",
        payload: {
          supersedeOnUserComment: false,
          advice: {
            expectedModel: PINNED_ADVISOR_MODEL,
            expectedThinking: "high",
            candidate: { workspaceKey: "lane-7", revision: REVISION },
          },
        },
      });

      const answered = await interactionsSvc.answerQuestions(
        { id: issueId, companyId },
        created.id,
        adviceAnswer,
        { agentId: advisorAgentId, runId: advisorRunId },
      );

      expect(answered).toMatchObject({
        id: created.id,
        status: "answered",
        resolvedByAgentId: advisorAgentId,
        resolvedByRunId: advisorRunId,
        resolvedByUserId: null,
        result: {
          version: 1,
          summaryMarkdown: null,
          advice: {
            version: 1,
            expectedModel: PINNED_ADVISOR_MODEL,
            candidate: { workspaceKey: "lane-7", revision: REVISION },
          },
        },
      });
      expect(answered.result?.answers).toEqual(adviceAnswer.answers);

      // An advice answer never moves the issue: no completion, no approval, no
      // reassignment of the worker's checkout.
      const [issueRow] = await db
        .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, issueId));
      expect(issueRow).toMatchObject({ status: "in_progress", assigneeAgentId: null });
    });

    it("refuses advice answers from any agent other than the addressed advisor", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId, otherAgentId, otherRunId, workerRunId } =
        await seedAdviceActors();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        addresseeAgentId: advisorAgentId,
        payload: advicePayload(),
      }, { agentId: workerAgentId, runId: workerRunId });

      await expect(interactionsSvc.answerQuestions(
        { id: issueId, companyId },
        created.id,
        adviceAnswer,
        { agentId: otherAgentId, runId: otherRunId },
      )).rejects.toMatchObject({
        status: 403,
        details: expect.objectContaining({ code: "interaction_addressee_mismatch" }),
      });

      // A human board override cannot answer either: the pin demands the
      // addressed advisor agent and never accepts a human substitute.
      await expect(interactionsSvc.answerQuestions(
        { id: issueId, companyId },
        created.id,
        adviceAnswer,
        { userId: "local-board" },
      )).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("addressed advisor agent"),
        details: expect.objectContaining({ code: "interaction_addressee_mismatch" }),
      });

      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row).toMatchObject({ status: "pending", result: null });
    });

    it("refuses the requesting worker and its run from answering their own consultation", async () => {
      const { companyId, goalId, issueId, workerAgentId, advisorAgentId, workerRunId, advisorRunId } =
        await seedAdviceActors();

      const selfAddressedId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: selfAddressedId,
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "none",
        createdByAgentId: workerAgentId,
        addresseeAgentId: workerAgentId,
        payload: advicePayload(),
      });
      await expect(interactionsSvc.answerQuestions(
        { id: issueId, companyId },
        selfAddressedId,
        adviceAnswer,
        { agentId: workerAgentId, runId: workerRunId },
      )).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("requested advice cannot answer"),
        details: expect.objectContaining({
          code: "interaction_creator_excluded",
          requiredResolver: "advisor_other_than_requester",
        }),
      });

      const runAuthoredId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: runAuthoredId,
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "none",
        createdByUserId: "local-board",
        sourceRunId: advisorRunId,
        addresseeAgentId: advisorAgentId,
        payload: advicePayload(),
      });
      await expect(interactionsSvc.answerQuestions(
        { id: issueId, companyId },
        runAuthoredId,
        adviceAnswer,
        { agentId: advisorAgentId, runId: advisorRunId },
      )).rejects.toMatchObject({
        status: 403,
        details: expect.objectContaining({
          code: "interaction_creator_excluded",
          requiredResolver: "advisor_other_than_requester",
        }),
      });

      const [selfRow] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, selfAddressedId));
      expect(selfRow).toMatchObject({ status: "pending", result: null });
    });

    it("refuses an advice answer after the advisor's configured model changes", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId, workerRunId, advisorRunId } =
        await seedAdviceActors();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        addresseeAgentId: advisorAgentId,
        payload: advicePayload(),
      }, { agentId: workerAgentId, runId: workerRunId });

      await db.update(agents)
        .set({ adapterConfig: { model: DRIFTED_MODEL } })
        .where(eq(agents.id, advisorAgentId));

      await expect(interactionsSvc.answerQuestions(
        { id: issueId, companyId },
        created.id,
        adviceAnswer,
        { agentId: advisorAgentId, runId: advisorRunId },
      )).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("no longer matches the model pinned"),
        details: expect.objectContaining({
          code: "interaction_stale_target",
          expectedModel: PINNED_ADVISOR_MODEL,
          configuredModel: DRIFTED_MODEL,
        }),
      });

      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row).toMatchObject({ status: "pending", result: null });
    });

    it("enforces directed agent-only creation gates for advice", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId } =
        await seedAdviceActors({ advisorModel: DRIFTED_MODEL });

      // Advice must be directed at the broker-pinned advisor agent.
      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        payload: advicePayload(),
      }, { agentId: workerAgentId })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "interaction_advice_addressee_required" }),
      });

      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        addresseeUserId: "local-board",
        payload: advicePayload(),
      }, { agentId: workerAgentId })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "interaction_advice_addressee_required" }),
      });

      // The pinned model must match the advisor's live configuration at create.
      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        addresseeAgentId: advisorAgentId,
        payload: advicePayload(),
      }, { agentId: workerAgentId })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "interaction_advice_model_mismatch",
          expectedModel: PINNED_ADVISOR_MODEL,
          configuredModel: DRIFTED_MODEL,
        }),
      });

      // Advice cannot become a decision card even when correctly addressed.
      const decisionAdvicePayload = {
        version: 1 as const,
        questions: [{
          id: "advice",
          prompt: "Should I merge?",
          selectionMode: "single" as const,
          required: true,
          intent: "decision" as const,
          recommendationRationale: "The checks are green and the diff is minimal.",
          options: [
            { id: "merge", label: "Merge", recommended: true },
            { id: "hold", label: "Hold" },
          ],
        }],
        advice: advicePayload().advice,
      };
      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        addresseeAgentId: advisorAgentId,
        payload: decisionAdvicePayload,
      }, { agentId: workerAgentId })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "interaction_advice_decision_question_conflict" }),
      });

      await expect(interactionsSvc.listForIssue(issueId)).resolves.toEqual([]);
    });

    it("refuses advice addressed to the issue's current assignee", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId } = await seedAdviceActors();
      await db.update(issues).set({ assigneeAgentId: advisorAgentId }).where(eq(issues.id, issueId));

      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        addresseeAgentId: advisorAgentId,
        payload: advicePayload(),
      }, { agentId: workerAgentId })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("current assignee"),
        details: expect.objectContaining({
          code: "interaction_advice_assignee_independence_required",
          advisorAgentId,
          assigneeAgentId: advisorAgentId,
        }),
      });

      await expect(interactionsSvc.listForIssue(issueId)).resolves.toEqual([]);
    });

    it("bounds distinct consultations per issue and candidate and exempts idempotent replays", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId, workerRunId } =
        await seedAdviceActors();
      const base = {
        kind: "ask_user_questions" as const,
        addresseeAgentId: advisorAgentId,
        payload: advicePayload(),
      };

      const first = await interactionsSvc.create({ id: issueId, companyId }, {
        ...base,
        idempotencyKey: `advice:${REVISION}:0`,
      }, { agentId: workerAgentId, runId: workerRunId });
      for (const suffix of [1, 2]) {
        await interactionsSvc.create({ id: issueId, companyId }, {
          ...base,
          idempotencyKey: `advice:${REVISION}:${suffix}`,
        }, { agentId: workerAgentId, runId: workerRunId });
      }

      // An idempotent replay returns the original row and consumes no budget.
      const replayed = await interactionsSvc.create({ id: issueId, companyId }, {
        ...base,
        idempotencyKey: `advice:${REVISION}:0`,
      }, { agentId: workerAgentId, runId: workerRunId });
      expect(replayed.id).toBe(first.id);

      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        ...base,
        idempotencyKey: `advice:${REVISION}:3`,
      }, { agentId: workerAgentId, runId: workerRunId })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "interaction_advice_consultation_limit_reached",
          limit: 3,
          candidateRevision: REVISION,
        }),
      });

      // A distinct candidate revision owns its own bucket.
      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        ...base,
        payload: advicePayload({ revision: OTHER_REVISION }),
      }, { agentId: workerAgentId, runId: workerRunId })).resolves.toMatchObject({
        status: "pending",
      });

      // Upfront-scope consultations (no candidate) count in their own bucket.
      const upfrontBase = {
        kind: "ask_user_questions" as const,
        addresseeAgentId: advisorAgentId,
        payload: advicePayload({ withoutCandidate: true }),
      };
      for (const suffix of ["upfront-0", "upfront-1", "upfront-2"]) {
        await interactionsSvc.create({ id: issueId, companyId }, {
          ...upfrontBase,
          idempotencyKey: suffix,
        }, { agentId: workerAgentId, runId: workerRunId });
      }
      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        ...upfrontBase,
        idempotencyKey: "upfront-3",
      }, { agentId: workerAgentId, runId: workerRunId })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "interaction_advice_consultation_limit_reached",
          limit: 3,
          candidateRevision: null,
        }),
      });
    });

    it("refuses a tampered stored advice:null pin instead of downgrading it to a generic question", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId, workerRunId, advisorRunId } =
        await seedAdviceActors();

      const created = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        addresseeAgentId: advisorAgentId,
        payload: advicePayload(),
      }, { agentId: workerAgentId, runId: workerRunId });

      await db.execute(sql`
        update issue_thread_interactions
        set payload = payload || '{"advice": null}'::jsonb
        where id = ${created.id}
      `);

      await expect(interactionsSvc.answerQuestions(
        { id: issueId, companyId },
        created.id,
        adviceAnswer,
        { agentId: advisorAgentId, runId: advisorRunId },
      )).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("unusable advice pin"),
        details: expect.objectContaining({ code: "interaction_stale_target" }),
      });

      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row).toMatchObject({ status: "pending", result: null });
    });
  });

  describe("advisor advice replay across successor author runs", () => {
    const PINNED_ADVISOR_MODEL = "openai-codex/gpt-5.6-sol";
    const DRIFTED_MODEL = "dsv4/deepseek-v4-flash";
    const REVISION = "0123456789abcdef0123456789abcdef01234567";
    const OTHER_REVISION = "fedcba9876543210fedcba9876543210fedcba98";
    const CONSULTATION_KEY = "delivery_request_advice:lane-7";

    async function seedTaskRuns() {
      const { companyId, goalId, issueId } = await seedConfirmationIssue("Advice replay");
      const workerAgentId = randomUUID();
      const advisorAgentId = randomUUID();
      const otherAgentId = randomUUID();
      const workerRunId = randomUUID();
      const successorRunId = randomUUID();
      const otherRunId = randomUUID();
      const taskContext = { issueId, taskId: issueId };
      await db.insert(agents).values([
        {
          id: workerAgentId,
          companyId,
          name: "Implementation worker",
          role: "engineer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: { model: DRIFTED_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: advisorAgentId,
          companyId,
          name: "SOL advisor",
          role: "reviewer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: { model: PINNED_ADVISOR_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: otherAgentId,
          companyId,
          name: "Bystander agent",
          role: "engineer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: { model: DRIFTED_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
      ]);
      await db.insert(heartbeatRuns).values([
        {
          id: workerRunId,
          companyId,
          agentId: workerAgentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date(),
          contextSnapshot: taskContext,
        },
        {
          id: successorRunId,
          companyId,
          agentId: workerAgentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date(),
          contextSnapshot: taskContext,
        },
        {
          id: otherRunId,
          companyId,
          agentId: otherAgentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date(),
          contextSnapshot: taskContext,
        },
      ]);
      return { companyId, goalId, issueId, workerAgentId, advisorAgentId, otherAgentId, workerRunId, successorRunId, otherRunId };
    }

    function replayAdvicePayload(revision: string = REVISION) {
      return {
        version: 1 as const,
        questions: [{
          id: "advice",
          prompt: "How should I sequence the cache invalidation fix?",
          selectionMode: "single" as const,
          options: [{ id: "free_text", label: "Type your advice", freeText: true }],
        }],
        advice: {
          expectedModel: PINNED_ADVISOR_MODEL,
          expectedThinking: "high" as const,
          candidate: { workspaceKey: "lane-7", revision },
        },
      };
    }

    it("returns the original consultation when a successor author run replays the same key on the same source task", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId, workerRunId, successorRunId } =
        await seedTaskRuns();
      const request = {
        kind: "ask_user_questions" as const,
        addresseeAgentId: advisorAgentId,
        idempotencyKey: CONSULTATION_KEY,
        payload: replayAdvicePayload(),
      };

      // The route stamps sourceRunId from the calling run: the original create
      // is attributed to the author's first run.
      const original = await interactionsSvc.create({ id: issueId, companyId }, {
        ...request,
        sourceRunId: workerRunId,
      }, { agentId: workerAgentId, runId: workerRunId });

      // The resumed session replays the identical tool input; the broker
      // forbids supplying the original sourceRunId, so the route re-derives it
      // from the successor run. That replay must return the original
      // consultation, not a 409 and not a second consultation.
      const replayed = await interactionsSvc.create({ id: issueId, companyId }, {
        ...request,
        sourceRunId: successorRunId,
      }, { agentId: workerAgentId, runId: successorRunId });

      expect(replayed.id).toBe(original.id);
      // Original provenance is untouched: the stored row still names the run
      // that first requested the consultation.
      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, original.id));
      expect(row).toMatchObject({
        status: "pending",
        sourceRunId: workerRunId,
        createdByAgentId: workerAgentId,
      });

      // The replay consumed no consultation budget: a distinct candidate
      // revision still fits under the per-candidate limit.
      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        ...request,
        idempotencyKey: `${CONSULTATION_KEY}:other-candidate`,
        payload: replayAdvicePayload(OTHER_REVISION),
      }, { agentId: workerAgentId, runId: successorRunId })).resolves.toMatchObject({
        status: "pending",
      });
    });

    it("stays strict when the replay comes from another actor or a different candidate", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId, otherAgentId, workerRunId, otherRunId } =
        await seedTaskRuns();
      const request = {
        kind: "ask_user_questions" as const,
        addresseeAgentId: advisorAgentId,
        idempotencyKey: CONSULTATION_KEY,
        payload: replayAdvicePayload(),
      };
      const original = await interactionsSvc.create({ id: issueId, companyId }, {
        ...request,
        sourceRunId: workerRunId,
      }, { agentId: workerAgentId, runId: workerRunId });

      // A different agent replaying the same key is a different request, even
      // on the same task with an identical payload.
      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        ...request,
        sourceRunId: otherRunId,
      }, { agentId: otherAgentId, runId: otherRunId })).rejects.toMatchObject({
        status: 409,
        details: expect.objectContaining({ idempotencyKey: CONSULTATION_KEY }),
      });

      // The same agent with a different candidate payload is also a different
      // request, even from the original run.
      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        ...request,
        payload: replayAdvicePayload(OTHER_REVISION),
      }, { agentId: workerAgentId, runId: workerRunId })).rejects.toMatchObject({
        status: 409,
        details: expect.objectContaining({ idempotencyKey: CONSULTATION_KEY }),
      });

      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, original.id));
      expect(row).toMatchObject({ status: "pending", sourceRunId: workerRunId });
      expect((await interactionsSvc.listForIssue(issueId)).length).toBe(1);
    });

    it("returns the original consultation after the advisor's configuration drifted and still pins fresh creates", async () => {
      const { companyId, issueId, workerAgentId, advisorAgentId, workerRunId, successorRunId } =
        await seedTaskRuns();
      const request = {
        kind: "ask_user_questions" as const,
        addresseeAgentId: advisorAgentId,
        idempotencyKey: CONSULTATION_KEY,
        payload: replayAdvicePayload(),
      };
      const original = await interactionsSvc.create({ id: issueId, companyId }, {
        ...request,
        sourceRunId: workerRunId,
      }, { agentId: workerAgentId, runId: workerRunId });

      await db.update(agents)
        .set({ adapterConfig: { model: DRIFTED_MODEL } })
        .where(eq(agents.id, advisorAgentId));

      // Config drift must not reject a stable replay.
      const replayed = await interactionsSvc.create({ id: issueId, companyId }, {
        ...request,
        sourceRunId: successorRunId,
      }, { agentId: workerAgentId, runId: successorRunId });
      expect(replayed.id).toBe(original.id);

      // A fresh consultation is still gated on the pinned model.
      await expect(interactionsSvc.create({ id: issueId, companyId }, {
        kind: "ask_user_questions",
        addresseeAgentId: advisorAgentId,
        idempotencyKey: `${CONSULTATION_KEY}:fresh`,
        payload: replayAdvicePayload(OTHER_REVISION),
      }, { agentId: workerAgentId, runId: successorRunId })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "interaction_advice_model_mismatch",
          expectedModel: PINNED_ADVISOR_MODEL,
          configuredModel: DRIFTED_MODEL,
        }),
      });
    });
  });

  describe("orphaned advisor consultation reconciliation", () => {
    const PINNED_ADVISOR_MODEL = "openai-codex/gpt-5.6-sol";
    const WORKER_MODEL = "dsv4/deepseek-v4-flash";
    const REVISION = "0123456789abcdef0123456789abcdef01234567";

    interface WakeCall {
      agentId: string;
      idempotencyKey: string | null;
      reason: string | null;
      payload: Record<string, unknown> | null;
      contextSnapshot: Record<string, unknown> | null;
    }

    function makeRecovery(options?: { failWakeup?: boolean }) {
      const wakeCalls: WakeCall[] = [];
      const recovery = recoveryService(db, {
        enqueueWakeup: async (agentId, opts) => {
          wakeCalls.push({
            agentId,
            idempotencyKey: opts?.idempotencyKey ?? null,
            reason: opts?.reason ?? null,
            payload: opts?.payload ?? null,
            contextSnapshot: opts?.contextSnapshot ?? null,
          });
          if (options?.failWakeup) throw new Error("wakeup_admission_unavailable");
          // Mirror the real admission: run the pre-admission fence, then write
          // the durable receipt. A fence throw rolls the admission back (no
          // receipt), exactly like heartbeat's native transaction.
          const [wokenAgent] = await db
            .select({ companyId: agents.companyId })
            .from(agents)
            .where(eq(agents.id, agentId));
          if (!wokenAgent) throw new Error("wakeup_agent_missing");
          if (opts?.bindWake) {
            await opts.bindWake(db);
          }
          await db.insert(agentWakeupRequests).values({
            companyId: wokenAgent.companyId,
            agentId,
            source: "automation",
            triggerDetail: "system",
            reason: opts?.reason ?? null,
            payload: opts?.payload ?? null,
            status: "queued",
            idempotencyKey: opts?.idempotencyKey ?? null,
          });
          return null;
        },
      });
      return { recovery, wakeCalls };
    }

    async function seedReconciliationScene() {
      const { companyId, goalId, issueId } = await seedConfirmationIssue("Advice reconciliation");
      const workerAgentId = randomUUID();
      const advisorAgentId = randomUUID();
      const workerRunId = randomUUID();
      await db.insert(agents).values([
        {
          id: workerAgentId,
          companyId,
          name: "Implementation worker",
          role: "engineer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: { model: WORKER_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: advisorAgentId,
          companyId,
          name: "SOL advisor",
          role: "reviewer",
          status: "active",
          adapterType: "claude_local",
          adapterConfig: { model: PINNED_ADVISOR_MODEL },
          runtimeConfig: {},
          permissions: {},
        },
      ]);
      await db.insert(heartbeatRuns).values({
        id: workerRunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { issueId, taskId: issueId },
      });
      // The worker owns issue execution: the reconciliation continuation must
      // land on the original owner, not on the advisor.
      await db.update(issues).set({ assigneeAgentId: workerAgentId }).where(eq(issues.id, issueId));
      return { companyId, goalId, issueId, workerAgentId, advisorAgentId, workerRunId };
    }

    function adviceConsultationPayload() {
      return {
        version: 1 as const,
        questions: [{
          id: "advice",
          prompt: "How should I sequence the cache invalidation fix?",
          selectionMode: "single" as const,
          options: [{ id: "free_text", label: "Type your advice", freeText: true }],
        }],
        advice: {
          expectedModel: PINNED_ADVISOR_MODEL,
          expectedThinking: "high" as const,
          candidate: { workspaceKey: "lane-7", revision: REVISION },
        },
      };
    }

    async function createPendingConsultation(scene: Awaited<ReturnType<typeof seedReconciliationScene>>) {
      return interactionsSvc.create({ id: scene.issueId, companyId: scene.companyId }, {
        kind: "ask_user_questions",
        addresseeAgentId: scene.advisorAgentId,
        payload: adviceConsultationPayload(),
      }, { agentId: scene.workerAgentId, runId: scene.workerRunId });
    }

    async function seedAdvisorWakeEvidence(input: {
      companyId: string;
      issueId: string;
      advisorAgentId: string;
      interactionId: string;
      runStatus: "failed" | "cancelled" | "timed_out" | "interrupted" | "succeeded" | "running" | "scheduled_retry";
    }) {
      const advisorRunId = randomUUID();
      const liveStatuses = ["queued", "running", "scheduled_retry"];
      await db.insert(heartbeatRuns).values({
        id: advisorRunId,
        companyId: input.companyId,
        agentId: input.advisorAgentId,
        invocationSource: "automation",
        status: input.runStatus,
        startedAt: new Date(),
        finishedAt: liveStatuses.includes(input.runStatus) ? null : new Date(),
        errorCode: ["failed", "timed_out"].includes(input.runStatus) ? "advice_admission_failed" : null,
        contextSnapshot: {
          issueId: input.issueId,
          taskId: input.issueId,
          interactionId: input.interactionId,
          interactionKind: "ask_user_questions",
          wakeReason: "interaction_pending",
        },
      });
      await db.insert(agentWakeupRequests).values({
        companyId: input.companyId,
        agentId: input.advisorAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "interaction_pending",
        payload: {
          issueId: input.issueId,
          interactionId: input.interactionId,
          interactionKind: "ask_user_questions",
          mutation: "interaction",
        },
        status: liveStatuses.includes(input.runStatus) ? "running" : "failed",
        idempotencyKey: `interaction-pending:${input.interactionId}`,
        runId: advisorRunId,
      });
      return advisorRunId;
    }

    async function ageInteraction(interactionId: string) {
      await db.update(issueThreadInteractions)
        .set({ createdAt: new Date(Date.now() - 20 * 60 * 1000) })
        .where(eq(issueThreadInteractions.id, interactionId));
    }

    it("settles a pending consultation after the addressed advisor run fails and continues the original owner", async () => {
      const scene = await seedReconciliationScene();
      const created = await createPendingConsultation(scene);
      const advisorRunId = await seedAdvisorWakeEvidence({
        companyId: scene.companyId,
        issueId: scene.issueId,
        advisorAgentId: scene.advisorAgentId,
        interactionId: created.id,
        runStatus: "failed",
      });
      const { recovery, wakeCalls } = makeRecovery();

      const outcome = await recovery.reconcileFailedAdviceForRun(advisorRunId);

      expect(outcome.status).toBe("reconciled");
      expect(outcome.settled).toBe(1);
      expect(outcome.continuationWakesArranged).toBe(1);
      expect(outcome.interactions[0]).toMatchObject({
        interactionId: created.id,
        issueId: scene.issueId,
        outcome: "settled",
        cause: "advisor_run_failed",
        advisorRunId,
      });

      // Truthful cancellation evidence — never a fabricated answer or approval.
      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row).toMatchObject({
        status: "cancelled",
        resolvedByAgentId: null,
        resolvedByRunId: null,
        resolvedByUserId: null,
      });
      expect(row.result).toMatchObject({
        version: 1,
        cancelled: true,
        answers: [],
        summaryMarkdown: null,
      });
      const result = row.result as AskUserQuestionsResult | null;
      expect(result?.cancellationReason).toContain("advisor run failed");
      expect(result?.cancellationReason).toContain(advisorRunId);
      expect(row.result).not.toHaveProperty("advice");
      // The durable continuation marker: arranged means a durable wake
      // receipt exists for the original owner.
      expect(row.result).toMatchObject({
        reconciliation: {
          cause: "advisor_run_failed",
          advisorRunId,
          continuation: "arranged",
        },
      });

      // One bounded, idempotent continuation wake to the original owner.
      expect(wakeCalls).toHaveLength(1);
      expect(wakeCalls[0]).toMatchObject({
        agentId: scene.workerAgentId,
        idempotencyKey: `advice-reconciliation:${created.id}`,
        reason: "advice_reconciliation",
      });
      expect(wakeCalls[0].payload).toMatchObject({
        issueId: scene.issueId,
        interactionId: created.id,
        interactionStatus: "cancelled",
      });

      // No approval, review, or assignment side effects.
      const [issueRow] = await db.select().from(issues).where(eq(issues.id, scene.issueId));
      expect(issueRow).toMatchObject({ status: "in_progress", assigneeAgentId: scene.workerAgentId });
    });

    it("settles a prelaunch-refused advisor run that was cancelled before dispatch", async () => {
      const scene = await seedReconciliationScene();
      const created = await createPendingConsultation(scene);
      const advisorRunId = await seedAdvisorWakeEvidence({
        companyId: scene.companyId,
        issueId: scene.issueId,
        advisorAgentId: scene.advisorAgentId,
        interactionId: created.id,
        runStatus: "cancelled",
      });
      const { recovery, wakeCalls } = makeRecovery();

      const outcome = await recovery.reconcileFailedAdviceForRun(advisorRunId);

      expect(outcome.settled).toBe(1);
      expect(outcome.interactions[0]).toMatchObject({ cause: "advisor_run_cancelled" });
      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row.status).toBe("cancelled");
      expect((row.result as AskUserQuestionsResult | null)?.cancellationReason)
        .toContain("was cancelled before answering");
      expect(wakeCalls).toHaveLength(1);
    });

    it("treats duplicate terminal processing as an honest no-op", async () => {
      const scene = await seedReconciliationScene();
      const created = await createPendingConsultation(scene);
      const advisorRunId = await seedAdvisorWakeEvidence({
        companyId: scene.companyId,
        issueId: scene.issueId,
        advisorAgentId: scene.advisorAgentId,
        interactionId: created.id,
        runStatus: "failed",
      });
      const { recovery, wakeCalls } = makeRecovery();

      const first = await recovery.reconcileFailedAdviceForRun(advisorRunId);
      expect(first.settled).toBe(1);

      const second = await recovery.reconcileFailedAdviceForRun(advisorRunId);
      expect(second.status).toBe("reconciled");
      expect(second.settled).toBe(0);
      expect(second.continuationWakesArranged).toBe(0);
      expect(second.interactions).toHaveLength(0);
      expect(wakeCalls).toHaveLength(1);

      // A still-live run never reconciles: terminal handling only reports
      // settled runs, and the method refuses to pre-empt a live advisor.
      const liveOutcome = await recovery.reconcileFailedAdviceForRun(scene.workerRunId);
      expect(liveOutcome.status).toBe("run_still_live");
      expect(liveOutcome.settled).toBe(0);
      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row.status).toBe("cancelled");
    });

    it("preserves the owed continuation across an enqueue failure and completes it on the restart sweep", async () => {
      const scene = await seedReconciliationScene();
      const created = await createPendingConsultation(scene);
      const advisorRunId = await seedAdvisorWakeEvidence({
        companyId: scene.companyId,
        issueId: scene.issueId,
        advisorAgentId: scene.advisorAgentId,
        interactionId: created.id,
        runStatus: "failed",
      });

      // Wake admission fails after settlement: the cancellation commits, and
      // the durable marker must keep the continuation owed.
      const failing = makeRecovery({ failWakeup: true });
      const first = await failing.recovery.reconcileFailedAdviceForRun(advisorRunId);
      expect(first.settled).toBe(1);
      expect(first.continuationWakesArranged).toBe(0);
      expect(first.interactions[0]).toMatchObject({
        outcome: "settled",
        cause: "advisor_run_failed",
        continuationState: "pending",
        continuationWakeArranged: false,
      });
      const [settledRow] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(settledRow.status).toBe("cancelled");
      expect(settledRow.result).toMatchObject({
        cancelled: true,
        reconciliation: {
          cause: "advisor_run_failed",
          advisorRunId,
          continuation: "pending",
        },
      });

      // The restart sweep retries the owed continuation with working
      // admission and settles the marker once a durable receipt exists.
      const { recovery, wakeCalls } = makeRecovery();
      const second = await recovery.reconcileFailedAdvice(scene.companyId);
      expect(second.settled).toBe(0);
      expect(second.continuationsRetried).toBe(1);
      expect(second.continuationWakesArranged).toBe(1);
      expect(wakeCalls).toHaveLength(1);
      expect(wakeCalls[0]).toMatchObject({
        agentId: scene.workerAgentId,
        idempotencyKey: `advice-reconciliation:${created.id}`,
      });
      const [retriedRow] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(retriedRow.result).toMatchObject({
        reconciliation: { continuation: "arranged" },
      });

      // A further sweep pass is a no-op: the continuation is no longer owed.
      const third = await recovery.reconcileFailedAdvice(scene.companyId);
      expect(third.continuationsRetried).toBe(0);
      expect(third.continuationWakesArranged).toBe(0);
      expect(wakeCalls).toHaveLength(1);
    });

    it("fences a late duplicate enqueue through the pre-admission bindWake callback", async () => {
      const scene = await seedReconciliationScene();
      const created = await createPendingConsultation(scene);
      const advisorRunId = await seedAdvisorWakeEvidence({
        companyId: scene.companyId,
        issueId: scene.issueId,
        advisorAgentId: scene.advisorAgentId,
        interactionId: created.id,
        runStatus: "failed",
      });

      // A failing admission leaves the settled card owing its continuation.
      const failing = makeRecovery({ failWakeup: true });
      await failing.recovery.reconcileFailedAdviceForRun(advisorRunId);

      // Two concurrent restart sweeps can both pass the receipt preflight
      // (enqueue admission does not dedupe idempotencyKeys). Model the race:
      // while the late arranger's admission is in flight, the competing
      // arranger wins the bindWake fence and commits its durable receipt —
      // the late admission's own fence must then refuse and roll back.
      let bindWakeInvocations = 0;
      const recovery = recoveryService(db, {
        enqueueWakeup: async (agentId, opts) => {
          const [wokenAgent] = await db
            .select({ companyId: agents.companyId })
            .from(agents)
            .where(eq(agents.id, agentId));
          if (!wokenAgent) throw new Error("wakeup_agent_missing");
          // The winning arranger fenced the marker and committed its receipt
          // while this admission was in flight.
          await db
            .update(issueThreadInteractions)
            .set({
              result: sql`jsonb_set(${issueThreadInteractions.result}, '{reconciliation,continuation}', '"arranged"'::jsonb)`,
              updatedAt: new Date(),
            })
            .where(and(
              eq(issueThreadInteractions.id, created.id),
              eq(issueThreadInteractions.companyId, scene.companyId),
              eq(issueThreadInteractions.status, "cancelled"),
              sql`${issueThreadInteractions.result}->'reconciliation'->>'continuation' = 'pending'`,
            ));
          await db.insert(agentWakeupRequests).values({
            companyId: wokenAgent.companyId,
            agentId,
            source: "automation",
            triggerDetail: "system",
            reason: opts?.reason ?? null,
            payload: opts?.payload ?? null,
            status: "queued",
            idempotencyKey: opts?.idempotencyKey ?? null,
          });
          // The late admission's fence must refuse: the marker is no longer
          // pending, so the duplicate rolls back instead of re-executing.
          await opts?.bindWake?.(db);
          bindWakeInvocations += 1;
        },
      });

      const sweep = await recovery.reconcileFailedAdvice(scene.companyId);

      // The late arranger lost the fence: its admission rolled back, the
      // outcome reports the continuation as arranged via the winner's
      // receipt, and exactly one durable wake exists (no double execution).
      expect(sweep.continuationsRetried).toBe(1);
      expect(sweep.continuationWakesArranged).toBe(1);
      expect(bindWakeInvocations).toBe(0);
      const receipts = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, `advice-reconciliation:${created.id}`));
      expect(receipts).toHaveLength(1);
      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row.result).toMatchObject({
        reconciliation: { continuation: "arranged" },
      });

      // The continuation is no longer owed.
      const again = await recovery.reconcileFailedAdvice(scene.companyId);
      expect(again.continuationsRetried).toBe(0);
    });

    it("stands down while a genuine deferred advisor continuation is alive", async () => {
      const scene = await seedReconciliationScene();
      const created = await createPendingConsultation(scene);
      await seedAdvisorWakeEvidence({
        companyId: scene.companyId,
        issueId: scene.issueId,
        advisorAgentId: scene.advisorAgentId,
        interactionId: created.id,
        runStatus: "failed",
      });
      await db.update(agentWakeupRequests)
        .set({ status: "deferred_issue_execution" })
        .where(eq(agentWakeupRequests.idempotencyKey, `interaction-pending:${created.id}`));
      const { recovery, wakeCalls } = makeRecovery();
      await ageInteraction(created.id);

      const outcome = await recovery.reconcileFailedAdvice(scene.companyId);

      expect(outcome.settled).toBe(0);
      expect(outcome.respectedLiveContinuation).toBe(1);
      expect(wakeCalls).toHaveLength(0);
      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row).toMatchObject({ status: "pending", result: null });
    });

    it("restart sweep settles orphans once and respects live continuations", async () => {
      const scene = await seedReconciliationScene();
      const created = await createPendingConsultation(scene);
      await seedAdvisorWakeEvidence({
        companyId: scene.companyId,
        issueId: scene.issueId,
        advisorAgentId: scene.advisorAgentId,
        interactionId: created.id,
        runStatus: "failed",
      });
      await ageInteraction(created.id);
      const { recovery, wakeCalls } = makeRecovery();

      const first = await recovery.reconcileFailedAdvice(scene.companyId);
      expect(first.companyId).toBe(scene.companyId);
      expect(first.scanned).toBe(1);
      expect(first.settled).toBe(1);
      expect(first.continuationsRetried).toBe(0);
      expect(first.truncated).toBe(false);
      expect(first.interactions[0]).toMatchObject({
        interactionId: created.id,
        issueId: scene.issueId,
        outcome: "settled",
        cause: "advisor_run_failed",
        advisorRunId: expect.any(String),
        continuationState: "arranged",
        continuationWakeArranged: true,
      });
      expect(wakeCalls).toHaveLength(1);

      // A second restart pass is idempotent: nothing left to settle and no
      // continuation left owed.
      const second = await recovery.reconcileFailedAdvice(scene.companyId);
      expect(second.scanned).toBe(0);
      expect(second.settled).toBe(0);
      expect(second.continuationsRetried).toBe(0);
      expect(second.continuationWakesArranged).toBe(0);
      expect(wakeCalls).toHaveLength(1);
    });

    it("settles a pending consultation when the advisor exits successfully without answering", async () => {
      const scene = await seedReconciliationScene();
      const created = await createPendingConsultation(scene);
      const advisorRunId = await seedAdvisorWakeEvidence({
        companyId: scene.companyId,
        issueId: scene.issueId,
        advisorAgentId: scene.advisorAgentId,
        interactionId: created.id,
        runStatus: "succeeded",
      });
      const { recovery } = makeRecovery();

      const outcome = await recovery.reconcileFailedAdviceForRun(advisorRunId);
      expect(outcome.settled).toBe(1);
      expect(outcome.interactions[0]).toMatchObject({ cause: "advisor_run_exited_without_answer" });
      const [row] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, created.id));
      expect(row.status).toBe("cancelled");
      expect((row.result as AskUserQuestionsResult | null)?.cancellationReason)
        .toContain("exited without answering");
    });

    it("preserves review confirmations, approval state, and issue assignment while reconciling advice", async () => {
      const scene = await seedReconciliationScene();
      const created = await createPendingConsultation(scene);
      const advisorRunId = await seedAdvisorWakeEvidence({
        companyId: scene.companyId,
        issueId: scene.issueId,
        advisorAgentId: scene.advisorAgentId,
        interactionId: created.id,
        runStatus: "failed",
      });
      await ageInteraction(created.id);

      // An unrelated pending confirmation card on the same issue must not be
      // touched by advice reconciliation.
      const reviewInteractionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: reviewInteractionId,
        companyId: scene.companyId,
        issueId: scene.issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "none",
        createdByAgentId: scene.workerAgentId,
        sourceRunId: scene.workerRunId,
        payload: {
          version: 1,
          prompt: "Approve the dependency bump?",
        },
      });
      const { recovery } = makeRecovery();

      const outcome = await recovery.reconcileFailedAdviceForRun(advisorRunId);
      expect(outcome.settled).toBe(1);

      const [reviewRow] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, reviewInteractionId));
      expect(reviewRow).toMatchObject({ kind: "request_confirmation", status: "pending", result: null });

      const [issueRow] = await db.select().from(issues).where(eq(issues.id, scene.issueId));
      expect(issueRow).toMatchObject({ status: "in_progress", assigneeAgentId: scene.workerAgentId });
    });
  });
});
