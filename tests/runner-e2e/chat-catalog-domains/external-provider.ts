import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { listenOnFetchAllowedPort } from "../../e2e/fetch-allowed-port.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { root } from "./external-support.js";

export interface Tool { name: string; title: string; description: string; readOnly: boolean }
export interface ProviderCall { method: string; name?: string; authorized: boolean; arguments?: Record<string, unknown>; sequence: number; requestIdSha256?: string; responseHttpStatus?: number; toolError?: boolean; receivedAt?: number; respondedAt?: number; responseSha256?: string }
export function notesReadResponse(marker: string, unavailable: boolean) {
  return unavailable ? { isError: true, content: [{ type: "text", text: "Synthetic current checklist is unavailable; no current source verification was returned" }] }
    : { content: [{ type: "text", text: marker }] };
}
export async function startNotesProvider(marker: string, options: { nonDestructiveWrites?: boolean; readContent?: () => string } = {}) {
  const token = randomBytes(32).toString("hex");
  const calls: ProviderCall[] = []; let writeResult: string | undefined; let failWrites = false; let failReads = false;
  const tools: Tool[] = [
    { name: "launch_read", title: "Read launch page", description: "Read the synthetic launch page.", readOnly: true },
    { name: "launch_update", title: "Update launch page", description: "Write the synthetic launch update supplied by the user.", readOnly: false },
  ];
  const server = createServer(async (req, res) => {
    try {
      const parts: Buffer[] = []; let length = 0;
      for await (const part of req) { length += part.length; if (length > 65_536) throw new Error("Request too large"); parts.push(part); }
      const message = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
      const authorized = req.headers.authorization === `Bearer ${token}`;
      const call: ProviderCall = { method: message.method ?? "unknown", name: message.params?.name, authorized,
        arguments: message.params?.arguments, sequence: calls.length, requestIdSha256: createHash("sha256").update(String(message.id)).digest("hex"), receivedAt: Date.now() }; calls.push(call);
      if (!authorized) { res.writeHead(401); res.end(); return; }
      let result: unknown = {};
      if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "paperclip-eval-synthetic-notes", version: "1.0.0" } };
      if (message.method === "tools/list") result = { tools: tools.map(tool => ({ name: tool.name, title: tool.title, description: tool.description,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly && !options.nonDestructiveWrites }, inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false } })) };
      if (message.method === "tools/call") {
        const tool = tools.find(tool => tool.name === message.params?.name);
        if (!tool) result = { isError: true, content: [{ type: "text", text: "Unknown action" }] };
        else if (tool.readOnly) result = notesReadResponse(options.readContent?.() ?? marker, failReads);
        else if (!tool.readOnly && failWrites) result = { isError: true, content: [{ type: "text", text: "Synthetic write failed; page unchanged" }] };
        else { if (!tool.readOnly) writeResult = message.params?.arguments?.text;
          result = { content: [{ type: "text", text: tool.readOnly ? marker : `Saved synthetic launch update: ${writeResult ?? ""}` }] }; }
      }
      call.responseSha256 = createHash("sha256").update(JSON.stringify(result)).digest("hex"); call.responseHttpStatus = 200; call.toolError = !!(result as { isError?: boolean }).isError; call.respondedAt = Date.now();
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result }));
    } catch { res.writeHead(400); res.end(); }
  });
  const port = await listenOnFetchAllowedPort(server);
  return { url: `http://127.0.0.1:${port}/`, token, tools, calls,
    written: () => writeResult, failReads: () => { failReads = true; }, failWrites: () => { failWrites = true; }, allowWrites: () => { failWrites = false; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
export type NotesProvider = Awaited<ReturnType<typeof startNotesProvider>>;
export async function connectNotes(ctx: ChatCatalogContext, provider: NotesProvider, policy: "read-only" | "ask-first" | "all") {
  ctx.input.privateSecrets?.push(provider.token);
  const connection = await ctx.input.api.postSensitive<{ connectionId: string; actions: { readOnly: Array<{ catalogEntryId: string }>; canMakeChanges: Array<{ catalogEntryId: string }> } }>(`${root(ctx)}/tools/apps/connect`, {
    link: provider.url, name: "Synthetic Launch Notes", authMode: "bearer", credentialValues: { "credentials.authorization": provider.token }, grantKind: "organization",
  });
  const read = connection.actions.readOnly.map(row => row.catalogEntryId); const write = connection.actions.canMakeChanges.map(row => row.catalogEntryId);
  if (read.length !== 1 || write.length !== 1) throw new Error("Synthetic provider catalog did not preserve read/write classification");
  await ctx.input.api.post(`${root(ctx)}/tools/apps/${connection.connectionId}/finish`, { enabledCatalogEntryIds: policy === "read-only" ? read : [...read, ...write],
    askFirstCatalogEntryIds: policy === "ask-first" ? write : [], access: { agentIds: [ctx.input.fixtures.agent.id] } });
  await ctx.input.api.putSensitive(`/api/tool-connections/${connection.connectionId}/installs`, { installs: [{ targetType: "agent", targetId: ctx.input.fixtures.agent.id }] });
  return { connectionId: connection.connectionId, read, write };
}
