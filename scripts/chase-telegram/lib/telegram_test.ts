import { assertEquals } from "std/testing/asserts.ts";
import { isBotConfigured } from "./telegram.ts";
import { setupMockFetch, teardownMockFetch, mockJsonResponse, mockFetch } from "../test_helpers.ts";

Deno.test({
  name: "isBotConfigured returns boolean",
  fn() {
    const result = isBotConfigured();
    assertEquals(typeof result, "boolean");
  },
});

Deno.test({
  name: "sendTelegram sends message to Telegram API",
  async fn() {
    setupMockFetch();
    const { sendTelegram } = await import("./telegram.ts");
    let capturedBody = "";
    mockFetch(/api\.telegram\.org/, (url, init) => {
      capturedBody = init?.body as string ?? "";
      return mockJsonResponse({ ok: true });
    });
    const result = await sendTelegram(12345, "Hello from Chase");
    assertEquals(result, true);
    const parsed = JSON.parse(capturedBody);
    assertEquals(parsed.chat_id, 12345);
    assertEquals(parsed.text, "Hello from Chase");
    assertEquals(parsed.parse_mode, "HTML");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "sendTelegram returns false on API error",
  async fn() {
    setupMockFetch();
    const { sendTelegram } = await import("./telegram.ts");
    mockFetch(/api\.telegram\.org/, () => new Response("Unauthorized", { status: 401 }));
    const result = await sendTelegram(12345, "Test");
    assertEquals(result, false);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
