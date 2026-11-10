import { createServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { listenOnFetchAllowedPort } from "../../e2e/fetch-allowed-port.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
/** A real read-only app holds its first tool response while the product retains the actual worker checkout. */
export async function startRunBriefGate(ctx: ChatCatalogContext, workerId: string) {
  const token = randomBytes(32).toString("hex"); ctx.input.privateSecrets?.push(token);
  const calls: Array<{ sequence: number; authorized: boolean; operation: string; receivedAt: string }> = [];
  let released = false; const pending: Array<{ response: ServerResponse; id: unknown }> = [];
  const reply = (response: ServerResponse, id: unknown, result: unknown) => { if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id, result })); } };
  const brief = { content: [{ type: "text", text: "The website brief is now available: Acorn Notes needs a semantic heading and an accessible signup link. For this prerequisite, record a short implementation note and complete the task. No website file or delivery is requested yet." }] };
  const server = createServer(async (request, response) => {
    try {
      let size = 0; const chunks: Buffer[] = []; for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error("Oversized app message"); chunks.push(chunk); }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const authorized = request.headers.authorization === `Bearer ${token}`;
      if (!authorized) { response.writeHead(401); response.end(); return; }
      if (message.method === "initialize") { reply(response, message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Website Brief", version: "1.0.0" } }); return; }
      if (message.method === "tools/list") { reply(response, message.id, { tools: [{ name: "read_website_brief", title: "Read website brief", description: "Read the authorized website task brief. The first read waits for its actual source to become available.", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }); return; }
      if (message.method === "tools/call" && message.params?.name === "read_website_brief") {
        calls.push({ sequence: calls.length + 1, authorized, operation: "read_website_brief", receivedAt: new Date().toISOString() });
        if (released) reply(response, message.id, brief); else pending.push({ response, id: message.id }); return;
      }
      response.writeHead(204); response.end();
    } catch { response.writeHead(400); response.end(); }
  });
  const port = await listenOnFetchAllowedPort(server); let connectionId: string | undefined;
  try {
    const root = `/api/companies/${ctx.input.fixtures.company.id}`;
    const connected = await ctx.input.api.postSensitive<{ connectionId: string; actions: { readOnly: Array<{ catalogEntryId: string }> } }>(`${root}/tools/apps/connect`, {
      link: `http://127.0.0.1:${port}/`, name: "Website Brief", authMode: "bearer", credentialValues: { "credentials.authorization": token }, grantKind: "organization",
    });
    connectionId = connected.connectionId; const reads = connected.actions.readOnly.map(row => row.catalogEntryId);
    if (reads.length !== 1) throw new Error("Website Brief discovery did not yield exactly its read-only action");
    await ctx.input.api.post(`${root}/tools/apps/${connectionId}/finish`, { enabledCatalogEntryIds: reads, askFirstCatalogEntryIds: [], access: { agentIds: [workerId] } });
    await ctx.input.api.putSensitive(`/api/tool-connections/${connectionId}/installs`, { installs: [{ targetType: "agent", targetId: workerId }] });
    return { connectionId, calls, release() { released = true; for (const item of pending.splice(0)) reply(item.response, item.id, brief); },
      async close() { for (const item of pending.splice(0)) item.response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await ctx.input.api.delete(`/api/tool-connections/${connectionId}`, { allowNotFound: true }); } };
  } catch (error) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); if (connectionId) await ctx.input.api.delete(`/api/tool-connections/${connectionId}`, { allowNotFound: true }); throw error; }
}
