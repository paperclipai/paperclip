import { describe, it, expect, vi } from "vitest";
import { createToolDefinitions } from "./tools.js";
import { runWithBearer } from "./auth-context.js";
import { PaperclipApiError } from "./client.js";

function clientReturning(body: unknown) {
  return { requestJson: vi.fn(async () => body) } as any;
}

// NOTE: these tests call tool.execute(args) directly, bypassing the MCP SDK's
// Zod parse. So an absent optional arrives as `undefined`, not its schema
// default (e.g. company_id default "") — resolveCompany handles both identically
// (see client.test.ts resolveCompany suite). Assertions reflect the direct-call path.
function okClient(body: unknown = { ok: "data" }) {
  return {
    requestJson: vi.fn(async () => body),
    resolveCompany: vi.fn(async (i: { override?: string | null } = {}) => i.override?.trim() || "co-default"),
  } as any;
}
function tool(client: any, name: string) {
  return createToolDefinitions(client).find((t) => t.name === name)!;
}

describe("get_agent tool", () => {
  it("is registered as snake_case get_agent", () => {
    const tools = createToolDefinitions(clientReturning({}));
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_agent");
  });

  it("defaults agent_id to 'me' → GET /agents/me", async () => {
    const client = clientReturning({ id: "agent-me" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    const res = await runWithBearer("Bearer X", () => tool.execute({ agent_id: "me" }, {} as any));
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/me");
    expect(res.content[0].text).toContain("agent-me");
  });

  it("routes a concrete id to /agents/<id>", async () => {
    const client = clientReturning({ id: "abc" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await tool.execute({ agent_id: "abc" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/abc");
  });

  it("treats empty/whitespace agent_id as 'me'", async () => {
    const client = clientReturning({ id: "x" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await tool.execute({ agent_id: "   " }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/me");
  });

  it("URL-encodes a non-'me' agent_id path segment", async () => {
    const client = clientReturning({ id: "x" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await tool.execute({ agent_id: "a/b c" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/a%2Fb%20c");
  });
});

describe("runTool (via get_agent)", () => {
  it("maps an empty/null API result to { ok: true }", async () => {
    const client = { requestJson: vi.fn(async () => null) } as any;
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    const res = await tool.execute({ agent_id: "me" }, {} as any);
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
  });

  it("maps a 409 to Python's do-not-retry payload", async () => {
    const client = {
      requestJson: vi.fn(async () => {
        throw new PaperclipApiError({ status: 409, method: "GET", path: "/agents/me", body: null, message: "x" });
      }),
    } as any;
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    const res = await tool.execute({ agent_id: "me" }, {} as any);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.isError).toBe(true);
    expect(payload.status).toBe(409);
    expect(payload.message).toMatch(/Do not retry/i);
  });

  it("maps a non-409 API error to { isError, status, message }", async () => {
    const client = {
      requestJson: vi.fn(async () => {
        throw new PaperclipApiError({ status: 403, method: "GET", path: "/agents/me", body: "forbidden", message: "x" });
      }),
    } as any;
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    const res = await tool.execute({ agent_id: "me" }, {} as any);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.isError).toBe(true);
    expect(payload.status).toBe(403);
    expect(payload.message).toMatch(/HTTP 403 from Paperclip API/);
    expect(payload.message).toMatch(/forbidden/);
  });

  it("re-throws non-PaperclipApiError errors", async () => {
    const client = {
      requestJson: vi.fn(async () => {
        throw new Error("company not found");
      }),
    } as any;
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await expect(tool.execute({ agent_id: "me" }, {} as any)).rejects.toThrow("company not found");
  });

  it("serializes a non-string (object) API error body into the message", async () => {
    const client = {
      requestJson: vi.fn(async () => {
        throw new PaperclipApiError({ status: 422, method: "GET", path: "/issues/X-1", body: { error: "nope" }, message: "x" });
      }),
    } as any;
    const tool0 = createToolDefinitions(client).find((t) => t.name === "get_issue")!;
    const res = await tool0.execute({ issue_id: "X-1" }, {} as any);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.status).toBe(422);
    expect(payload.message).toContain('{"error":"nope"}');
  });

  it("truncates a long API error body to 400 chars", async () => {
    const client = {
      requestJson: vi.fn(async () => {
        throw new PaperclipApiError({ status: 500, method: "GET", path: "/issues/X-1", body: "z".repeat(500), message: "x" });
      }),
    } as any;
    const tool0 = createToolDefinitions(client).find((t) => t.name === "get_issue")!;
    const res = await tool0.execute({ issue_id: "X-1" }, {} as any);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.message).toBe(`HTTP 500 from Paperclip API: ${"z".repeat(400)}`);
  });
});

describe("list_issues", () => {
  it("GETs the company issues path with default status/limit and resolved company", async () => {
    const client = okClient([]);
    await tool(client, "list_issues").execute({}, {} as any);
    expect(client.resolveCompany).toHaveBeenCalledWith({ override: undefined });
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/issues", {
      query: { status: "todo,in_progress", limit: 50 },
      companyId: "co-default",
    });
  });

  it("passes filters and clamps limit to 200", async () => {
    const client = okClient([]);
    await tool(client, "list_issues").execute(
      { status: "done", assignee_agent_id: "ag-1", project_id: "pr-1", label: "bug", q: "crash", limit: 9999, company_id: "PEN" },
      {} as any,
    );
    expect(client.resolveCompany).toHaveBeenCalledWith({ override: "PEN" });
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/PEN/issues", {
      query: { status: "done", limit: 200, assigneeAgentId: "ag-1", projectId: "pr-1", label: "bug", q: "crash" },
      companyId: "PEN",
    });
  });

  it("clamps limit to a floor of 1, truncates floats, and falls back to 50 on non-finite", async () => {
    const c0 = okClient([]);
    await tool(c0, "list_issues").execute({ limit: 0 }, {} as any);
    expect(c0.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/issues", {
      query: { status: "todo,in_progress", limit: 1 },
      companyId: "co-default",
    });
    const cf = okClient([]);
    await tool(cf, "list_issues").execute({ limit: 7.9 }, {} as any);
    expect(cf.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/issues", {
      query: { status: "todo,in_progress", limit: 7 },
      companyId: "co-default",
    });
    const cn = okClient([]);
    await tool(cn, "list_issues").execute({ limit: Number.NaN }, {} as any);
    expect(cn.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/issues", {
      query: { status: "todo,in_progress", limit: 50 },
      companyId: "co-default",
    });
  });
});

describe("get_issue", () => {
  it("GETs /issues/<id> with no company scoping", async () => {
    const client = okClient({ id: "PEN-1" });
    await tool(client, "get_issue").execute({ issue_id: "PEN-1" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/issues/PEN-1");
    expect(client.resolveCompany).not.toHaveBeenCalled();
  });
});

describe("paperclip_search_issues", () => {
  it("is registered and forwards query as q to the issues path", async () => {
    const client = okClient([]);
    await tool(client, "paperclip_search_issues").execute({ query: "crash", limit: 10 }, {} as any);
    expect(client.resolveCompany).toHaveBeenCalledWith({ override: undefined });
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/issues", {
      query: { status: "todo,in_progress", limit: 10, q: "crash" },
      companyId: "co-default",
    });
  });
});

describe("create_issue", () => {
  it("POSTs to the company issues path with camelCase body + blocked_by_issue_ids", async () => {
    const client = okClient({ id: "PEN-2" });
    await tool(client, "create_issue").execute(
      {
        title: "Do thing",
        description: "details",
        assignee_agent_id: "ag-1",
        project_id: "pr-1",
        parent_issue_id: "PEN-1",
        priority: "high",
        company_id: "PEN",
        blocked_by_issue_ids: ["PEN-9"],
      },
      {} as any,
    );
    expect(client.resolveCompany).toHaveBeenCalledWith({ override: "PEN" });
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/companies/PEN/issues", {
      body: {
        title: "Do thing",
        priority: "high",
        description: "details",
        assigneeAgentId: "ag-1",
        projectId: "pr-1",
        parentIssueId: "PEN-1",
        blockedByIssueIds: ["PEN-9"],
      },
      companyId: "PEN",
    });
  });

  it("defaults priority to medium and omits empty optionals", async () => {
    const client = okClient({ id: "PEN-3" });
    await tool(client, "create_issue").execute({ title: "Bare" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/companies/co-default/issues", {
      body: { title: "Bare", priority: "medium" },
      companyId: "co-default",
    });
  });

  it("sends blockedByIssueIds: [] when blocked_by_issue_ids is []", async () => {
    const client = okClient({ id: "PEN-4" });
    await tool(client, "create_issue").execute({ title: "T", blocked_by_issue_ids: [] }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/companies/co-default/issues", {
      body: { title: "T", priority: "medium", blockedByIssueIds: [] },
      companyId: "co-default",
    });
  });
});

describe("update_issue", () => {
  it("PATCHes /issues/<id> with only provided fields (camelCase)", async () => {
    const client = okClient({ id: "PEN-1" });
    await tool(client, "update_issue").execute(
      { issue_id: "PEN-1", title: "New", status: "in_progress", blocked_by_issue_ids: [] },
      {} as any,
    );
    expect(client.requestJson).toHaveBeenCalledWith("PATCH", "/issues/PEN-1", {
      body: { title: "New", status: "in_progress", blockedByIssueIds: [] },
      companyId: null,
    });
  });

  it("clears the project when project_id is an empty string (projectId: null)", async () => {
    const client = okClient({ id: "PEN-1" });
    await tool(client, "update_issue").execute({ issue_id: "PEN-1", project_id: "" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("PATCH", "/issues/PEN-1", {
      body: { projectId: null },
      companyId: null,
    });
  });

  it("resolves an explicit company_id override to the header", async () => {
    const client = okClient({ id: "PEN-1" });
    await tool(client, "update_issue").execute({ issue_id: "PEN-1", title: "x", company_id: "PEN" }, {} as any);
    expect(client.resolveCompany).toHaveBeenCalledWith({ override: "PEN" });
    expect(client.requestJson).toHaveBeenCalledWith("PATCH", "/issues/PEN-1", {
      body: { title: "x" },
      companyId: "PEN",
    });
  });

  it("returns { isError } for an invalid status without calling the API", async () => {
    const client = okClient();
    const res = await tool(client, "update_issue").execute({ issue_id: "PEN-1", status: "bogus" }, {} as any);
    expect(JSON.parse(res.content[0].text).isError).toBe(true);
    expect(client.requestJson).not.toHaveBeenCalled();
  });

  it("returns { isError } for an invalid priority without calling the API", async () => {
    const client = okClient();
    const res = await tool(client, "update_issue").execute({ issue_id: "PEN-1", priority: "bogus" }, {} as any);
    expect(JSON.parse(res.content[0].text).isError).toBe(true);
    expect(client.requestJson).not.toHaveBeenCalled();
  });

  it("returns { isError } when no fields are provided", async () => {
    const client = okClient();
    const res = await tool(client, "update_issue").execute({ issue_id: "PEN-1" }, {} as any);
    expect(JSON.parse(res.content[0].text).message).toMatch(/No fields to update/);
    expect(client.requestJson).not.toHaveBeenCalled();
  });
});

describe("issue lifecycle", () => {
  it("checkout_issue POSTs /issues/<id>/checkout", async () => {
    const client = okClient(null);
    const res = await tool(client, "checkout_issue").execute({ issue_id: "PEN-1" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/issues/PEN-1/checkout");
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
    expect(client.resolveCompany).not.toHaveBeenCalled();
  });

  it("release_issue POSTs /issues/<id>/release", async () => {
    const client = okClient(null);
    const res = await tool(client, "release_issue").execute({ issue_id: "PEN-1" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/issues/PEN-1/release");
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
    expect(client.resolveCompany).not.toHaveBeenCalled();
  });

  it("delete_issue DELETEs /issues/<id>", async () => {
    const client = okClient(null);
    const res = await tool(client, "delete_issue").execute({ issue_id: "PEN-1" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("DELETE", "/issues/PEN-1");
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
    expect(client.resolveCompany).not.toHaveBeenCalled();
  });

  it("comment_on_issue POSTs the body, omitting reopen when false", async () => {
    const client = okClient({ id: "c-1" });
    await tool(client, "comment_on_issue").execute({ issue_id: "PEN-1", body: "hi" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/issues/PEN-1/comments", { body: { body: "hi" } });
    expect(client.resolveCompany).not.toHaveBeenCalled();
  });

  it("comment_on_issue includes reopen when true", async () => {
    const client = okClient({ id: "c-1" });
    await tool(client, "comment_on_issue").execute({ issue_id: "PEN-1", body: "hi", reopen: true }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/issues/PEN-1/comments", { body: { body: "hi", reopen: true } });
    expect(client.resolveCompany).not.toHaveBeenCalled();
  });
});

describe("projects", () => {
  it("list_projects GETs the company projects path", async () => {
    const client = okClient([]);
    await tool(client, "list_projects").execute({}, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/projects", { companyId: "co-default" });
  });

  it("get_project GETs /projects/<id> with companyId query + header", async () => {
    const client = okClient({ id: "pr-1" });
    await tool(client, "get_project").execute({ project_id: "pr-1" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/projects/pr-1", {
      query: { companyId: "co-default" },
      companyId: "co-default",
    });
  });

  it("create_project POSTs camelCase body with status default backlog", async () => {
    const client = okClient({ id: "pr-2" });
    await tool(client, "create_project").execute(
      { name: "P", description: "d", goal_ids: ["g-1"], lead_agent_id: "ag-1", target_date: "2026-09-01", color: "#fff" },
      {} as any,
    );
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/companies/co-default/projects", {
      body: { name: "P", status: "backlog", description: "d", goalIds: ["g-1"], leadAgentId: "ag-1", targetDate: "2026-09-01", color: "#fff" },
      companyId: "co-default",
    });
  });

  it("create_project rejects an invalid status", async () => {
    const client = okClient();
    const res = await tool(client, "create_project").execute({ name: "P", status: "bogus" }, {} as any);
    expect(JSON.parse(res.content[0].text).isError).toBe(true);
    expect(client.requestJson).not.toHaveBeenCalled();
  });

  it("update_project clears a field with empty string (null) and keeps omitted", async () => {
    const client = okClient({ id: "pr-1" });
    await tool(client, "update_project").execute({ project_id: "pr-1", description: "", name: "New" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("PATCH", "/projects/pr-1", {
      body: { name: "New", description: null },
      companyId: "co-default",
    });
  });

  it("update_project errors when no fields provided", async () => {
    const client = okClient();
    const res = await tool(client, "update_project").execute({ project_id: "pr-1" }, {} as any);
    expect(JSON.parse(res.content[0].text).message).toMatch(/No fields to update/);
    expect(client.requestJson).not.toHaveBeenCalled();
  });

  it("update_project resolves an explicit company_id override", async () => {
    const client = okClient({ id: "pr-1" });
    await tool(client, "update_project").execute({ project_id: "pr-1", name: "X", company_id: "PEN" }, {} as any);
    expect(client.resolveCompany).toHaveBeenCalledWith({ override: "PEN" });
    expect(client.requestJson).toHaveBeenCalledWith("PATCH", "/projects/pr-1", {
      body: { name: "X" },
      companyId: "PEN",
    });
  });

  it("create_project includes deprecated goalId when goal_id is set", async () => {
    const client = okClient({ id: "pr-3" });
    await tool(client, "create_project").execute({ name: "P", goal_id: "g-legacy" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/companies/co-default/projects", {
      body: { name: "P", status: "backlog", goalId: "g-legacy" },
      companyId: "co-default",
    });
  });

  it("create_project defaults an empty status to backlog (not an error)", async () => {
    const client = okClient({ id: "pr-9" });
    await tool(client, "create_project").execute({ name: "P", status: "" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/companies/co-default/projects", {
      body: { name: "P", status: "backlog" },
      companyId: "co-default",
    });
  });
});

describe("goals", () => {
  it("list_goals GETs the company goals path", async () => {
    const client = okClient([]);
    await tool(client, "list_goals").execute({}, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/goals", { companyId: "co-default" });
  });

  it("create_goal POSTs title (+ optional description)", async () => {
    const client = okClient({ id: "g-1" });
    await tool(client, "create_goal").execute({ title: "Grow", description: "why" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/companies/co-default/goals", {
      body: { title: "Grow", description: "why" },
      companyId: "co-default",
    });
  });

  it("create_goal omits description when empty", async () => {
    const client = okClient({ id: "g-2" });
    await tool(client, "create_goal").execute({ title: "Solo" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/companies/co-default/goals", {
      body: { title: "Solo" },
      companyId: "co-default",
    });
  });

  it("update_goal PATCHes /goals/<id> with provided fields, no company scoping", async () => {
    const client = okClient({ id: "g-1" });
    await tool(client, "update_goal").execute({ goal_id: "g-1", title: "New" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("PATCH", "/goals/g-1", { body: { title: "New" } });
    expect(client.resolveCompany).not.toHaveBeenCalled();
  });

  it("update_goal errors when no fields provided", async () => {
    const client = okClient();
    const res = await tool(client, "update_goal").execute({ goal_id: "g-1" }, {} as any);
    expect(JSON.parse(res.content[0].text).message).toMatch(/No fields to update/);
    expect(client.requestJson).not.toHaveBeenCalled();
  });

  it("update_goal sends description alone", async () => {
    const client = okClient({ id: "g-1" });
    await tool(client, "update_goal").execute({ goal_id: "g-1", description: "new desc" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("PATCH", "/goals/g-1", { body: { description: "new desc" } });
  });
});

describe("agents (wave 2)", () => {
  it("list_agents GETs the company agents path", async () => {
    const client = okClient([]);
    await tool(client, "list_agents").execute({}, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/agents", { companyId: "co-default" });
  });

  it("invoke_agent_heartbeat POSTs /agents/<id>/heartbeat/invoke with no body and no company", async () => {
    const client = okClient(null);
    const res = await tool(client, "invoke_agent_heartbeat").execute({ agent_id: "ag-1" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("POST", "/agents/ag-1/heartbeat/invoke");
    expect(client.resolveCompany).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
  });
});

describe("approvals (wave 2)", () => {
  it("list_approvals GETs company approvals with default status pending", async () => {
    const client = okClient([]);
    await tool(client, "list_approvals").execute({}, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/approvals", {
      query: { status: "pending" },
      companyId: "co-default",
    });
  });

  it("list_approvals forwards a valid status filter", async () => {
    const client = okClient([]);
    await tool(client, "list_approvals").execute({ status: "approved", company_id: "PEN" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/PEN/approvals", {
      query: { status: "approved" },
      companyId: "PEN",
    });
  });

  it("list_approvals errors on an invalid status (incl. empty string) without calling the API", async () => {
    const c1 = okClient();
    const r1 = await tool(c1, "list_approvals").execute({ status: "bogus" }, {} as any);
    expect(JSON.parse(r1.content[0].text).isError).toBe(true);
    expect(c1.requestJson).not.toHaveBeenCalled();
    const c2 = okClient();
    const r2 = await tool(c2, "list_approvals").execute({ status: "" }, {} as any);
    expect(JSON.parse(r2.content[0].text).isError).toBe(true);
    expect(c2.requestJson).not.toHaveBeenCalled();
  });

  it("approve POSTs an empty body object when no comment, and includes comment when given", async () => {
    const c1 = okClient(null);
    await tool(c1, "approve").execute({ approval_id: "ap-1" }, {} as any);
    expect(c1.requestJson).toHaveBeenCalledWith("POST", "/approvals/ap-1/approve", { body: {} });
    const c2 = okClient(null);
    await tool(c2, "approve").execute({ approval_id: "ap-1", comment: "ok by me" }, {} as any);
    expect(c2.requestJson).toHaveBeenCalledWith("POST", "/approvals/ap-1/approve", { body: { comment: "ok by me" } });
  });

  it("reject POSTs the comment (empty body object when none)", async () => {
    const c1 = okClient(null);
    await tool(c1, "reject").execute({ approval_id: "ap-1", comment: "nope" }, {} as any);
    expect(c1.requestJson).toHaveBeenCalledWith("POST", "/approvals/ap-1/reject", { body: { comment: "nope" } });
    const c2 = okClient(null);
    await tool(c2, "reject").execute({ approval_id: "ap-1" }, {} as any);
    expect(c2.requestJson).toHaveBeenCalledWith("POST", "/approvals/ap-1/reject", { body: {} });
  });

  it("request_approval_revision requires a non-blank comment", async () => {
    const c1 = okClient();
    const r1 = await tool(c1, "request_approval_revision").execute({ approval_id: "ap-1", comment: "   " }, {} as any);
    expect(JSON.parse(r1.content[0].text).message).toMatch(/comment is required/i);
    expect(c1.requestJson).not.toHaveBeenCalled();
    const c2 = okClient(null);
    await tool(c2, "request_approval_revision").execute({ approval_id: "ap-1", comment: "please fix X" }, {} as any);
    expect(c2.requestJson).toHaveBeenCalledWith("POST", "/approvals/ap-1/request-revision", { body: { comment: "please fix X" } });
  });
});

describe("monitoring (wave 2)", () => {
  it("get_dashboard GETs the company dashboard path", async () => {
    const client = okClient({ ok: true });
    await tool(client, "get_dashboard").execute({}, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/dashboard", { companyId: "co-default" });
  });

  it("get_cost_summary GETs the company costs/summary path", async () => {
    const client = okClient({ ok: true });
    await tool(client, "get_cost_summary").execute({ company_id: "PEN" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/PEN/costs/summary", { companyId: "PEN" });
  });

  it("list_activity GETs company activity with default limit 20", async () => {
    const client = okClient([]);
    await tool(client, "list_activity").execute({}, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/activity", {
      query: { limit: 20 },
      companyId: "co-default",
    });
  });

  it("list_activity clamps limit to 100 and adds agentId filter", async () => {
    const client = okClient([]);
    await tool(client, "list_activity").execute({ limit: 9999, agent_id: "ag-1" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/activity", {
      query: { limit: 100, agentId: "ag-1" },
      companyId: "co-default",
    });
  });
});
