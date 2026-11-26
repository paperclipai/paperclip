import { expect, it, vi } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";
import { executeRunnerApi, validateRunnerApiCall } from "../services/native-runtime/runner-api-client.js";
import { startOpenCodeMcpBridge } from "../../../packages/paperclip-runner/src/drivers/opencode/mcp-bridge.js";
import { searchApiAction } from "../../../packages/paperclip-runner/src/protocol-actions/search-api.js";

const operationId = "POST /api/companies/{companyId}/skills/import";
const context = { companyId: "company-a", issueId: "issue-a", runId: "run-a", workMode: "standard" };

it("surfaces existing source import on the first discovery page and delivers its contract through MCP", async () => {
  const descriptor = searchApiAction.live.descriptor;
  let calls = 0;
  const bridge = await startOpenCodeMcpBridge({
    tools: [{ name: descriptor.operationId, description: descriptor.description, inputSchema: descriptor.inputSchema }],
    handler: async call => { calls++; return { type: "inputText", text: JSON.stringify(searchRunnerApi(call.arguments)) }; },
  });
  const body = JSON.stringify({ jsonrpc: "2.0", id: "source-import-discovery", method: "tools/call",
    params: { name: "paperclip_search_api", arguments: { query: "import skill from source SKILL.md", limit: 10 } } });
  try {
    const denied = await fetch(bridge.url, { method: "POST", headers: { Authorization: "Bearer wrong-synthetic-bridge-token", "Content-Type": "application/json" }, body });
    expect(denied.status).toBe(401); expect(calls).toBe(0);
    await denied.body?.cancel();
    const response = await fetch(bridge.url, { method: "POST", headers: {
      Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    }, body });
    expect(response.status).toBe(200);
    const wire = await response.json() as { result: { isError?: boolean; content: Array<{ type: string; text: string }> } };
    expect(wire.result.isError).not.toBe(true);
    const controller = JSON.parse(wire.result.content[0]!.text) as { type: string; text: string };
    expect(controller.type).toBe("inputText");
    expect(Buffer.byteLength(JSON.stringify(controller))).toBeLessThan(500_000);
    const discovered = JSON.parse(controller.text) as ReturnType<typeof searchRunnerApi>;
    const operation = discovered.results.find(row => row.operationId === operationId);
    expect(operation).toBeDefined();
    expect(operation!.description).toMatch(/SKILL\.md/i);
    expect(operation!.description).toMatch(/local.*director/i);
    expect(operation!.description).toMatch(/workspace.*managed/i);
    expect(operation!.description).toMatch(/source provenance/i);
    expect(operation!.authorization.actor).toBe("board_or_agent");
    expect(operation!.transport).toBe("rest");
    expect(operation!.requestBody?.content["application/json"].schema).toMatchObject({
      type: "object", required: ["source"], properties: { source: { type: "string", minLength: 1 } },
    });
    expect(calls).toBe(1);
  } finally { await bridge.close(); }
});

it("keeps exact non-import discovery and schema lookup intact", () => {
  const id = "DELETE /api/companies/{companyId}/skills/{skillId}";
  const result = searchRunnerApi({ query: id, limit: 10 });
  expect(result.results.map(row => row.operationId)).toEqual([id]);
  expect(result.nextCursor).toBeNull();
  expect(result.results[0]!.method).toBe("DELETE");
});

it("keeps foreign-company and read-only-mode import calls denied before dispatch", () => {
  const input = { operationId, body: { source: "/owned-company-workspace/example-skill" } };
  expect(() => validateRunnerApiCall({ ...input, pathParams: { companyId: "company-b" } }, context)).toThrow(/another company/);
  for (const workMode of ["ask", "planning"]) {
    expect(() => validateRunnerApiCall(input, { ...context, workMode })).toThrow(/only reads/);
  }
});

it("preserves the actual agent credential and source-policy denial returned by the route", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ error: "Skill import policy denied" }, { status: 403 }));
  const result = await executeRunnerApi({ operationId, body: { source: "/owned-company-workspace/example-skill" } }, context,
    { apiUrl: "https://paperclip.test", token: "synthetic-agent-only", fetch: request,
      readFile: async () => { throw new Error("No file read required"); },
      saveResponse: async () => { throw new Error("No capture required"); } });
  expect(result).toMatchObject({ ok: false, status: 403, data: { error: "Skill import policy denied" } });
  expect(request).toHaveBeenCalledOnce();
  const headers = new Headers(request.mock.calls[0]![1]?.headers);
  expect(headers.get("Authorization")).toBe("Bearer synthetic-agent-only");
  expect(headers.get("X-Paperclip-Run-Id")).toBe(context.runId);
});
