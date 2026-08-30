import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PaperclipApiClient } from "./client.js";
import { createPaperclipMcpServer } from "./index.js";
import { createToolDefinitions } from "./tools.js";

function makeConfig() {
  return {
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  };
}

function makeClient() {
  return new PaperclipApiClient(makeConfig());
}

function getTool(name: string) {
  const tool = createToolDefinitions(makeClient()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("paperclip MCP tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every tool through the MCP protocol", async () => {
    const { server, tools } = createPaperclipMcpServer(makeConfig());
    const client = new Client({ name: "paperclip-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
      const createIssueSchema = listed.tools.find((tool) => tool.name === "paperclipCreateIssue")
        ?.inputSchema as { properties?: Record<string, { anyOf?: unknown[] }> } | undefined;
      for (const field of ["neededAt", "reviewBy"]) {
        expect(createIssueSchema?.properties?.[field]?.anyOf).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "string", format: "date-time" }),
          expect.objectContaining({ type: "null" }),
        ]));
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("adds auth headers and run id to mutating requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpdateIssue");
    await tool.execute({
      issueId: "PAP-1135",
      status: "done",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
    expect((init.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("lists the company skill library with the default company id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([{ key: "paperclipai/bundled/product/wireframe", name: "wireframe" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipListSkills");
    const response = await tool.execute({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/skills",
    );
    expect(response.content[0]?.text).toContain("wireframe");
  });

  it("uses default company id for company-scoped list tools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([{ id: "issue-1" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipListIssues");
    const response = await tool.execute({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(response.content[0]?.text).toContain("issue-1");
  });

  it("uses default agent id for checkout requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "PAP-1135", status: "in_progress" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCheckoutIssue");
    await tool.execute({
      issueId: "PAP-1135",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      agentId: "22222222-2222-2222-2222-222222222222",
      expectedStatuses: ["todo", "backlog", "blocked"],
    });
  });

  it("allows create issue requests to omit status so the API applies assignee defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "issue-1", status: "todo" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateIssue");
    await tool.execute({
      title: "Assigned follow-up",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      allowDuplicate: false,
      title: "Assigned follow-up",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
      requestDepth: 0,
    });
  });

  it("defaults issue document format to markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ key: "plan", latestRevisionNumber: 2 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpsertIssueDocument");
    await tool.execute({
      issueId: "PAP-1135",
      key: "plan",
      body: "# Updated",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      format: "markdown",
      body: "# Updated",
    });
  });

  it("controls issue workspace services through the current execution workspace", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [],
        },
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        operation: { id: "operation-1" },
        workspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipControlIssueWorkspaceServices");
    await tool.execute({
      issueId: "PAP-1135",
      action: "restart",
      workspaceCommandId: "web",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(lookupUrl)).toBe("http://localhost:3100/api/issues/PAP-1135/heartbeat-context");
    expect(lookupInit.method).toBe("GET");

    const [controlUrl, controlInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(controlUrl)).toBe(
      "http://localhost:3100/api/execution-workspaces/44444444-4444-4444-8444-444444444444/runtime-services/restart",
    );
    expect(controlInit.method).toBe("POST");
    expect(JSON.parse(String(controlInit.body))).toEqual({
      workspaceCommandId: "web",
    });
  });

  it("waits for an issue workspace runtime service URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              healthStatus: "healthy",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipWaitForIssueWorkspaceService");
    const response = await tool.execute({
      issueId: "PAP-1135",
      serviceName: "web",
      timeoutSeconds: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.content[0]?.text).toContain("http://127.0.0.1:5173");
  });

  it("creates suggest_tasks interactions with the expected issue-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "suggest_tasks" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipSuggestTasks");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });
  });

  it("proposes a day plan without starting its tasks", async () => {
    const planIssueId = "44444444-4444-4444-8444-444444444444";
    const interactionId = "55555555-5555-4555-8555-555555555555";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({ id: planIssueId, title: "Plan for 2026-08-29" }))
      .mockResolvedValueOnce(mockJsonResponse({ id: interactionId, kind: "suggest_tasks", status: "pending" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipProposeDayPlan");
    await tool.execute({
      date: "2026-08-29",
      summary: "Prepare for the launch review.",
      tasks: [{
        clientKey: "launch-brief",
        title: "Prepare launch brief",
        reviewBy: "2026-08-29T14:30:00-04:00",
        neededAt: "2026-08-29T15:00:00-04:00",
        estimatedReviewMinutes: 15,
      }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(createInit.body))).toMatchObject({
      title: "Plan for 2026-08-29",
      status: "todo",
      workMode: "planning",
      idempotencyKey: "delegate-day-plan:2026-08-29",
    });
    const [interactionUrl, interactionInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(interactionUrl)).toBe(`http://localhost:3100/api/issues/${planIssueId}/interactions`);
    expect(JSON.parse(String(interactionInit.body))).toMatchObject({
      kind: "suggest_tasks",
      continuationPolicy: "none",
      resolverPolicy: "human_only",
      payload: {
        version: 1,
        defaultParentId: planIssueId,
        tasks: [{
          clientKey: "launch-brief",
          title: "Prepare launch brief",
          assigneeAgentId: "22222222-2222-2222-2222-222222222222",
          estimatedReviewMinutes: 15,
        }],
      },
    });
  });

  it("accepts or requests changes through the human review tool", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "issue-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("paperclipReviewTask");

    await tool.execute({ issueId: "PAP-12", verdict: "accept" });
    await tool.execute({ issueId: "PAP-13", verdict: "request_changes", comment: "Add churn risk." });

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ status: "done" });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      status: "todo",
      comment: "Add churn risk.",
      resume: true,
    });
  });

  it("requires feedback when requesting changes", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const response = await getTool("paperclipReviewTask").execute({
      issueId: "PAP-13",
      verdict: "request_changes",
    });
    expect(response.content[0]?.text).toContain("Requesting changes requires a comment");
  });

  it("creates request_confirmation interactions with plan target payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "request_confirmation" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipRequestConfirmation");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "request_confirmation",
      continuationPolicy: "none",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });
  });

  it("creates request_checkbox_confirmation interactions with checkbox payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "request_checkbox_confirmation" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipRequestCheckboxConfirmation");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "confirmation:PAP-1135:files",
      title: "Choose files",
      payload: {
        version: 1,
        prompt: "Which files should be included?",
        detailsMarkdown: "Pick the files to attach.",
        options: [
          { id: "file-a", label: "File A", description: "Primary draft" },
          { id: "file-b", label: "File B" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 1,
        maxSelected: 2,
        acceptLabel: "Use selected files",
        rejectLabel: "Do not attach files",
        rejectRequiresReason: true,
        allowDeclineReason: false,
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "request_checkbox_confirmation",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "confirmation:PAP-1135:files",
      title: "Choose files",
      payload: {
        version: 1,
        prompt: "Which files should be included?",
        detailsMarkdown: "Pick the files to attach.",
        options: [
          { id: "file-a", label: "File A", description: "Primary draft" },
          { id: "file-b", label: "File B" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 1,
        maxSelected: 2,
        acceptLabel: "Use selected files",
        rejectLabel: "Do not attach files",
        rejectRequiresReason: true,
        allowDeclineReason: false,
      },
    });
  });

  it("creates approvals with the expected company-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "approval-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateApproval");
    await tool.execute({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/approvals",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });
  });

  it("rejects invalid generic request paths", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("paperclipApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "issues",
    });

    expect(response.content[0]?.text).toContain("path must start with /");
  });

  it("rejects generic request paths that escape /api", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("paperclipApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "/../../secret",
    });

    expect(response.content[0]?.text).toContain("must not contain '..'");
  });
});
