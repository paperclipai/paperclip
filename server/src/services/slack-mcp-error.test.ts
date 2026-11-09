import { afterEach, describe, expect, it, vi } from "vitest";
import { isSlackMcpAccessDisabledResponse } from "./slack-mcp-error.js";

const endpoint = "https://mcp.slack.com/mcp";
const message = "App is not enabled for Slack MCP server access. Please enable it here: https://api.slack.com/apps/fixture/mcp";
const payload = { jsonrpc: "2.0", id: null, error: { code: -32600, message } };
const response = (body: unknown = payload, status = 400, contentType = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });

afterEach(() => vi.useRealTimers());

describe("Slack MCP app setup failure", () => {
  it("recognizes Slack's explicit disabled-app response, including its null RPC id", async () => {
    expect(await isSlackMcpAccessDisabledResponse(endpoint, response())).toBe(true);
  });

  it.each([
    "https://other.example.test/mcp",
    "https://mcp.slack.com.example.test/mcp",
    "http://mcp.slack.com/mcp",
    "https://mcp.slack.com:8443/mcp",
    "https://mcp.slack.com/other",
  ])("does not classify matching text from %s", async (url) => {
    const upstream = response();
    expect(await isSlackMcpAccessDisabledResponse(url, upstream)).toBe(false);
    expect(upstream.bodyUsed).toBe(false);
  });

  it.each([401, 403, 429, 500, 503])("does not hide HTTP %i behind a setup error", async (status) => {
    expect(await isSlackMcpAccessDisabledResponse(endpoint, response(payload, status))).toBe(false);
  });

  it.each([
    { ...payload, error: { code: -32600, message: "Missing session ID" } },
    { ...payload, error: { code: -32603, message } },
    { ...payload, error: message },
    { ...payload, jsonrpc: "1.0" },
    null,
  ])("keeps unrecognized errors reportable: %j", async (body) => {
    expect(await isSlackMcpAccessDisabledResponse(endpoint, response(body))).toBe(false);
  });

  it("rejects non-JSON content and malformed JSON", async () => {
    expect(await isSlackMcpAccessDisabledResponse(endpoint, response(payload, 400, "text/html"))).toBe(false);
    expect(await isSlackMcpAccessDisabledResponse(endpoint,
      new Response("{", { status: 400, headers: { "content-type": "application/json" } }))).toBe(false);
  });

  it("bounds and cancels oversized error responses", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...payload, extra: "x".repeat(8192) }))); },
      cancel,
    });
    expect(await isSlackMcpAccessDisabledResponse(endpoint,
      new Response(body, { status: 400, headers: { "content-type": "application/json" } }))).toBe(false);
    expect(cancel).toHaveBeenCalled();
  });

  it("bounds and cancels a stalled error body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const result = isSlackMcpAccessDisabledResponse(endpoint,
      new Response(new ReadableStream({ cancel }), { status: 400, headers: { "content-type": "application/json" } }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBe(false);
    expect(cancel).toHaveBeenCalled();
  });
});
