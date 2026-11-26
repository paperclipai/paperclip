import { expect, it } from "vitest";
import { startReviewProvider } from "../fixtures/connection-review-provider.js";

it("authenticates the reachable review fixture before parsing and bounds accepted requests", async () => {
  const service = await startReviewProvider("synthetic-service-proof", "fixture-only-token");
  const request = (body: string, token?: string) => fetch(service.url, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  try {
    expect((await request("malformed unauthenticated input")).status).toBe(401);
    expect((await request("not json", "fixture-only-token")).status).toBe(400);
    expect((await request("null", "fixture-only-token")).status).toBe(400);
    expect((await request(JSON.stringify({ method: "tools/call", params: { name: "notion:list_pages", arguments: { query: "x".repeat(70_000) } } }), "fixture-only-token")).status).toBe(413);
    const wrong = await request(JSON.stringify({ id: 1, method: "tools/call", params: { name: "uninstalled-tool" } }), "fixture-only-token");
    expect((await wrong.json()).result.isError).toBe(true);
    const valid = await request(JSON.stringify({ id: 2, method: "tools/call", params: { name: "notion:list_pages" } }), "fixture-only-token");
    expect((await valid.json()).result).toEqual({ isError: false, content: [{ type: "text", text: "synthetic-service-proof" }] });
    expect(service.captures.filter(call => call.authorized && call.method === "tools/call")).toHaveLength(2);
  } finally { await service.close(); }
});
