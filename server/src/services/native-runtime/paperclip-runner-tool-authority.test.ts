import * as cloudIdentity from "../cloud-runtime-identity.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { initializeRunIdentity, reserveSteeredIdentity, reconcileSteeredIdentity } from "../run-identity.js";
import { documentService } from "../documents.js";
import { issueService } from "../issues.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { READ_CURRENT_WAKE_COMMENTS_TOOL_NAME } from "./current-wake-comments.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../../vendor/paperclip-runner/index.js";

describe("PaperclipRunnerToolAuthority", () => {
  let temporary: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = "00000000-0000-4000-8000-000000000101";
  const agentId = "00000000-0000-4000-8000-000000000102";
  const issueId = "00000000-0000-4000-8000-000000000103";
  const runId = "00000000-0000-4000-8000-000000000104";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "paperclip-runner-tools-",
    );
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
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  it("advertises only real bindings and reads the bound task", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
    });
    expect(authority.definitions()).toHaveLength(27);
    const questions = authority.definitions().find(tool => tool.name === "request_human_input")!;
    expect(questions.description).toContain("ask only the next unanswered question");
    expect(questions.description).toContain("Never infer answers");
    expect(questions.description).toContain("Do not fabricate answer links");
    expect(JSON.stringify(questions.inputSchema)).toContain("at least two distinct meaningful options");
    expect(JSON.stringify(questions.inputSchema)).toContain("answerMode:'text'");

    expect(authority.definitions().map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "connections_search",
        "connection_request", "create_project", "list_project_repositories", "list_projects",
        "get_task_context",
        "get_task_history",
        "search_tasks",
        "report_progress",
        "request_human_input",
        "create_task",
        "set_dependencies",
        "list_documents",
        "read_document",
        "list_document_revisions",
        "write_document",
        "create_skill",
        "list_agents",
        "get_agent",
        "list_approvals",
        "get_approval",
        "get_approval_context",
        READ_CURRENT_WAKE_COMMENTS_TOOL_NAME,
        "list_chat_attachments",
        "reuse_chat_attachment",
        "read_chat_attachment",
      ]),
    );
    const context = await authority.execute({
      tool: "get_task_context",
      callId: "context",
      arguments: {},
    });
    expect(context).toMatchObject({
      activeTask: { id: issueId, identifier: "RNT-1" },
      actor: { id: agentId },
    });
    expect(JSON.stringify(context)).not.toContain("must-not-leak");
    await expect(
      authority.execute({
        tool: "finish_task",
        callId: "hidden",
        arguments: {},
      }),
    ).rejects.toThrow("paperclip_runner_tool_not_advertised");
    await expect(
      authority.execute({
        tool: "list_chat_attachments",
        callId: "historical-list-without-chat-binding",
        arguments: {},
      }),
    ).rejects.toThrow("paperclip_runner_chat_attachment_binding_denied");
    await expect(
      authority.execute({
        tool: READ_CURRENT_WAKE_COMMENTS_TOOL_NAME,
        callId: "reader-without-bound-wake",
        arguments: {},
      }),
    ).rejects.toThrow("paperclip_runner_tool_not_advertised");
  });

  it("returns public task URLs from the current claimed origin in context and search results", async () => {
    const origin = vi.spyOn(cloudIdentity, "runtimeCanonicalOrigin").mockReturnValue("https://board.example");
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    try {
      expect(await authority.execute({ tool: "get_task_context", callId: "public-task-url", arguments: {} }))
        .toMatchObject({ activeTask: { id: issueId, url: `https://board.example/issues/${issueId}` } });
      expect(await authority.execute({ tool: "search_tasks", callId: "search-public-task-url", arguments: { query: "Exercise real runner tools" } }))
        .toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ id: issueId, url: `https://board.example/issues/${issueId}` })]) });
      origin.mockReturnValue("https://renamed.example");
      expect(await authority.execute({ tool: "get_task_context", callId: "renamed-task-url", arguments: {} }))
        .toMatchObject({ activeTask: { url: `https://renamed.example/issues/${issueId}` } });
      origin.mockReturnValue("https://localhost");
      expect(await authority.execute({ tool: "get_task_context", callId: "unsafe-task-url", arguments: {} }))
        .toMatchObject({ activeTask: { url: null } });
    } finally {
      origin.mockRestore();
    }
  });

  it("exposes existing child tasks on continuation without crossing company boundaries", async () => {
    const completedChildId = randomUUID();
    const activeChildId = randomUUID();
    const unrelatedId = randomUUID();
    const otherCompanyId = randomUUID();
    const foreignChildId = randomUUID();
    const hiddenChildIds = Array.from({ length: 101 }, () => randomUUID());
    await db.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" });
    await db.insert(issues).values([
      { id: completedChildId, companyId, parentId: issueId, title: "Existing completed draft", status: "done", assigneeAgentId: agentId },
      { id: activeChildId, companyId, parentId: issueId, title: "Existing active review", status: "in_progress", assigneeAgentId: agentId },
      { id: unrelatedId, companyId, title: "Unrelated task", status: "todo" },
      // Even inconsistent imported data cannot expose another company's task.
      { id: foreignChildId, companyId: otherCompanyId, parentId: issueId, title: "Foreign child", status: "todo" },
      // Hidden rows must neither enter context nor consume the visible child limit.
      ...hiddenChildIds.map((id) => ({ id, companyId, parentId: issueId, title: "Hidden child",
        hiddenAt: new Date(), createdAt: new Date(Date.now() + 1000) })),
    ]);
    try {
      const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
      const context = await authority.execute({ tool: "get_task_context", callId: "context-existing-children", arguments: {} });
      expect(context).toMatchObject({
        childTasks: expect.arrayContaining([
          expect.objectContaining({ id: completedChildId, status: "done", parentId: issueId }),
          expect.objectContaining({ id: activeChildId, status: "in_progress", assigneeAgentId: agentId }),
        ]),
        childTasksTruncated: false,
        delegationGuidance: expect.stringContaining("Reuse existing child tasks"),
      });
      expect(JSON.stringify(context)).not.toContain(foreignChildId);
      expect(JSON.stringify(context)).not.toContain(unrelatedId);
      for (const id of hiddenChildIds) expect(JSON.stringify(context)).not.toContain(id);
    } finally {
      await db.delete(issues).where(inArray(issues.id, [completedChildId, activeChildId, unrelatedId, foreignChildId, ...hiddenChildIds]));
      await db.delete(companies).where(eq(companies.id, otherCompanyId));
    }
  });

  it("preserves direct-chat file tools across the guarded API rollout", () => {
    const previousEnabled = process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
    const previousCompanies =
      process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS;
    const createAuthority = () =>
      new PaperclipRunnerToolAuthority(db, {
        companyId,
        agentId,
        issueId,
        runId,
        workspaceRoot: "/tmp/paperclip-runner-tools",
        executionTargetKind: "local",
      });
    const requiredChatFileTools = [
      READ_CURRENT_WAKE_COMMENTS_TOOL_NAME,
      "list_chat_attachments",
      "reuse_chat_attachment",
      "read_chat_attachment",
      "register_deliverable",
    ];

    try {
      delete process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
      delete process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS;
      const disabledNames = createAuthority()
        .definitions()
        .map((tool) => tool.name);
      expect(disabledNames).toEqual(
        expect.arrayContaining(requiredChatFileTools),
      );
      expect(disabledNames).not.toContain("search_api");
      expect(disabledNames).not.toContain("call_api");
      expect(disabledNames).not.toContain("hire_agent");

      process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED = "true";
      process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS = companyId;
      const enabledNames = createAuthority()
        .definitions()
        .map((tool) => tool.name);
      expect(enabledNames).toEqual(
        expect.arrayContaining([
          ...requiredChatFileTools,
          "search_api",
          "call_api",
          "hire_agent",
        ]),
      );
      const hire = createAuthority().definitions().find((tool) => tool.name === "hire_agent")!;
      const hireSchema = hire.inputSchema as { properties: Record<string, unknown> };
      expect(hireSchema.properties).toEqual(expect.objectContaining({ name: expect.any(Object), role: expect.any(Object) }));
      expect(hireSchema.properties).not.toHaveProperty("adapterConfig");
      expect(hireSchema.properties).not.toHaveProperty("env");
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
      } else {
        process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED = previousEnabled;
      }
      if (previousCompanies === undefined) {
        delete process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS;
      } else {
        process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS = previousCompanies;
      }
    }
  });

  it("dispatches hire_agent with fixed caller context and replays its API receipt", async () => {
    const previousEnabled = process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
    const previousCompanies = process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS;
    const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "hire-agent-test-secret";
    process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED = "true";
    process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS = companyId;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: randomUUID(), status: "active" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const authority = new PaperclipRunnerToolAuthority(db, {
        companyId,
        agentId,
        issueId,
        runId,
        apiUrl: "http://runner-test.invalid",
      });
      const call = {
        tool: "hire_agent",
        callId: "hire-agent-receipt",
        arguments: {
          name: "QA teammate",
          role: "qa",
          title: "Quality lead",
          capabilities: "Test native workflows",
          instructions: "Use the assigned workspace and report findings.",
        },
      } as const;
      const first = await authority.execute(call);
      expect(first).toMatchObject({ ok: true, status: 201, apiOperationId: "POST /api/companies/{companyId}/agent-hires" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe(`http://runner-test.invalid/api/companies/${companyId}/agent-hires`);
      const body = JSON.parse(String(request.body));
      expect(body).toMatchObject({
        name: "QA teammate",
        role: "qa",
        title: "Quality lead",
        capabilities: "Test native workflows",
        adapterType: "paperclip_runner",
        inheritRuntimeFrom: "caller",
        reportsTo: agentId,
        sourceIssueId: issueId,
        instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": "Use the assigned workspace and report findings." } },
      });
      expect(body).not.toHaveProperty("adapterConfig");
      expect(body).not.toHaveProperty("runtimeConfig");
      expect(body).not.toHaveProperty("env");
      await expect(authority.execute(call)).resolves.toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      if (previousEnabled === undefined) delete process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
      else process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED = previousEnabled;
      if (previousCompanies === undefined) delete process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS;
      else process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS = previousCompanies;
      if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    }
  });

  it("advertises structured human input in ask mode", () => {
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
      workMode: "ask",
    });
    expect(authority.definitions().map((tool) => tool.name)).toContain(
      "request_human_input",
    );
    expect(authority.definitions().map((tool) => tool.name)).not.toContain(
      "create_task",
    );
    expect(authority.definitions().map((tool) => tool.name)).not.toContain(
      "set_dependencies",
    );
  });

  it.each(["standard", "ask"] as const)(
    "advertises real task-bound questions and provider-dependent controls in %s mode",
    (workMode) => {
      const original = CAPABILITY_SEMANTIC_TOOL_CATALOG.find(
        (tool) => tool.operationId === "request_human_input",
      )!;
      const originalSnapshot = structuredClone(original);
      const authority = new PaperclipRunnerToolAuthority(db, {
        companyId,
        agentId,
        issueId,
        runId,
        workMode,
      });
      const advertised = JSON.parse(
        JSON.stringify(authority.definitions()),
      ).find((tool: { name: string }) => tool.name === "request_human_input");
      expect(advertised.description).toContain(
        "current Paperclip task bound to this run",
      );
      expect(advertised.description).toContain(
        "payload.questions for choices",
      );
      expect(advertised.description).toContain(
        "Paperclip renders it and authenticates the response",
      );
      expect(advertised.description).toContain(
        "Preserve existing review gates",
      );
      expect(advertised.description).not.toContain("mock");
      expect(advertised.description).not.toContain("questionSpec");
      expect(advertised.inputSchema).toEqual(original.inputSchema);
      expect(advertised.inputSchema.properties).toHaveProperty("payload");
      expect(advertised.inputSchema.properties).not.toHaveProperty(
        "questionSpec",
      );
      expect(original).toEqual(originalSnapshot);
    },
  );

  it.each(["choice", "text"] as const)("executes the advertised %s question once on the bound reviewed task", async (answerMode) => {
    const binding = {
      companyId: randomUUID(),
      agentId: randomUUID(),
      issueId: randomUUID(),
      runId: randomUUID(),
    };
    await db.insert(companies).values({
      id: binding.companyId,
      name: "Question invocation",
      issuePrefix: answerMode === "choice" ? "RQA" : "RQT",
    });
    await db.insert(agents).values({
      id: binding.agentId,
      companyId: binding.companyId,
      name: "Question agent",
      adapterType: "paperclip_runner",
      status: "active",
    });
    await db.insert(issues).values({
      id: binding.issueId,
      companyId: binding.companyId,
      title: "Question on reviewed task",
      status: "in_review",
      workMode: "standard",
      reviewPolicy: "human_only",
      assigneeAgentId: binding.agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: binding.runId,
      companyId: binding.companyId,
      agentId: binding.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: binding.issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId: binding.issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: binding.runId })
      .where(eq(issues.id, binding.issueId));
    const authority = new PaperclipRunnerToolAuthority(db, binding);
    const advertised = authority
      .definitions()
      .find((tool) => tool.name === "request_human_input")!;
    expect(advertised.description).toContain("payload.questions");
    const questions = [
      {
        id: "color",
        prompt: "Choose one color",
        selectionMode: "single",
        required: true,
        options: [
          { id: "amber", label: "Amber" },
          { id: "cobalt", label: "Cobalt" },
        ],
      },
    ];
    const payloadDescription = (advertised.inputSchema as {
      properties: { payload: { description: string } };
    }).properties.payload.description;
    expect(payloadDescription).toContain("at least two distinct meaningful options");
    expect(payloadDescription).toContain("questionSet");
    expect(payloadDescription).not.toContain("use exactly");
    const payload = answerMode === "choice"
      ? { version: 1, questions }
      : {
          version: 1,
          questions: [{
            id: "goal",
            prompt: "What should we accomplish?",
            selectionMode: "single",
            required: true,
            options: [{ id: "describe", label: "Your answer", freeText: true }],
          }],
          questionSet: {
            schema: "paperclip.question_set.v1",
            questions: [{
              id: "goal",
              prompt: "What should we accomplish?",
              answerMode: "text",
              required: true,
            }],
          },
        };
    const call = {
      tool: "request_human_input",
      callId: "advertised-question",
      arguments: {
        idempotencyKey: "advertised-question",
        interactionKind: "questions",
        title: "Choose one color",
        prompt: "Choose one color",
        continuationPolicy: "wake_assignee",
        payload,
      },
    };
    const first = await authority.execute(call);
    expect(first).toMatchObject({
      disposition: "applied",
      interaction: {
        companyId: binding.companyId,
        issueId: binding.issueId,
        sourceRunId: binding.runId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        payload,
      },
    });
    await expect(
      authority.execute({ ...call, callId: "advertised-question-replay" }),
    ).resolves.toEqual(first);
    const rows = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, binding.issueId));
    expect(rows).toHaveLength(1);
    const [task] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, binding.issueId));
    expect(task).toMatchObject({
      status: "in_review",
      reviewPolicy: "human_only",
      assigneeAgentId: binding.agentId,
      executionRunId: binding.runId,
    });
    const entries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, binding.issueId));
    expect(
      entries.filter(
        (entry) => entry.action === "issue.thread_interaction_created",
      ),
    ).toHaveLength(1);
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
    await expect(
      authority.execute({
        tool: "get_approval_context",
        callId: "foreign-approval-context",
        arguments: { approvalId },
      }),
    ).resolves.toMatchObject({ approval: { id: approvalId }, tasks: [] });
  });

  it("relays assigned MCP calls only while the native run still owns its task", async () => {
    const tool = { name: "app_mem0_recall", description: "Recall memory", inputSchema: { type: "object" } };
    const execute = vi.fn().mockResolvedValue({ content: "synthetic memory" });
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId, agentId, issueId, runId,
      assignedMcpTools: { definitions: () => [tool], has: (name) => name === tool.name, execute },
    });
    expect(authority.definitions()).toContainEqual(tool);
    const call = { tool: tool.name, callId: "assigned-mcp", arguments: { query: "compass" } };
    await expect(authority.execute(call)).resolves.toEqual({ content: "synthetic memory" });
    expect(execute).toHaveBeenCalledWith(call, "standard");
    await db.update(issues).set({ workMode: "ask" }).where(eq(issues.id, issueId));
    try {
      await authority.execute(call);
      expect(execute).toHaveBeenLastCalledWith(call, "ask");
    } finally {
      await db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, issueId));
    }
    execute.mockClear();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    try {
      await expect(authority.execute(call)).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    }
  });

  it("does not advertise delegation tools during pre-acceptance planning", () => {
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
      workMode: "planning",
    });
    expect(authority.definitions().map((tool) => tool.name)).not.toContain(
      "create_task",
    );
    expect(authority.definitions().map((tool) => tool.name)).not.toContain(
      "set_dependencies",
    );
  });

  it("writes progress through the real issue service and replays idempotently", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
    });
    const call = {
      tool: "report_progress",
      callId: "progress",
      arguments: { body: "Runner progress", idempotencyKey: "progress-1" },
    };
    const first = await authority.execute(call);
    const replay = await authority.execute({
      ...call,
      callId: "progress-replay",
    });
    expect(replay).toEqual(first);
    expect(
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId)),
    ).toHaveLength(1);
    const progressActivity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.comment_added")));
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
    await expect(
      authority.execute({
        ...call,
        arguments: { body: "Changed", idempotencyKey: "progress-1" },
      }),
    ).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
  });

  it("creates checkbox interactions through the real interaction service", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
    });
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
    await expect(
      authority.execute({ ...call, callId: "ask-checkbox-replay" }),
    ).resolves.toEqual(first);
    expect(first).toMatchObject({
      interaction: { kind: "request_checkbox_confirmation", status: "pending" },
    });
    expect(
      await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, issueId)),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.entityId, issueId))
      ).filter((entry) => entry.action === "issue.thread_interaction_created"),
    ).toHaveLength(1);
    await expect(
      authority.execute({
        ...call,
        callId: "ask-checkbox-conflict",
        arguments: {
          ...call.arguments,
          prompt: "Use the same key for a different prompt.",
        },
      }),
    ).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
  });

  it("writes a real revisioned document and replays the mutation receipt", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
    });
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
    const replay = await authority.execute({
      ...call,
      callId: "write-plan-replay",
    });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      disposition: "applied",
      created: true,
      document: { key: "plan", body: "Use the real document service." },
    });
    expect(
      await db
        .select()
        .from(documents)
        .where(eq(documents.companyId, companyId)),
    ).toHaveLength(1);
    const documentActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(
      documentActivity.filter(
        (entry) => entry.action === "issue.document_created",
      ),
    ).toEqual([
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
    await expect(
      authority.execute({
        ...call,
        arguments: { ...call.arguments, body: "Conflicting retry." },
      }),
    ).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
  });

  it("returns the exact accepted plan revision in task context", async () => {
    const plan = await documentService(db).getIssueDocumentByKey(
      issueId,
      "plan",
    );
    expect(plan).not.toBeNull();
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
    });
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
    await db
      .update(issueThreadInteractions)
      .set({
        status: "accepted",
        resolvedByUserId: "test-user",
        resolvedAt: new Date(),
        result: { outcome: "accepted" } as never,
      })
      .where(
        eq(
          issueThreadInteractions.id,
          (requested as { interaction: { id: string } }).interaction.id,
        ),
      );
    await db
      .update(heartbeatRuns)
      .set({
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
      })
      .where(eq(heartbeatRuns.id, runId));

    await expect(
      authority.execute({
        tool: "get_task_context",
        callId: "accepted-context",
        arguments: {},
      }),
    ).resolves.toMatchObject({
      acceptedPlan: {
        documentId: plan!.id,
        revisionId: plan!.latestRevisionId,
        revisionNumber: plan!.latestRevisionNumber,
        markdown: "Use the real document service.",
      },
    });
  });

  it("creates ordinary children, preserves blockers, and deduplicates across runs", async () => {
    const wakes: Array<{ agentId: string; options: Record<string, unknown> }> =
      [];
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
    expect(authority.definitions().map((tool) => tool.name)).toContain(
      "create_task",
    );

    const prerequisite = await authority.execute({
      tool: "create_task",
      callId: "create-prerequisite",
      arguments: {
        idempotencyKey: "ordinary-prerequisite",
        title: "Prepare delegated input",
        description:
          "A self-contained prerequisite delegated from the active task.",
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
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, prerequisiteId)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ action: "issue.created", agentId, runId, companyId })]));
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
    await expect(
      issueService(db).getRelationSummaries(issueId),
    ).resolves.toMatchObject({
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
    await expect(
      issueService(db).getRelationSummaries(issueId),
    ).resolves.toMatchObject({
      blockedBy: [expect.objectContaining({ id: prerequisiteId })],
    });

    await issueService(db).update(prerequisiteId, {
      status: "done",
      actorAgentId: agentId,
    });
    await expect(
      authority.execute({
        tool: "create_task",
        callId: "create-dependency-ready-child",
        arguments: {
          idempotencyKey: "ordinary-ready-dependent",
          title: "Start after completed delegated input",
          blockedByTaskIds: [prerequisiteId],
        },
      }),
    ).resolves.toMatchObject({
      disposition: "applied",
      task: { parentId: issueId, status: "todo", assigneeActorId: agentId },
      scheduledWakeIds: [expect.any(String)],
    });
    expect(wakes).toHaveLength(2);

    const nextRunId = "00000000-0000-4000-8000-000000000106";
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, runId));
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
    await db
      .update(issues)
      .set({ executionRunId: nextRunId })
      .where(eq(issues.id, issueId));
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
    await expect(
      retryAuthority.execute({
        tool: "create_task",
        callId: "cross-run-retry",
        arguments: {
          idempotencyKey: "ordinary-prerequisite",
          title: "Prepare delegated input",
          description:
            "A self-contained prerequisite delegated from the active task.",
        },
      }),
    ).resolves.toMatchObject({
      disposition: "duplicate",
      task: { id: prerequisiteId },
    });
    await expect(
      retryAuthority.execute({
        tool: "create_task",
        callId: "cross-run-conflicting-retry",
        arguments: {
          idempotencyKey: "ordinary-prerequisite",
          title: "Conflicting title for the same caller key",
        },
      }),
    ).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");

    const creationEvents = (await db.select().from(activityLog).where(eq(activityLog.entityId, prerequisiteId)))
      .filter(event => event.action === "issue.created");
    expect(creationEvents).toHaveLength(1);

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
    await expect(
      retryAuthority.execute({
        tool: "create_task",
        callId: "foreign-assignee",
        arguments: {
          idempotencyKey: "foreign-assignee",
          title: "Invalid foreign assignment",
          assigneeActorId: foreignAgentId,
        },
      }),
    ).rejects.toThrow("paperclip_runner_agent_not_found");
    await expect(
      retryAuthority.execute({
        tool: "create_task",
        callId: "foreign-blocker",
        arguments: {
          idempotencyKey: "foreign-blocker",
          title: "Invalid foreign blocker",
          blockedByTaskIds: [foreignIssueId],
        },
      }),
    ).rejects.toThrow();
    expect(retryWakes).toHaveLength(0);
    expect(
      await db.select().from(issues).where(eq(issues.parentId, issueId)),
    ).toHaveLength(3);
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
    await db
      .update(issues)
      .set({ executionRunId: guardedRunId })
      .where(eq(issues.id, guardedIssueId));
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId: guardedIssueId,
      runId: guardedRunId,
    });
    const mutation = {
      tool: "report_progress",
      callId: "guarded-progress",
      arguments: {
        body: "Must remain authorized",
        idempotencyKey: "guarded-progress",
      },
    };

    await db
      .update(issues)
      .set({ assigneeAgentId: null })
      .where(eq(issues.id, guardedIssueId));
    await expect(authority.execute(mutation)).rejects.toThrow(
      "paperclip_runner_tool_binding_not_authorized",
    );

    await db
      .update(issues)
      .set({
        assigneeAgentId: agentId,
        executionRunId: guardedReplacementRunId,
      })
      .where(eq(issues.id, guardedIssueId));
    await expect(
      authority.execute({ ...mutation, callId: "replaced-run" }),
    ).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");

    await db
      .update(issues)
      .set({ executionRunId: guardedRunId })
      .where(eq(issues.id, guardedIssueId));
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, guardedRunId));
    await expect(
      authority.execute({ ...mutation, callId: "terminal-run" }),
    ).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");

    expect(
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, guardedIssueId)),
    ).toHaveLength(0);
  });

  it("captures delegation and approval origins before steering and preserves replay identity", async () => {
    const issueId = "00000000-0000-4000-8000-000000000120";
    const runId = "00000000-0000-4000-8000-000000000121";
    await db.insert(issues).values({ id: issueId, companyId, title: "Identity delegation",
      status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      status: "running", runtimeMode: "native", nativeIssueId: issueId,
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const origin = await initializeRunIdentity(db, {
      companyId, runId, issueId, responsibleUserId: "person-a", cause: "instruction",
    });
    const [message] = await db.insert(issueComments).values({
      companyId, issueId, body: "New instruction", authorUserId: "person-b",
    }).returning();
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    const call = { tool: "create_task", callId: "identity-child", arguments: {
      idempotencyKey: "identity-child", title: "Keep the initiating identity",
      responsibleUserId: "forged-user", originIdentityContextId: "forged-context",
    } };
    const first = await authority.execute(call) as { task: { id: string } };
    const pending = await reserveSteeredIdentity(db, { companyId, runId, issueId, messageId: message.id });
    await reconcileSteeredIdentity(db, pending!);
    await expect(authority.execute({ ...call, callId: "identity-child-replay" })).resolves.toEqual(first);
    const [child] = await db.select().from(issues).where(eq(issues.id, first.task.id));
    expect(child).toMatchObject({ originRunId: runId, originIdentityContextId: origin.id,
      continuationIdentityContextId: origin.id });
    const second = await authority.execute({ ...call, callId: "identity-child-b", arguments: {
      idempotencyKey: "identity-child-b", title: "Use the next instruction identity",
    } }) as { task: { id: string } };
    const [nextChild] = await db.select().from(issues).where(eq(issues.id, second.task.id));
    expect(nextChild.originIdentityContextId).toBe(pending!.id);
    await authority.execute({ tool: "request_human_input", callId: "identity-approval", arguments: {
      idempotencyKey: "identity-approval", interactionKind: "confirmation", title: "Approve continuation",
      prompt: "Continue?", continuationPolicy: "wake_assignee", payload: {},
    } });
    const interactions = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(interactions.find((row) => row.title === "Approve continuation")?.sourceIdentityContextId).toBe(pending!.id);
  });

  it("fails closed once the run is no longer active", async () => {
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, runId));
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
    });
    await expect(
      authority.execute({
        tool: "get_task_context",
        callId: "late",
        arguments: {},
      }),
    ).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
  });
});
