import { expect, it } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";
import { startOpenCodeMcpBridge } from "../../../packages/paperclip-runner/src/drivers/opencode/mcp-bridge.js";
import { searchApiAction } from "../../../packages/paperclip-runner/src/protocol-actions/search-api.js";

it("discovers the existing secure human entry surface through native API search", async () => {
  const descriptor = searchApiAction.live.descriptor;
  const bridge = await startOpenCodeMcpBridge({
    tools: [{ name: descriptor.operationId, description: descriptor.description, inputSchema: descriptor.inputSchema }],
    handler: async call => ({ type: "inputText", text: JSON.stringify(searchRunnerApi(call.arguments)) }),
  });
  try {
    for (const query of ["company credential secret", "personal publishing credential"]) {
      const response = await fetch(bridge.url, { method: "POST", headers: {
        Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: query, method: "tools/call",
        params: { name: "paperclip_search_api", arguments: { query } } }) });
      expect(response.status).toBe(200);
      const wire = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(wire.result.isError).not.toBe(true);
      const controller = JSON.parse(wire.result.content[0]!.text) as { text: string };
      const discovered = JSON.parse(controller.text) as ReturnType<typeof searchRunnerApi>;
      const operations = discovered.results.filter(operation => operation.description.includes("/company/settings/secrets"));
      expect(operations.length, query).toBeGreaterThan(0);
      expect(operations.some(operation => /human|signed-in person/.test(operation.description))).toBe(true);
      expect(operations.some(operation => /never.*chat/i.test(operation.description))).toBe(true);
      if (query.startsWith("personal")) {
        const definitions = operations.find(operation => operation.path.endsWith("user-secret-definitions"));
        expect(definitions?.description).toContain("Set my value");
        expect(definitions?.description).toContain("current person");
        expect(definitions?.description).toContain("Company admins can also open definition details");
        expect(definitions?.description).toContain("other members use My secrets and Set my value");
        expect(definitions?.authorization.actor).toBe("board");
      }
    }
  } finally { await bridge.close(); }
});
