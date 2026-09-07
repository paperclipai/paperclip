import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, approvals, companies, createDb, documents, heartbeatRuns, issueApprovals, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { documentService } from "../documents.js";
import { issueService } from "../issues.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("PaperclipRunnerToolAuthority", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = "00000000-0000-4000-8000-000000000101";
  const agentId = "00000000-0000-4000-8000-000000000102";
  const issueId = "00000000-0000-4000-8000-000000000103";
  const runId = "00000000-0000-4000-8000-000000000104";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-runner-tools-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Runner tools",
      issuePrefix: "RNT",
      issueCounter: 1,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runner agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", apiKey: "must-not-leak" },
      runtimeConfig: { token: "must-not-leak" },
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "RNT-1",
      title: "Exercise real runner tools",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  it("advertises only real bindings and reads the bound task", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    expect(authority.definitions()).toHaveLength(16);
    expect(authority.definitions().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "get_task_context", "get_task_history", "search_tasks", "report_progress",
      "request_human_input",
      "create_task", "set_dependencies",
      "list_documents", "read_document", "list_document_revisions", "write_document",
      "list_agents", "get_agent", "list_approvals", "get_approval", "get_approval_context",
    ]));
    const context = await authority.execute({ tool: "get_task_context", callId: "context", arguments: {} });
    expect(context).toMatchObject({
      activeTask: { id: issueId, identifier: "RNT-1" },
      actor: { id: agentId },
    });
    expect(JSON.stringify(context)).not.toContain("must-not-leak");
    await expect(authority.execute({ tool: "finish_task", callId: "hidden", arguments: {} }))
      .rejects.toThrow("paperclip_runner_tool_not_advertised");
  });

  it("advertises structured human input in ask mode", () => {
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
      workMode: "ask",
    });
    expect(authority.definitions().map((tool) => tool.name)).toContain("request_human_input");
    expect(authority.definitions().map((tool) => tool.name)).not.toContain("create_task");
    expect(authority.definitions().map((tool) => tool.name)).not.toContain("set_dependencies");
  });

  it("does not project a foreign-company task through approval context", async () => {
    const foreignCompanyId = "00000000-0000-4000-8000-000000000211";
    const foreignIssueId = "00000000-0000-4000-8000-000000000212";
    const approvalId = "00000000-0000-4000-8000-000000000213";
    await db.insert(companies).values({
      id: foreignCompanyId,
      name: "Foreign approval company",
      issuePrefix: "FAC",
      issueCounter: 1,
    });
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId: foreignCompanyId,
      issueNumber: 1,
      identifier: "FAC-1",
      title: "Must not cross the approval boundary",
      status: "todo",
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "runner_review",
      status: "pending",
      payload: {},
    });
    // The schema deliberately stores companyId independently on the link. A
    // corrupt or historical cross-tenant link must still fail closed at read.
    await db.insert(issueApprovals).values({
      companyId,
      approvalId,
      issueId: foreignIssueId,
      linkedByAgentId: agentId,
    });

    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
    });
    await expect(authority.execute({
      tool: "get_approval_context",
      callId: "foreign-approval-context",
      arguments: { approvalId },
    })).resolves.toMatchObject({ approval: { id: approvalId }, tasks: [] });
  });

  it("does not advertise delegation tools during pre-acceptance planning", () => {
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
      workMode: "planning",
    });
    expect(authority.definitions().map((tool) => tool.name)).not.toContain("create_task");
    expect(authority.definitions().map((tool) => tool.name)).not.toContain("set_dependencies");
  });

  it("writes progress through the real issue service and replays idempotently", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    const call = {
      tool: "report_progress",
      callId: "progress",
      arguments: { body: "Runner progress", idempotencyKey: "progress-1" },
    };
    const first = await authority.execute(call);
    const replay = await authority.execute({ ...call, callId: "progress-replay" });
    expect(replay).toEqual(first);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .toHaveLength(1);
    const progressActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(progressActivity).toHaveLength(1);
    expect(progressActivity[0]).toMatchObject({
      action: "issue.comment_added",
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId,
      entityType: "issue",
      entityId: issueId,
      details: expect.objectContaining({
        bodySnippet: "Runner progress",
        identifier: "RNT-1",
        issueTitle: "Exercise real runner tools",
        source: "paperclip_runner_protocol",
      }),
    });
    await expect(authority.execute({
      ...call,
      arguments: { body: "Changed", idempotencyKey: "progress-1" },
    })).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
  });

  it("creates checkbox interactions through the real interaction service", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    const call = {
      tool: "request_human_input",
      callId: "ask-checkbox",
      arguments: {
        idempotencyKey: "favorite-animals",
        interactionKind: "checkbox",
        title: "Favorite zoo animals",
        prompt: "Which zoo animals are your favorites?",
        continuationPolicy: "wake_assignee",
        payload: {
          options: [
            { id: "giraffes", label: "Giraffes" },
            { id: "lions", label: "Lions" },
          ],
        },
      },
    };
    const first = await authority.execute(call);
    await expect(authority.execute({ ...call, callId: "ask-checkbox-replay" })).resolves.toEqual(first);
    expect(first).toMatchObject({
      interaction: { kind: "request_checkbox_confirmation", status: "pending" },
    });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId)))
      .toHaveLength(1);
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, issueId)))
      .filter((entry) => entry.action === "issue.thread_interaction_created"))
      .toHaveLength(1);
    await expect(authority.execute({
      ...call,
      callId: "ask-checkbox-conflict",
      arguments: {
        ...call.arguments,
        prompt: "Use the same key for a different prompt.",
      },
    })).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
  });

  it("writes a real revisioned document and replays the mutation receipt", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    const call = {
      tool: "write_document",
      callId: "write-plan",
      arguments: {
        idempotencyKey: "write-plan-1",
        key: "plan",
        title: "Execution plan",
        body: "Use the real document service.",
        // Provider bridges may serialize nullable string inputs as the literal
        // "null". The protocol boundary treats that as document creation.
        baseRevisionId: "null",
        changeSummary: "Initial plan",
      },
    };
    const first = await authority.execute(call);
    const replay = await authority.execute({ ...call, callId: "write-plan-replay" });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      disposition: "applied",
      created: true,
      document: { key: "plan", body: "Use the real document service." },
    });
    expect(await db.select().from(documents).where(eq(documents.companyId, companyId))).toHaveLength(1);
    const documentActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(documentActivity.filter((entry) => entry.action === "issue.document_created")).toEqual([
      expect.objectContaining({
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId,
        entityType: "issue",
        details: expect.objectContaining({
          key: "plan",
          source: "paperclip_runner_protocol",
        }),
      }),
    ]);
    await expect(authority.execute({
      ...call,
      arguments: { ...call.arguments, body: "Conflicting retry." },
    })).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
  });

  it("returns the exact accepted plan revision in task context", async () => {
    const plan = await documentService(db).getIssueDocumentByKey(issueId, "plan");
    expect(plan).not.toBeNull();
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    const requested = await authority.execute({
      tool: "request_human_input",
      callId: "approve-plan",
      arguments: {
        idempotencyKey: `confirmation:${issueId}:plan:${plan!.latestRevisionId}`,
        interactionKind: "confirmation",
        title: "Approve the plan",
        prompt: "Approve this exact plan revision?",
        payload: {
          target: {
            type: "issue_document",
            issueId,
            documentId: plan!.id,
            key: "plan",
            revisionId: plan!.latestRevisionId,
            revisionNumber: plan!.latestRevisionNumber,
          },
        },
        targetRevisionId: plan!.latestRevisionId,
        continuationPolicy: "wake_assignee_on_accept",
      },
    });
    expect(requested).toMatchObject({
      interaction: {
        kind: "request_confirmation",
        status: "pending",
        payload: {
          target: {
            type: "issue_document",
            issueId,
            key: "plan",
            revisionId: plan!.latestRevisionId,
          },
        },
      },
    });
    await db.update(issueThreadInteractions).set({
      status: "accepted",
      resolvedByUserId: "test-user",
      resolvedAt: new Date(),
      result: { outcome: "accepted" } as never,
    }).where(eq(issueThreadInteractions.id, (requested as { interaction: { id: string } }).interaction.id));
    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        issueId,
        workspaceRefreshReason: "accepted_plan_confirmation",
        planReviewInteraction: {
          acceptedTargetRevision: {
            issueId,
            documentId: plan!.id,
            key: "plan",
            revisionId: plan!.latestRevisionId,
            revisionNumber: plan!.latestRevisionNumber,
          },
        },
      },
    }).where(eq(heartbeatRuns.id, runId));

    await expect(authority.execute({ tool: "get_task_context", callId: "accepted-context", arguments: {} }))
      .resolves.toMatchObject({
        acceptedPlan: {
          documentId: plan!.id,
          revisionId: plan!.latestRevisionId,
          revisionNumber: plan!.latestRevisionNumber,
          markdown: "Use the real document service.",
        },
      });
  });

  it("creates ordinary children, preserves blockers, and deduplicates across runs", async () => {
    const wakes: Array<{ agentId: string; options: Record<string, unknown> }> = [];
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
      workMode: "standard",
      enqueueWakeup: async (wakeAgentId, options) => {
        wakes.push({ agentId: wakeAgentId, options });
        return null;
      },
    });
    expect(authority.definitions().map((tool) => tool.name)).toContain("create_task");

    const prerequisite = await authority.execute({
      tool: "create_task",
      callId: "create-prerequisite",
      arguments: {
        idempotencyKey: "ordinary-prerequisite",
        title: "Prepare delegated input",
        description: "A self-contained prerequisite delegated from the active task.",
      },
    });

    expect(prerequisite).toMatchObject({
      disposition: "applied",
      task: {
        parentId: issueId,
        status: "todo",
        assigneeActorId: agentId,
      },
    });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId,
      options: {
        reason: "issue_assigned",
        payload: { parentIssueId: issueId },
      },
    });
    const prerequisiteId = (prerequisite as { task: { id: string } }).task.id;
    const dependent = await authority.execute({
      tool: "create_task",
      callId: "create-dependent",
      arguments: {
        idempotencyKey: "ordinary-dependent",
        title: "Use delegated input",
        blockedByTaskIds: [prerequisiteId],
      },
    });
    expect(dependent).toMatchObject({
      disposition: "applied",
      scheduledWakeIds: [],
      task: { parentId: issueId, status: "blocked", assigneeActorId: agentId },
    });
    expect(wakes).toHaveLength(1);
    await expect(issueService(db).getRelationSummaries(issueId)).resolves.toMatchObject({
      blockedBy: [],
    });

    await authority.execute({
      tool: "set_dependencies",
      callId: "wait-for-prerequisite",
      arguments: {
        idempotencyKey: "source-waits-for-prerequisite",
        blockedByTaskIds: [prerequisiteId],
      },
    });
    await expect(issueService(db).getRelationSummaries(issueId)).resolves.toMatchObject({
      blockedBy: [expect.objectContaining({ id: prerequisiteId })],
    });

    await issueService(db).update(prerequisiteId, {
      status: "done",
      actorAgentId: agentId,
    });
    await expect(authority.execute({
      tool: "create_task",
      callId: "create-dependency-ready-child",
      arguments: {
        idempotencyKey: "ordinary-ready-dependent",
        title: "Start after completed delegated input",
        blockedByTaskIds: [prerequisiteId],
      },
    })).resolves.toMatchObject({
      disposition: "applied",
      task: { parentId: issueId, status: "todo", assigneeActorId: agentId },
      scheduledWakeIds: [expect.any(String)],
    });
    expect(wakes).toHaveLength(2);

    const nextRunId = "00000000-0000-4000-8000-000000000106";
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, issueId));
    const retryWakes: Array<unknown> = [];
    const retryAuthority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId: nextRunId,
      workMode: "standard",
      enqueueWakeup: async (_wakeAgentId, options) => {
        retryWakes.push(options);
        return null;
      },
    });
    await expect(retryAuthority.execute({
      tool: "create_task",
      callId: "cross-run-retry",
      arguments: {
        idempotencyKey: "ordinary-prerequisite",
        title: "Prepare delegated input",
        description: "A self-contained prerequisite delegated from the active task.",
      },
    })).resolves.toMatchObject({ disposition: "duplicate", task: { id: prerequisiteId } });
    await expect(retryAuthority.execute({
      tool: "create_task",
      callId: "cross-run-conflicting-retry",
      arguments: {
        idempotencyKey: "ordinary-prerequisite",
        title: "Conflicting title for the same caller key",
      },
    })).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");

    const foreignCompanyId = "00000000-0000-4000-8000-000000000201";
    const foreignAgentId = "00000000-0000-4000-8000-000000000202";
    const foreignIssueId = "00000000-0000-4000-8000-000000000203";
    await db.insert(companies).values({
      id: foreignCompanyId,
      name: "Foreign company",
      issuePrefix: "FGN",
      issueCounter: 1,
    });
    await db.insert(agents).values({
      id: foreignAgentId,
      companyId: foreignCompanyId,
      name: "Foreign agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      status: "active",
    });
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId: foreignCompanyId,
      issueNumber: 1,
      identifier: "FGN-1",
      title: "Foreign blocker",
      status: "todo",
    });
    await expect(retryAuthority.execute({
      tool: "create_task",
      callId: "foreign-assignee",
      arguments: {
        idempotencyKey: "foreign-assignee",
        title: "Invalid foreign assignment",
        assigneeActorId: foreignAgentId,
      },
    })).rejects.toThrow("paperclip_runner_agent_not_found");
    await expect(retryAuthority.execute({
      tool: "create_task",
      callId: "foreign-blocker",
      arguments: {
        idempotencyKey: "foreign-blocker",
        title: "Invalid foreign blocker",
        blockedByTaskIds: [foreignIssueId],
      },
    })).rejects.toThrow();
    expect(retryWakes).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.parentId, issueId))).toHaveLength(3);
  });

  it("rejects mutations after reassignment, run replacement, or terminalization", async () => {
    const guardedIssueId = "00000000-0000-4000-8000-000000000107";
    const guardedRunId = "00000000-0000-4000-8000-000000000108";
    const guardedReplacementRunId = "00000000-0000-4000-8000-000000000109";
    await db.insert(issues).values({
      id: guardedIssueId,
      companyId,
      issueNumber: 999,
      identifier: "RNT-999",
      title: "Guard mutation authorization",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: guardedRunId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: guardedIssueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId: guardedIssueId },
    });
    await db.insert(heartbeatRuns).values({
      id: guardedReplacementRunId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: guardedIssueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId: guardedIssueId },
    });
    await db.update(issues).set({ executionRunId: guardedRunId }).where(eq(issues.id, guardedIssueId));
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId: guardedIssueId,
      runId: guardedRunId,
    });
    const mutation = {
      tool: "report_progress",
      callId: "guarded-progress",
      arguments: { body: "Must remain authorized", idempotencyKey: "guarded-progress" },
    };

    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, guardedIssueId));
    await expect(authority.execute(mutation))
      .rejects.toThrow("paperclip_runner_tool_binding_not_authorized");

    await db.update(issues).set({
      assigneeAgentId: agentId,
      executionRunId: guardedReplacementRunId,
    }).where(eq(issues.id, guardedIssueId));
    await expect(authority.execute({ ...mutation, callId: "replaced-run" }))
      .rejects.toThrow("paperclip_runner_tool_binding_not_authorized");

    await db.update(issues).set({ executionRunId: guardedRunId }).where(eq(issues.id, guardedIssueId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, guardedRunId));
    await expect(authority.execute({ ...mutation, callId: "terminal-run" }))
      .rejects.toThrow("paperclip_runner_tool_binding_not_authorized");

    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, guardedIssueId)))
      .toHaveLength(0);
  });

  it("fails closed once the run is no longer active", async () => {
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    await expect(authority.execute({ tool: "get_task_context", callId: "late", arguments: {} }))
      .rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
  });
});
