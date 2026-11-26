import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../middleware/logger.js", () => ({ logger: { warn } }));

const { validateAiApiKey } = await import("./ai-api-key-test.js");

const KEY = "sk-ant-api03-fixture-key-0123456789";

function respond(status: number, body: unknown = "") {
  return vi.fn().mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

async function failure(request: typeof fetch, provider: Parameters<typeof validateAiApiKey>[0] = "anthropic") {
  const error = await validateAiApiKey(provider, KEY, request).then(() => null, (thrown: unknown) => thrown);
  expect(error).not.toBeNull();
  const { status, message, details } = error as { status: number; message: string; details: { code: string } };
  return { status, message, code: details.code };
}

describe("validateAiApiKey", () => {
  beforeEach(() => warn.mockReset());

  it("accepts a key the provider verifies", async () => {
    await expect(validateAiApiKey("anthropic", KEY, respond(200, { data: [] }))).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([401, 403])("keeps rejecting the key on %s", async status => {
    expect(await failure(respond(status, `{"error":{"type":"authentication_error","message":"invalid x-api-key ${KEY}"}}`)))
      .toEqual({ status: 422, code: "ai_connection_api_key_rejected", message: "The provider rejected this API key." });
  });

  it.each([
    ["a 400", 400, { error: { type: "invalid_request_error" } }, "ai_connection_verification_failed"],
    ["a 402", 402, { error: { code: 402, message: "Insufficient credits" } }, "ai_connection_billing_required"],
    ["an Anthropic billing error", 400, { type: "error", error: { type: "billing_error" } }, "ai_connection_billing_required"],
    ["an OpenAI quota error on 429", 429, { error: { type: "insufficient_quota", code: "insufficient_quota" } }, "ai_connection_billing_required"],
    ["a quota code behind another error type on 429", 429, { error: { type: "invalid_request_error", code: "insufficient_quota" } }, "ai_connection_billing_required"],
    ["a 429", 429, { error: { type: "rate_limit_error" } }, "ai_connection_rate_limited"],
    ["a 500", 500, { error: { type: "api_error" } }, "ai_connection_provider_unavailable"],
    ["an Anthropic overload", 529, { error: { type: "overloaded_error" } }, "ai_connection_provider_unavailable"],
  ])("gives %s its own code", async (_label, status, body, code) => {
    const result = await failure(respond(status, body));
    expect(result.code).toBe(code);
    expect(result.status).toBe(422);
  });

  it("gives each failure its own message", async () => {
    const messages = new Set<string>();
    for (const [status, body] of [[400, {}], [402, {}], [429, {}], [500, {}]] as const) {
      messages.add((await failure(respond(status, body))).message);
    }
    expect(messages.size).toBe(4);
  });

  it("logs the status and the provider's error type without the key or the response text", async () => {
    await failure(respond(429, { error: { type: "rate_limit_error", message: `slow down ${KEY}` } }));

    expect(warn).toHaveBeenCalledWith(
      { provider: "anthropic", status: 429, providerErrorType: "rate_limit_error", failure: "ai_connection_rate_limited" },
      "AI provider did not verify an API key",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("slow down");
  });

  it("logs the billing field when the error type and code differ", async () => {
    await failure(respond(429, { error: { type: "invalid_request_error", code: "insufficient_quota" } }));

    expect(warn.mock.calls[0]![0]).toMatchObject({ providerErrorType: "insufficient_quota", failure: "ai_connection_billing_required" });
  });

  it("logs only known provider error types", async () => {
    await failure(respond(500, { error: { type: KEY } }));
    await failure(respond(500, { error: { type: `${KEY}_suffix` } }));
    await failure(respond(500, { error: { type: "fixture" } }), "openai");
    await failure(respond(429, { error: { type: "custom_upstream_type", code: "rate_limit_exceeded" } }), "openai");
    await failure(respond(503, { error: { status: "UNAVAILABLE" } }), "google");
    await failure(respond(500, "<html>upstream error</html>"));

    expect(warn.mock.calls.map(([fields]) => fields.providerErrorType))
      .toEqual([null, null, null, "rate_limit_exceeded", "UNAVAILABLE", null]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });

  it("reads at most a bounded part of a large error body", async () => {
    const body = `{"error":{"type":"api_error"},"padding":"${"x".repeat(64 * 1024)}"}`;
    const result = await failure(respond(500, body));
    expect(result.code).toBe("ai_connection_provider_unavailable");
    expect(warn.mock.calls[0]![0].providerErrorType).toBeNull();
  });

  it("separates a timeout from an unreachable provider", async () => {
    const timedOut = await failure(vi.fn().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError")));
    expect(timedOut.code).toBe("ai_connection_verification_timeout");

    const unreachable = await failure(vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })));
    expect(unreachable.code).toBe("ai_connection_provider_unreachable");

    expect(warn.mock.calls.map(([fields]) => fields.networkError)).toEqual(["timeout", "ENOTFOUND"]);
  });
});
