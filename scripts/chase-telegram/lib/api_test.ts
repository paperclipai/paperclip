import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import { isPaperclipConfigured } from "./api.ts";
import { setupMockFetch, teardownMockFetch, mockJsonResponse, mockFetch } from "../test_helpers.ts";

Deno.test({
  name: "isPaperclipConfigured returns boolean based on env",
  fn() {
    const result = isPaperclipConfigured();
    assertEquals(typeof result, "boolean");
  },
});

Deno.test({
  name: "paperclipGet calls fetch with correct URL and auth header",
  async fn() {
    setupMockFetch();
    const { paperclipGet } = await import("./api.ts");
    let capturedUrl = "";
    let capturedAuth = "";
    mockFetch(/\/api\/test/, (url, init) => {
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      return mockJsonResponse({ ok: true });
    });
    const result = await paperclipGet("/api/test");
    assertEquals(result, { ok: true });
    assertEquals(capturedUrl.includes("/api/test"), true);
    assertEquals(capturedAuth.startsWith("Bearer "), true);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "paperclipGet throws on non-ok response",
  async fn() {
    setupMockFetch();
    const { paperclipGet } = await import("./api.ts");
    mockFetch(/\/api\/error/, () => new Response("Not Found", { status: 404 }));
    try {
      await paperclipGet("/api/error");
      assertEquals(true, false, "Should have thrown");
    } catch (err) {
      assertStringIncludes((err as Error).message, "Paperclip API 404");
    }
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "paperclipPost sends POST with JSON body",
  async fn() {
    setupMockFetch();
    const { paperclipPost } = await import("./api.ts");
    let capturedMethod = "";
    let capturedBody = "";
    mockFetch(/\/api\/create/, (url, init) => {
      capturedMethod = init?.method ?? "GET";
      capturedBody = init?.body as string ?? "";
      return mockJsonResponse({ id: "new-1" });
    });
    const result = await paperclipPost("/api/create", { title: "Test" });
    assertEquals(capturedMethod, "POST");
    assertEquals(capturedBody, JSON.stringify({ title: "Test" }));
    assertEquals(result, { id: "new-1" });
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
