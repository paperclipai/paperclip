import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { issues } from "@paperclipai/db";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { documentService } from "../documents.js";

type Call = { tool: string; callId: string; arguments: unknown };
type StartBridge = (options: { tools: Array<Record<string, unknown>>; handler: (call: Call) => Promise<unknown> }) => Promise<{ url: string; secret: string; close(): Promise<void> }>;
const { startRunnerToolBridge } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/runner-tool-bridge.ts", import.meta.url).href) as { startRunnerToolBridge: StartBridge };
const { startOpenCodeMcpBridge } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/opencode/mcp-bridge.ts", import.meta.url).href) as { startOpenCodeMcpBridge: StartBridge };

let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
beforeAll(async () => {
  process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
  server = await startRunnerApiTestServer();
}, 60_000);
afterAll(async () => {
  await server?.close();
  if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
});

it.each([startRunnerToolBridge, startOpenCodeMcpBridge])("recovers task scope through MCP, HTTP routes, and saved documents (%#)", async start => {
  const fixture = await server.fixture({ disableWakeOnDemand: true });
  const service = documentService(server.db);
  const other = await service.upsertIssueDocument({ issueId: fixture.blockerId, key: "notes", title: "Other notes",
    format: "markdown", body: "Other task body", baseRevisionId: null });
  const foreignId = randomUUID();
  await server.db.insert(issues).values({ id: foreignId, companyId: fixture.foreignCompanyId, title: "Foreign task" });
  await service.upsertIssueDocument({ issueId: foreignId, key: "notes", title: "Foreign notes",
    format: "markdown", body: "Foreign company private body", baseRevisionId: null });
  expect((await service.getIssueDocumentByKey(foreignId, "notes"))?.body).toBe("Foreign company private body");
  const handler = vi.fn((call: Call) => fixture.authority.execute(call));
  const bridge = await start({ tools: fixture.authority.definitions(), handler });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(bridge.url, { method: "POST", headers: {
      Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
    const rpc = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return rpc.result;
  };
  try {
    for (const [tool, alternative] of [
      ["read_task_document", "read_document with {key}"], ["list_task_documents", "list_documents with {}"],
      ["get_task", "get_task_context with {}"], ["comment_on_task", "report_progress"], ["write_task_document", "write_document"],
    ]) {
      const rejected = await call(tool!, { key: "notes" });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0]!.text).toContain(alternative);
    }
    expect(handler).not.toHaveBeenCalled();
    const malformed = await call("read_task_document", { taskId: "not-a-uuid", key: "notes" });
    expect(malformed.isError).toBe(true);
    const read = await call("read_task_document", { taskId: fixture.blockerId, key: "notes" });
    expect(read.isError).not.toBe(true);
    expect(read.content[0]!.text).toContain(other.document.latestRevisionId);
    expect(read.content[0]!.text).toContain("Other task body");
    const active = await call("read_document", { key: "notes" });
    expect(active.isError).not.toBe(true);
    expect(active.content[0]!.text).toContain("silver-wren");
    expect(active.content[0]!.text).not.toContain("Other task body");
    const forbidden = await call("read_task_document", { taskId: foreignId, key: "notes" });
    expect(JSON.parse(forbidden.content[0]!.text)).toMatchObject({ ok: false, status: 404 });
    expect(forbidden.content[0]!.text).not.toContain("Foreign company private body");
    expect(forbidden.content[0]!.text).not.toContain("silver-wren");
    expect((await service.getIssueDocumentByKey(fixture.blockerId, "notes"))?.latestRevisionId).toBe(other.document.latestRevisionId);
  } finally { await bridge.close(); }
}, 30_000);
