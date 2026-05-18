import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { TOOL_NAMES } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveTransitionId } from "./tools/shared.js";
import { JiraClient } from "./jira-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_CONFIG = {
  jiraBaseUrl: "https://poilabs.atlassian.net",
  jiraUserEmail: "test@poilabs.com",
  jiraApiTokenRef: "JIRA_API_TOKEN",
  transitionMapping: {
    done: "21",
    "ready-for-release": "31",
    "in-review": "41",
  },
};

const FAKE_TRANSITIONS = [
  { id: "21", name: "Done", to: { id: "3", name: "Done" } },
  { id: "31", name: "Ready for Release", to: { id: "4", name: "Ready for Release" } },
  { id: "41", name: "In Review", to: { id: "2", name: "In Review" } },
];

function makeFakeIssueResponse(key: string) {
  return {
    key,
    fields: {
      summary: "Test issue summary",
      status: { name: "To Do" },
      assignee: { displayName: "Jane Doe" },
    },
  };
}

function makeTransitionsResponse(transitions = FAKE_TRANSITIONS) {
  return { transitions };
}

function makeFetchMock(responses: Record<string, unknown>) {
  return vi.fn(async (url: string | Request) => {
    const urlStr = typeof url === "string" ? url : (url as Request).url;
    for (const [pattern, body] of Object.entries(responses)) {
      if (urlStr.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// resolveTransitionId unit tests
// ---------------------------------------------------------------------------

describe("resolveTransitionId", () => {
  it("returns numeric string as-is", () => {
    expect(resolveTransitionId("21", {})).toBe("21");
    expect(resolveTransitionId("99", { done: "21" })).toBe("99");
  });

  it("maps logical name to transition ID", () => {
    expect(resolveTransitionId("done", { done: "21" })).toBe("21");
    expect(resolveTransitionId("ready-for-release", { "ready-for-release": "31" })).toBe("31");
  });

  it("throws for unknown logical name", () => {
    expect(() => resolveTransitionId("unknown-name", { done: "21" })).toThrow(
      /Unknown transition name "unknown-name"/,
    );
  });

  it("includes known keys hint in error message", () => {
    expect(() =>
      resolveTransitionId("missing", { done: "21", deployed: "99" }),
    ).toThrow(/Known mapping keys: done, deployed/);
  });

  it("mentions no mapping configured when map is empty", () => {
    expect(() => resolveTransitionId("done", {})).toThrow(
      /No transition mapping configured/,
    );
  });
});

// ---------------------------------------------------------------------------
// JiraClient unit tests (with fetch mock)
// ---------------------------------------------------------------------------

describe("JiraClient", () => {
  it("builds correct Basic Auth header", async () => {
    const captured: { headers?: HeadersInit }[] = [];
    const mockFetch = vi.fn(async (_url: string | Request, init?: RequestInit) => {
      captured.push({ headers: init?.headers });
      return new Response(JSON.stringify({ transitions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new JiraClient(
      { baseUrl: "https://poilabs.atlassian.net", userEmail: "u@example.com", apiToken: "tok" },
      mockFetch as unknown as typeof fetch,
    );

    await client.getTransitions("PD-1");

    const authHeader = (captured[0]?.headers as Record<string, string>)?.Authorization;
    expect(authHeader).toBe(
      `Basic ${Buffer.from("u@example.com:tok").toString("base64")}`,
    );
  });

  it("getTransitions returns transition list", async () => {
    const client = new JiraClient(
      { baseUrl: "https://test.atlassian.net", userEmail: "u@test.com", apiToken: "t" },
      makeFetchMock({ "/transitions": makeTransitionsResponse() }) as unknown as typeof fetch,
    );

    const transitions = await client.getTransitions("PD-100");
    expect(transitions).toHaveLength(3);
    expect(transitions[0]).toMatchObject({ id: "21", name: "Done" });
  });

  it("getIssue returns enriched issue with transitions", async () => {
    const fetchMock = makeFetchMock({
      "/issue/PD-100/transitions": makeTransitionsResponse(),
      "/issue/PD-100": makeFakeIssueResponse("PD-100"),
    });

    const client = new JiraClient(
      { baseUrl: "https://test.atlassian.net", userEmail: "u@test.com", apiToken: "t" },
      fetchMock as unknown as typeof fetch,
    );

    const issue = await client.getIssue("PD-100");
    expect(issue).toMatchObject({
      key: "PD-100",
      summary: "Test issue summary",
      status: "To Do",
      assignee: "Jane Doe",
    });
    expect(issue.transitions).toHaveLength(3);
  });

  it("transition posts correct body", async () => {
    const capturedBodies: string[] = [];
    const mockFetch = vi.fn(async (_url: string | Request, init?: RequestInit) => {
      if (init?.body) capturedBodies.push(String(init.body));
      return new Response(null, { status: 204 });
    });

    const client = new JiraClient(
      { baseUrl: "https://test.atlassian.net", userEmail: "u@test.com", apiToken: "t" },
      mockFetch as unknown as typeof fetch,
    );

    await client.transition("PD-100", "21");

    expect(JSON.parse(capturedBodies[0]!)).toEqual({ transition: { id: "21" } });
  });

  it("assignIssue sends correct PUT body", async () => {
    const capturedBodies: string[] = [];
    const mockFetch = vi.fn(async (_url: string | Request, init?: RequestInit) => {
      if (init?.body) capturedBodies.push(String(init.body));
      return new Response(null, { status: 204 });
    });

    const client = new JiraClient(
      { baseUrl: "https://test.atlassian.net", userEmail: "u@test.com", apiToken: "t" },
      mockFetch as unknown as typeof fetch,
    );

    await client.assignIssue("PD-100", "abc-account-id");
    expect(JSON.parse(capturedBodies[0]!)).toEqual({ accountId: "abc-account-id" });
  });

  it("throws on non-2xx response", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );

    const client = new JiraClient(
      { baseUrl: "https://test.atlassian.net", userEmail: "u@test.com", apiToken: "bad" },
      mockFetch as unknown as typeof fetch,
    );

    await expect(client.getTransitions("PD-1")).rejects.toThrow(
      /Jira API error 401/,
    );
  });
});

// ---------------------------------------------------------------------------
// Plugin tool handler integration tests (via test harness)
// ---------------------------------------------------------------------------

describe("Atlassian plugin tools", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(async () => {
    harness = createTestHarness({ manifest, config: FAKE_CONFIG });
    await plugin.definition.setup(harness.ctx);
  });

  function setHttpMock(responses: Record<string, unknown>) {
    const fetchMock = makeFetchMock(responses);
    (harness.ctx.http as { fetch: unknown }).fetch = fetchMock;
    return fetchMock;
  }

  // --- jira.getIssue ---

  it("jira.getIssue returns issue data", async () => {
    setHttpMock({
      "/issue/PD-123/transitions": makeTransitionsResponse(),
      "/issue/PD-123": makeFakeIssueResponse("PD-123"),
    });

    const result = await harness.executeTool(TOOL_NAMES.getIssue, { key: "PD-123" });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("PD-123");
    expect(result.content).toContain("Test issue summary");
    expect((result.data as { status: string }).status).toBe("To Do");
  });

  it("jira.getIssue returns error for missing key", async () => {
    const result = await harness.executeTool(TOOL_NAMES.getIssue, { key: "" });
    expect(result.error).toMatch(/key is required/);
  });

  // --- jira.transition ---

  it("jira.transition by logical name resolves via transitionMapping", async () => {
    const fetchMock = setHttpMock({
      "/transitions": makeTransitionsResponse(),
    });
    // First call = getTransitions, second = POST transition (204)
    let callCount = 0;
    (harness.ctx.http as { fetch: unknown }).fetch = vi.fn(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      callCount++;
      if (urlStr.includes("/transitions") && callCount === 1) {
        return new Response(JSON.stringify(makeTransitionsResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    });

    const result = await harness.executeTool(TOOL_NAMES.transition, {
      key: "PD-123",
      transition: "done",
    });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Done");
    expect((result.data as { ok: boolean }).ok).toBe(true);
    expect((result.data as { transitionId: string }).transitionId).toBe("21");
  });

  it("jira.transition by numeric ID is passed directly", async () => {
    (harness.ctx.http as { fetch: unknown }).fetch = vi.fn(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/transitions")) {
        return new Response(JSON.stringify(makeTransitionsResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    });

    const result = await harness.executeTool(TOOL_NAMES.transition, {
      key: "PD-123",
      transition: "31",
    });
    expect(result.error).toBeUndefined();
    expect((result.data as { transitionId: string }).transitionId).toBe("31");
  });

  it("jira.transition returns error for unavailable transition", async () => {
    (harness.ctx.http as { fetch: unknown }).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ transitions: [{ id: "99", name: "Other", to: { id: "9", name: "Other" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await harness.executeTool(TOOL_NAMES.transition, {
      key: "PD-123",
      transition: "21",
    });
    expect(result.error).toMatch(/not available/);
  });

  // --- jira.assignIssue ---

  it("jira.assignIssue calls Jira assign endpoint", async () => {
    const mockFetch = vi.fn(async () => new Response(null, { status: 204 }));
    (harness.ctx.http as { fetch: unknown }).fetch = mockFetch;

    const result = await harness.executeTool(TOOL_NAMES.assignIssue, {
      key: "PD-123",
      accountId: "abc123",
    });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("abc123");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = (mockFetch.mock.calls[0] as unknown as [string])[0];
    expect(String(calledUrl)).toContain("/assignee");
  });

  it("jira.assignIssue with null accountId unassigns", async () => {
    const capturedBodies: string[] = [];
    const mockFetch = vi.fn(async (_url: string | Request, init?: RequestInit) => {
      if (init?.body) capturedBodies.push(String(init.body));
      return new Response(null, { status: 204 });
    });
    (harness.ctx.http as { fetch: unknown }).fetch = mockFetch;

    const result = await harness.executeTool(TOOL_NAMES.assignIssue, {
      key: "PD-123",
      accountId: null,
    });
    expect(result.error).toBeUndefined();
    expect(JSON.parse(capturedBodies[0]!)).toEqual({ accountId: null });
  });

  // --- jira.getTransitions ---

  it("jira.getTransitions returns formatted list", async () => {
    (harness.ctx.http as { fetch: unknown }).fetch = vi.fn(async () =>
      new Response(JSON.stringify(makeTransitionsResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await harness.executeTool(TOOL_NAMES.getTransitions, { key: "PD-123" });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("[21]");
    expect(result.content).toContain("Done");
    expect((result.data as { transitions: unknown[] }).transitions).toHaveLength(3);
  });

  it("jira.getTransitions returns error for empty key", async () => {
    const result = await harness.executeTool(TOOL_NAMES.getTransitions, { key: "" });
    expect(result.error).toMatch(/key is required/);
  });
});
