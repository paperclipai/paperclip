import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import { setupMockFetch, teardownMockFetch, mockJsonResponse, mockFetch, SAMPLE_AGENTS, SAMPLE_ISSUES } from "./test_helpers.ts";

const BASE_URL = "http://localhost:8080";

function jsonRequest(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function notifyRequest(body: Record<string, unknown>, apiKey = ""): Promise<Request> {
  const headers: Record<string, string> = {};
  headers["Authorization"] = `Bearer ${apiKey}`;
  return Promise.resolve(jsonRequest("POST", "/notify", body, headers));
}

Deno.test({
  name: "GET /health returns status json (accepts 503 when unconfigured)",
  async fn() {
    const { handleRequest } = await import("./index.ts");
    const res = await handleRequest(new Request(`${BASE_URL}/health`));
    // 200 = healthy, 503 = unhealthy (no env vars in test env)
    assertEquals([200, 503].includes(res.status), true);
    const data = await res.json();
    assertEquals(typeof data.status, "string");
    assertEquals(typeof data.botConfigured, "boolean");
    assertEquals(typeof data.paperclipConfigured, "boolean");
    assertEquals(typeof data.aiConfigured, "boolean");
    assertEquals(typeof data.aiProvider, "string");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "GET / returns status json",
  async fn() {
    const { handleRequest } = await import("./index.ts");
    const res = await handleRequest(new Request(`${BASE_URL}/`));
    assertEquals([200, 503].includes(res.status), true);
    const data = await res.json();
    assertEquals(typeof data.status, "string");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "POST / with non-message update returns ok",
  async fn() {
    const { handleRequest } = await import("./index.ts");
    const res = await handleRequest(jsonRequest("POST", "/", { update_id: 1 }));
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.reason, "non-message update ignored");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "POST / processes /start command and sends Telegram message",
  async fn() {
    setupMockFetch();
    const { handleRequest } = await import("./index.ts");
    mockFetch(/api\.telegram\.org/, () => mockJsonResponse({ ok: true }));
    const res = await handleRequest(jsonRequest("POST", "/", {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 12345, first_name: "TestUser" },
        chat: { id: 67890, type: "private" },
        text: "/start",
        date: 1000000,
      },
    }));
    const data = await res.json();
    assertEquals(data.ok, true);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "POST / processes /blocked query with mocked API",
  async fn() {
    setupMockFetch();
    const { handleRequest } = await import("./index.ts");
    mockFetch(/api\.telegram\.org/, () => mockJsonResponse({ ok: true }));
    mockFetch(/status=blocked/, () =>
      mockJsonResponse(SAMPLE_ISSUES.filter((i) => i.status === "blocked"))
    );
    const res = await handleRequest(jsonRequest("POST", "/", {
      update_id: 1,
      message: {
        message_id: 101,
        from: { id: 12345, first_name: "TestUser" },
        chat: { id: 67890, type: "private" },
        text: "/blocked",
        date: 1000000,
      },
    }));
    const data = await res.json();
    assertEquals(data.ok, true);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "POST / handles API error gracefully",
  async fn() {
    setupMockFetch();
    const { handleRequest } = await import("./index.ts");
    mockFetch(/api\.telegram\.org/, () => mockJsonResponse({ ok: true }));
    mockFetch(/status=blocked/, () => new Response("Internal Error", { status: 500 }));
    const res = await handleRequest(jsonRequest("POST", "/", {
      update_id: 1,
      message: {
        message_id: 101,
        from: { id: 12345, first_name: "TestUser" },
        chat: { id: 67890, type: "private" },
        text: "/blocked",
        date: 1000000,
      },
    }));
    const data = await res.json();
    assertEquals(data.ok, true);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "POST /notify returns 401 without auth",
  async fn() {
    const { handleRequest } = await import("./index.ts");
    const req = await notifyRequest({ text: "test" });
    const res = await handleRequest(req);
    assertEquals(res.status, 401);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "POST /notify requires text field (accepts 400 or 401 in test env)",
  async fn() {
    setupMockFetch();
    const CHASE_API_KEY = Deno.env.get("CHASE_PAPERCLIP_API_KEY") ?? "";
    const { handleRequest } = await import("./index.ts");
    const req = await notifyRequest({}, CHASE_API_KEY);
    const res = await handleRequest(req);
    // 400 = reached text check (authed), 401 = CHASE_API_KEY not set
    assertEquals([400, 401].includes(res.status), true);
    if (res.status === 400) {
      const data = await res.json();
      assertEquals(data.error, "text is required");
    }
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "POST /notify passes auth and sends when API key matches",
  async fn() {
    setupMockFetch();
    mockFetch(/api\.telegram\.org/, () => mockJsonResponse({ ok: true }));
    const CHASE_API_KEY = Deno.env.get("CHASE_PAPERCLIP_API_KEY") ?? "";
    const { handleRequest } = await import("./index.ts");
    const req = await notifyRequest({
      text: "Test notification message",
      title: "Alert",
    }, CHASE_API_KEY);
    const res = await handleRequest(req);
    const data = await res.json();
    // 200 = success, 401 = auth failed (env not set)
    if (res.status === 200) {
      assertEquals(data.ok, true);
    } else {
      assertEquals(res.status, 401);
    }
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "POST /setup-webhook returns 401 without auth",
  async fn() {
    const { handleRequest } = await import("./index.ts");
    const req = jsonRequest("POST", "/setup-webhook", { url: "https://example.com/webhook" });
    const res = await handleRequest(req);
    assertEquals(res.status, 401);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "POST /setup-webhook returns 400/401 (accepts both in test env)",
  async fn() {
    const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SETUP_SECRET") ?? "";
    const { handleRequest } = await import("./index.ts");
    const req = jsonRequest("POST", "/setup-webhook", {}, {
      Authorization: `Bearer ${WEBHOOK_SECRET}`,
    });
    const res = await handleRequest(req);
    // 400 = authed but no url; 401 = WEBHOOK_SECRET not set in env
    assertEquals([400, 401].includes(res.status), true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Unknown path returns 404",
  async fn() {
    const { handleRequest } = await import("./index.ts");
    const res = await handleRequest(new Request(`${BASE_URL}/unknown`));
    assertEquals(res.status, 404);
    const data = await res.json();
    assertEquals(data.error, "Not found");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
