import { describe, it, expect, vi } from "vitest";
import { createToolDefinitions } from "./tools.js";
import { runWithBearer } from "./auth-context.js";

function clientReturning(body: unknown) {
  return { requestJson: vi.fn(async () => body) } as any;
}

describe("get_agent tool", () => {
  it("is registered as snake_case get_agent", () => {
    const tools = createToolDefinitions(clientReturning({}));
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_agent");
  });

  it("defaults agent_id to 'me' → GET /agents/me", async () => {
    const client = clientReturning({ id: "agent-me" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    const res = await runWithBearer("Bearer X", () => tool.execute({ agent_id: "me" }, {} as any));
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/me");
    expect(res.content[0].text).toContain("agent-me");
  });

  it("routes a concrete id to /agents/<id>", async () => {
    const client = clientReturning({ id: "abc" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await tool.execute({ agent_id: "abc" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/abc");
  });

  it("treats empty/whitespace agent_id as 'me'", async () => {
    const client = clientReturning({ id: "x" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await tool.execute({ agent_id: "   " }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/me");
  });

  it("URL-encodes a non-'me' agent_id path segment", async () => {
    const client = clientReturning({ id: "x" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await tool.execute({ agent_id: "a/b c" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/a%2Fb%20c");
  });
});
