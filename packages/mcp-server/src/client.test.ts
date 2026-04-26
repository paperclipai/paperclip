import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PaperclipApiClient, PaperclipApiError } from "./client.js";
import type { PaperclipMcpConfig } from "./config.js";

function makeConfig(overrides: Partial<PaperclipMcpConfig> = {}): PaperclipMcpConfig {
  return {
    apiUrl: "https://api.example.com/api",
    apiKey: "test-key",
    companyId: "company-abc",
    agentId: "agent-xyz",
    runId: "run-123",
    ...overrides,
  };
}

function makeClient(overrides: Partial<PaperclipMcpConfig> = {}): PaperclipApiClient {
  return new PaperclipApiClient(makeConfig(overrides));
}

// ============================================================================
// PaperclipApiError
// ============================================================================

describe("PaperclipApiError", () => {
  it("sets all fields from constructor input", () => {
    const err = new PaperclipApiError({
      status: 404,
      method: "GET",
      path: "/api/things",
      body: { error: "not found" },
      message: "GET /api/things failed with 404: not found",
    });
    expect(err.status).toBe(404);
    expect(err.method).toBe("GET");
    expect(err.path).toBe("/api/things");
    expect(err.body).toEqual({ error: "not found" });
    expect(err.message).toBe("GET /api/things failed with 404: not found");
  });

  it("has name 'PaperclipApiError'", () => {
    const err = new PaperclipApiError({ status: 500, method: "POST", path: "/x", body: null, message: "fail" });
    expect(err.name).toBe("PaperclipApiError");
  });

  it("is an instance of Error", () => {
    const err = new PaperclipApiError({ status: 500, method: "POST", path: "/x", body: null, message: "fail" });
    expect(err).toBeInstanceOf(Error);
  });
});

// ============================================================================
// PaperclipApiClient.defaults
// ============================================================================

describe("PaperclipApiClient.defaults", () => {
  it("returns companyId, agentId, and runId from config", () => {
    const client = makeClient({ companyId: "c1", agentId: "a1", runId: "r1" });
    expect(client.defaults).toEqual({ companyId: "c1", agentId: "a1", runId: "r1" });
  });

  it("returns null values when config fields are null", () => {
    const client = makeClient({ companyId: null, agentId: null, runId: null });
    expect(client.defaults).toEqual({ companyId: null, agentId: null, runId: null });
  });
});

// ============================================================================
// PaperclipApiClient.resolveCompanyId
// ============================================================================

describe("PaperclipApiClient.resolveCompanyId", () => {
  it("returns the passed value when provided", () => {
    const client = makeClient({ companyId: "from-config" });
    expect(client.resolveCompanyId("from-arg")).toBe("from-arg");
  });

  it("falls back to config companyId when no argument given", () => {
    const client = makeClient({ companyId: "from-config" });
    expect(client.resolveCompanyId()).toBe("from-config");
  });

  it("falls back to config companyId when argument is null", () => {
    const client = makeClient({ companyId: "from-config" });
    expect(client.resolveCompanyId(null)).toBe("from-config");
  });

  it("trims whitespace from the passed value", () => {
    const client = makeClient({ companyId: "from-config" });
    expect(client.resolveCompanyId("  spaced  ")).toBe("spaced");
  });

  it("falls back to config when passed value is whitespace-only", () => {
    const client = makeClient({ companyId: "from-config" });
    expect(client.resolveCompanyId("   ")).toBe("from-config");
  });

  it("throws when argument is missing and config companyId is null", () => {
    const client = makeClient({ companyId: null });
    expect(() => client.resolveCompanyId()).toThrow("companyId is required");
  });

  it("throws when both argument and config companyId are null", () => {
    const client = makeClient({ companyId: null });
    expect(() => client.resolveCompanyId(null)).toThrow("PAPERCLIP_COMPANY_ID is not set");
  });
});

// ============================================================================
// PaperclipApiClient.resolveAgentId
// ============================================================================

describe("PaperclipApiClient.resolveAgentId", () => {
  it("returns the passed value when provided", () => {
    const client = makeClient({ agentId: "from-config" });
    expect(client.resolveAgentId("from-arg")).toBe("from-arg");
  });

  it("falls back to config agentId when no argument given", () => {
    const client = makeClient({ agentId: "from-config" });
    expect(client.resolveAgentId()).toBe("from-config");
  });

  it("falls back to config agentId when argument is null", () => {
    const client = makeClient({ agentId: "from-config" });
    expect(client.resolveAgentId(null)).toBe("from-config");
  });

  it("trims whitespace from the passed value", () => {
    const client = makeClient({ agentId: "from-config" });
    expect(client.resolveAgentId("  spaced  ")).toBe("spaced");
  });

  it("falls back to config when passed value is whitespace-only", () => {
    const client = makeClient({ agentId: "from-config" });
    expect(client.resolveAgentId("   ")).toBe("from-config");
  });

  it("throws when argument is missing and config agentId is null", () => {
    const client = makeClient({ agentId: null });
    expect(() => client.resolveAgentId()).toThrow("agentId is required");
  });

  it("throws when both argument and config agentId are null", () => {
    const client = makeClient({ agentId: null });
    expect(() => client.resolveAgentId(null)).toThrow("PAPERCLIP_AGENT_ID is not set");
  });
});

// ============================================================================
// PaperclipApiClient.requestJson — path validation
// ============================================================================

describe("PaperclipApiClient.requestJson — path validation", () => {
  it("throws when path does not start with /", async () => {
    const client = makeClient();
    await expect(client.requestJson("GET", "no-leading-slash")).rejects.toThrow(
      'API path must start with "/"',
    );
  });

  it("does not throw when path starts with /", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient();
    await expect(client.requestJson("GET", "/valid")).resolves.not.toThrow();
    fetchSpy.mockRestore();
  });
});

// ============================================================================
// PaperclipApiClient.requestJson — URL construction
// ============================================================================

describe("PaperclipApiClient.requestJson — URL construction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("constructs URL from apiUrl and path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ apiUrl: "https://api.example.com/api" });
    await client.requestJson("GET", "/companies");
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain("api.example.com");
    expect(calledUrl).toContain("companies");
  });
});

// ============================================================================
// PaperclipApiClient.requestJson — headers
// ============================================================================

describe("PaperclipApiClient.requestJson — headers", () => {
  afterEach(() => vi.restoreAllMocks());

  function getHeaders(fetchSpy: { mock: { calls: Array<[unknown, RequestInit?]> } }): Record<string, string> {
    return (fetchSpy.mock.calls[0]![1]?.headers ?? {}) as Record<string, string>;
  }

  it("always includes Authorization header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ apiKey: "my-token" });
    await client.requestJson("GET", "/things");
    expect(getHeaders(fetchSpy)["Authorization"]).toBe("Bearer my-token");
  });

  it("does not include Content-Type when no body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient();
    await client.requestJson("GET", "/things");
    expect(getHeaders(fetchSpy)["Content-Type"]).toBeUndefined();
  });

  it("includes Content-Type: application/json when body is present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient();
    await client.requestJson("POST", "/things", { body: { name: "test" } });
    expect(getHeaders(fetchSpy)["Content-Type"]).toBe("application/json");
  });

  it("includes X-Paperclip-Run-Id for POST when runId is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ runId: "run-abc" });
    await client.requestJson("POST", "/things");
    expect(getHeaders(fetchSpy)["X-Paperclip-Run-Id"]).toBe("run-abc");
  });

  it("includes X-Paperclip-Run-Id for PATCH when runId is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ runId: "run-abc" });
    await client.requestJson("PATCH", "/things/1");
    expect(getHeaders(fetchSpy)["X-Paperclip-Run-Id"]).toBe("run-abc");
  });

  it("includes X-Paperclip-Run-Id for PUT when runId is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ runId: "run-abc" });
    await client.requestJson("PUT", "/things/1");
    expect(getHeaders(fetchSpy)["X-Paperclip-Run-Id"]).toBe("run-abc");
  });

  it("includes X-Paperclip-Run-Id for DELETE when runId is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ runId: "run-abc" });
    await client.requestJson("DELETE", "/things/1");
    expect(getHeaders(fetchSpy)["X-Paperclip-Run-Id"]).toBe("run-abc");
  });

  it("does not include X-Paperclip-Run-Id for GET even when runId is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ runId: "run-abc" });
    await client.requestJson("GET", "/things");
    expect(getHeaders(fetchSpy)["X-Paperclip-Run-Id"]).toBeUndefined();
  });

  it("does not include X-Paperclip-Run-Id for HEAD even when runId is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const client = makeClient({ runId: "run-abc" });
    await client.requestJson("HEAD", "/things");
    expect(getHeaders(fetchSpy)["X-Paperclip-Run-Id"]).toBeUndefined();
  });

  it("omits X-Paperclip-Run-Id for write method when runId is null", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ runId: null });
    await client.requestJson("POST", "/things");
    expect(getHeaders(fetchSpy)["X-Paperclip-Run-Id"]).toBeUndefined();
  });

  it("includes X-Paperclip-Run-Id for GET when includeRunId is explicitly true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ runId: "run-abc" });
    await client.requestJson("GET", "/things", { includeRunId: true });
    expect(getHeaders(fetchSpy)["X-Paperclip-Run-Id"]).toBe("run-abc");
  });

  it("omits X-Paperclip-Run-Id for POST when includeRunId is explicitly false", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ runId: "run-abc" });
    await client.requestJson("POST", "/things", { includeRunId: false });
    expect(getHeaders(fetchSpy)["X-Paperclip-Run-Id"]).toBeUndefined();
  });
});

// ============================================================================
// PaperclipApiClient.requestJson — response parsing
// ============================================================================

describe("PaperclipApiClient.requestJson — response parsing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns parsed JSON body on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "abc", name: "test" }), { status: 200 }),
    );
    const client = makeClient();
    const result = await client.requestJson<{ id: string; name: string }>("GET", "/things/abc");
    expect(result).toEqual({ id: "abc", name: "test" });
  });

  it("returns plain text when response body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("plain text response", { status: 200 }));
    const client = makeClient();
    const result = await client.requestJson<string>("GET", "/things");
    expect(result).toBe("plain text response");
  });

  it("returns null when response body is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const client = makeClient();
    const result = await client.requestJson("GET", "/things");
    expect(result).toBeNull();
  });
});

// ============================================================================
// PaperclipApiClient.requestJson — error handling
// ============================================================================

describe("PaperclipApiClient.requestJson — error handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws PaperclipApiError on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    const client = makeClient();
    await expect(client.requestJson("GET", "/things/missing")).rejects.toBeInstanceOf(PaperclipApiError);
  });

  it("includes status, method, and path in thrown error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    );
    const client = makeClient();
    let caught: PaperclipApiError | null = null;
    try {
      await client.requestJson("DELETE", "/things/1");
    } catch (e) {
      caught = e as PaperclipApiError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.status).toBe(403);
    expect(caught!.method).toBe("DELETE");
    expect(caught!.path).toBe("/things/1");
  });

  it("includes body.error in error message when present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "resource not found" }), { status: 404 }),
    );
    const client = makeClient();
    await expect(client.requestJson("GET", "/things/missing")).rejects.toThrow("resource not found");
  });

  it("uses generic message when body has no error field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "something went wrong" }), { status: 500 }),
    );
    const client = makeClient();
    await expect(client.requestJson("GET", "/things")).rejects.toThrow("GET /things failed with 500");
  });

  it("includes parsed body on the thrown error object", async () => {
    const responseBody = { error: "bad request", field: "name" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(responseBody), { status: 400 }),
    );
    const client = makeClient();
    let caught: PaperclipApiError | null = null;
    try {
      await client.requestJson("POST", "/things");
    } catch (e) {
      caught = e as PaperclipApiError;
    }
    expect(caught!.body).toEqual(responseBody);
  });

  it("serializes body as JSON when body option is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient();
    await client.requestJson("POST", "/things", { body: { key: "value" } });
    const sentBody = fetchSpy.mock.calls[0]![1]?.body;
    expect(sentBody).toBe(JSON.stringify({ key: "value" }));
  });

  it("sends undefined body when no body option given", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient();
    await client.requestJson("GET", "/things");
    const sentBody = fetchSpy.mock.calls[0]![1]?.body;
    expect(sentBody).toBeUndefined();
  });
});
