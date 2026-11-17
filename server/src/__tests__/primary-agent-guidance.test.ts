import { expect, it, vi } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";
import { executeRunnerApi } from "../services/native-runtime/runner-api-client.js";
import { startOpenCodeMcpBridge } from "../../../packages/paperclip-runner/src/drivers/opencode/mcp-bridge.js";
import { searchApiAction } from "../../../packages/paperclip-runner/src/protocol-actions/search-api.js";

it("delivers personal primary profile guidance through actual API discovery and bounded OpenCode MCP output", async () => {
  const descriptor = searchApiAction.live.descriptor;
  let calls = 0;
  const bridge = await startOpenCodeMcpBridge({
    tools: [{ name: descriptor.operationId, description: descriptor.description, inputSchema: descriptor.inputSchema }],
    handler: async call => {
      expect(call.tool).toBe("search_api"); calls++;
      return { type: "inputText", text: JSON.stringify(searchRunnerApi(call.arguments)) };
    },
  });
  try {
    const response = await fetch(bridge.url, { method: "POST", headers: {
      Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: "primary-guidance", method: "tools/call",
      params: { name: "paperclip_search_api", arguments: { query: "set primary agent", limit: 2 } } }) });
    expect(response.status).toBe(200);
    const wire = await response.json() as { result: { isError?: boolean; content: Array<{ type: string; text: string }> } };
    expect(wire.result.isError).not.toBe(true);
    const controller = JSON.parse(wire.result.content[0]!.text) as { type: string; text: string };
    expect(controller.type).toBe("inputText");
    expect(Buffer.byteLength(JSON.stringify(controller))).toBeLessThan(500_000);
    const discovered = JSON.parse(controller.text) as ReturnType<typeof searchRunnerApi>;
    const operation = discovered.results.find(row => row.operationId === "PUT /api/companies/{companyId}/primary-agent/me");
    expect(operation).toBeDefined();
    expect(operation!.description).toMatch(/agent.{0,12}profile/i);
    expect(operation!.description).toContain("Set as my primary");
    expect(operation!.description).toMatch(/confirm.{0,30}replac/i);
    expect(operation!.description).toMatch(/chat picker.{0,70}does not change/i);
    expect(operation!.authorization.actor).toBe("board");
    expect(operation!.description).toContain("Agent credentials cannot access it");
    expect(operation!.requestBody?.content["application/json"].schema.properties.primaryAgentId).toMatchObject({ type: "string", format: "uuid" });
    expect(calls).toBe(1);
  } finally { await bridge.close(); }
});

it("keeps personal preference calls on the agent identity and preserves the board-only denial", async () => {
  const companyId = "00000000-0000-4000-8000-000000000111", runId = "00000000-0000-4000-8000-000000000112";
  const request = vi.fn<typeof fetch>(async () => Response.json({ error: "Board access required" }, { status: 403 }));
  const result = await executeRunnerApi({ operationId: "PUT /api/companies/{companyId}/primary-agent/me",
    body: { primaryAgentId: "00000000-0000-4000-8000-000000000113" } },
  { companyId, runId, issueId: "00000000-0000-4000-8000-000000000114", workMode: "standard" },
  { apiUrl: "https://paperclip.test", token: "synthetic-agent-only", fetch: request,
    readFile: async () => { throw new Error("No file read required"); },
    saveResponse: async () => { throw new Error("No capture required"); } });
  expect(result).toMatchObject({ ok: false, status: 403, data: { error: "Board access required" } });
  expect(request).toHaveBeenCalledOnce();
  const headers = new Headers(request.mock.calls[0]![1]?.headers);
  expect(headers.get("Authorization")).toBe("Bearer synthetic-agent-only");
  expect(headers.get("X-Paperclip-Run-Id")).toBe(runId);
});
