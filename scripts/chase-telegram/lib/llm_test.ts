import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import { fallbackReply, isAiConfigured, aiProvider } from "./llm.ts";
import { setupMockFetch, teardownMockFetch, mockJsonResponse, mockFetch } from "../test_helpers.ts";

Deno.test({
  name: "fallbackReply returns helpful message with command list",
  fn() {
    const reply = fallbackReply();
    assertStringIncludes(reply, "having trouble");
    assertStringIncludes(reply, "/blocked");
    assertStringIncludes(reply, "/overview");
    assertStringIncludes(reply, "/approvals");
    assertStringIncludes(reply, "/help");
  },
});

Deno.test({
  name: "isAiConfigured returns boolean",
  fn() {
    const result = isAiConfigured();
    assertEquals(typeof result, "boolean");
  },
});

Deno.test({
  name: "aiProvider returns string",
  fn() {
    const result = aiProvider();
    assertEquals(typeof result, "string");
    assertEquals(["deepseek", "anthropic", "none"].includes(result), true);
  },
});

Deno.test({
  name: "generateReply returns fallback when no AI configured",
  async fn() {
    setupMockFetch();
    const { generateReply } = await import("./llm.ts");
    const result = await generateReply("hello");
    assertStringIncludes(result, "having trouble");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "classifyIntent returns null when no AI configured",
  async fn() {
    setupMockFetch();
    const { classifyIntent } = await import("./llm.ts");
    const result = await classifyIntent("hello");
    assertEquals(result, null);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "formatNotification returns null when no AI configured",
  async fn() {
    setupMockFetch();
    const { formatNotification } = await import("./llm.ts");
    const result = await formatNotification("Test notification");
    assertEquals(result, null);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
