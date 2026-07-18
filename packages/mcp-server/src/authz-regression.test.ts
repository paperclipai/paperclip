/**
 * Authz regression tests for mcp-server tools (NEO-295, NEO-283 plan rev 1 §A.3).
 *
 * Acceptance criteria — tenant isolation:
 *   1. A company-A token cannot list/mutate company-B issues/approvals/
 *      documents. Two enforcement boundaries are exercised:
 *        (a) Company-scoped tools that accept an explicit `companyId` reject a
 *            cross-tenant target at the MCP layer BEFORE any REST call is made
 *            (defense in depth in front of the route's assertCompanyAccess).
 *        (b) Issue/approval/document-keyed tools carry no company segment, so
 *            the MCP layer forwards them with the bound (company-A) credential
 *            and delegates the company check to REST. These tests prove the MCP
 *            layer faithfully surfaces REST's 403 denial (never masks it as a
 *            success and never widens the presented credential).
 *   2. A viewer role cannot decide approvals. Role enforcement lives in REST;
 *      here we prove every approval-decision action routes to its guarded REST
 *      endpoint and the resulting 403 is surfaced to the caller unmodified.
 *   3. List endpoints never leak cross-tenant rows. Every company-scoped list
 *      tool is pinned to the bound company's path segment and cannot be widened
 *      to another tenant or an unscoped collection; REST's own row scoping
 *      therefore governs, and the MCP layer passes rows through verbatim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions } from "./tools.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "99999999-9999-9999-9999-999999999999";
const AGENT_A = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "33333333-3333-3333-3333-333333333333";
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const API = "http://localhost:3100/api";
const TOKEN = "token-A";

/** A client whose credential is pinned to company A (the tenant boundary). */
function boundToCompanyA() {
  return new PaperclipApiClient({
    apiUrl: API,
    apiKey: TOKEN,
    companyId: COMPANY_A,
    agentId: AGENT_A,
    runId: RUN_ID,
  });
}

function getTool(name: string, client = boundToCompanyA()) {
  const tool = createToolDefinitions(client).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Parse the single text block a tool returns back into structured JSON. */
function parseToolJson(response: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AC1a: cross-tenant company-scoped calls are blocked at the MCP layer", () => {
  // Every tool that resolves/asserts a company from an explicit `companyId`.
  // A company-A credential naming company B must be refused before REST.
  const CROSS_TENANT_CALLS: Array<{ tool: string; input: Record<string, unknown> }> = [
    { tool: "paperclipListIssues", input: { companyId: COMPANY_B } },
    { tool: "paperclipListApprovals", input: { companyId: COMPANY_B } },
    { tool: "paperclipListProjects", input: { companyId: COMPANY_B } },
    { tool: "paperclipListGoals", input: { companyId: COMPANY_B } },
    { tool: "paperclipListAgents", input: { companyId: COMPANY_B } },
    { tool: "paperclipGetAgent", input: { agentId: AGENT_A, companyId: COMPANY_B } },
    { tool: "paperclipGetProject", input: { projectId: "PROJ-1", companyId: COMPANY_B } },
    { tool: "paperclipCreateIssue", input: { companyId: COMPANY_B, title: "cross-tenant" } },
    {
      tool: "paperclipCreateApproval",
      input: { companyId: COMPANY_B, type: "hire_agent", payload: {} },
    },
  ];

  it.each(CROSS_TENANT_CALLS)(
    "$tool refuses company B without issuing a REST request",
    async ({ tool, input }) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await getTool(tool).execute(input);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.content[0]?.text).toContain("cannot access company");
      expect(response.content[0]?.text).toContain(COMPANY_B);
    },
  );
});

describe("AC1a: the generic escape hatch cannot reach another tenant's scope", () => {
  const CROSS_TENANT_PATHS: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; path: string }> = [
    { method: "GET", path: `/companies/${COMPANY_B}/issues` },
    { method: "POST", path: `/companies/${COMPANY_B}/approvals` },
    { method: "PATCH", path: `/companies/${COMPANY_B}/agents/${AGENT_A}` },
    { method: "DELETE", path: `/companies/${COMPANY_B}/projects/PROJ-1` },
  ];

  it.each(CROSS_TENANT_PATHS)(
    "paperclipApiRequest blocks $method $path before any fetch",
    async ({ method, path }) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await getTool("paperclipApiRequest").execute({ method, path });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.content[0]?.text).toContain("cannot access company");
    },
  );

  it("still allows the escape hatch into the bound company's own scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: "issue-a" }]));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipApiRequest").execute({
      method: "GET",
      path: `/companies/${COMPANY_A}/issues`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(`${API}/companies/${COMPANY_A}/issues`);
  });
});

describe("AC1b: issue/approval-keyed mutations delegate to REST and surface its 403", () => {
  // These tools carry no company segment, so the MCP layer cannot know the
  // target's tenant; it forwards with the bound credential and REST decides.
  // A cross-tenant target yields a 403 that must reach the caller intact.
  const DELEGATED_MUTATIONS: Array<{ tool: string; input: Record<string, unknown> }> = [
    { tool: "paperclipUpdateIssue", input: { issueId: "PAP-9", status: "done" } },
    { tool: "paperclipAddComment", input: { issueId: "PAP-9", body: "cross-tenant" } },
    {
      tool: "paperclipUpsertIssueDocument",
      input: { issueId: "PAP-9", key: "plan", body: "cross-tenant" },
    },
    { tool: "paperclipLinkIssueApproval", input: { issueId: "PAP-9", approvalId: APPROVAL_ID } },
    { tool: "paperclipApprovalDecision", input: { approvalId: APPROVAL_ID, action: "approve" } },
  ];

  it.each(DELEGATED_MUTATIONS)(
    "$tool surfaces REST's 403 and presents only the bound company-A credential",
    async ({ tool, input }) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: "Forbidden: cross-company access" }, 403));
      vi.stubGlobal("fetch", fetchMock);

      const response = await getTool(tool).execute(input);
      const parsed = parseToolJson(response);

      expect(parsed.status).toBe(403);
      expect(String(parsed.error)).toContain("Forbidden");

      // The MCP layer must forward the caller's own (company-A) credential —
      // never a widened or substituted one — leaving REST as the arbiter.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
    },
  );
});

describe("AC2: a viewer role cannot decide approvals — REST 403 is propagated per action", () => {
  const DECISION_ROUTES: Array<{ action: string; path: string }> = [
    { action: "approve", path: `/approvals/${APPROVAL_ID}/approve` },
    { action: "reject", path: `/approvals/${APPROVAL_ID}/reject` },
    { action: "requestRevision", path: `/approvals/${APPROVAL_ID}/request-revision` },
    { action: "resubmit", path: `/approvals/${APPROVAL_ID}/resubmit` },
  ];

  it.each(DECISION_ROUTES)(
    "$action routes to its guarded REST endpoint and surfaces a viewer-role 403",
    async ({ action, path }) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: "Forbidden: viewer role cannot decide approvals" }, 403));
      vi.stubGlobal("fetch", fetchMock);

      const response = await getTool("paperclipApprovalDecision").execute({
        approvalId: APPROVAL_ID,
        action,
      });
      const parsed = parseToolJson(response);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe(`${API}${path}`);
      expect(init.method).toBe("POST");

      expect(parsed.status).toBe(403);
      expect(String(parsed.error)).toContain("viewer role cannot decide approvals");
    },
  );
});

describe("AC3: list endpoints are pinned to the bound tenant and cannot leak cross-tenant rows", () => {
  // Each list tool, called with NO explicit company, must scope to company A's
  // path segment (never a bare collection, never company B). REST then filters
  // rows by that company, so the MCP layer cannot surface another tenant's data.
  const LIST_TOOLS: Array<{ tool: string; suffix: string }> = [
    { tool: "paperclipListIssues", suffix: "issues" },
    { tool: "paperclipListApprovals", suffix: "approvals" },
    { tool: "paperclipListProjects", suffix: "projects" },
    { tool: "paperclipListGoals", suffix: "goals" },
    { tool: "paperclipListAgents", suffix: "agents" },
  ];

  it.each(LIST_TOOLS)(
    "$tool is scoped to /companies/<bound>/$suffix and passes rows through verbatim",
    async ({ tool, suffix }) => {
      const rows = [{ id: "row-in-company-a" }];
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rows));
      vi.stubGlobal("fetch", fetchMock);

      const response = await getTool(tool).execute({});

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(String(url)).toBe(`${API}/companies/${COMPANY_A}/${suffix}`);
      expect(String(url)).not.toContain(COMPANY_B);
      // No cross-tenant augmentation: exactly what REST returned reaches the caller.
      expect(response.content[0]?.text).toBe(JSON.stringify(rows, null, 2));
    },
  );

  it("allows an explicit companyId that matches the bound tenant (guard does not over-block)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: "issue-a" }]));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipListIssues").execute({ companyId: COMPANY_A });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(`${API}/companies/${COMPANY_A}/issues`);
  });
});
