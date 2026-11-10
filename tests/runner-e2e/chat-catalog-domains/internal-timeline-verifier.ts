import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { listenOnFetchAllowedPort } from "../../e2e/fetch-allowed-port.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { WorkspaceFileContent } from "../../../packages/shared/src/types/workspace-file-resource.js";
export interface VerificationReceipt { taskId: string; runId: string; filename: string; sha256: string; exitCode: number; checkedAt: string; command: string }
/** Real owned verification service: reads actual product workspace bytes, then executes a real bounded command. */
export async function startTimelineVerifier(ctx: ChatCatalogContext, taskId: string, agentIds: string[]) {
  if (!ctx.input.privateSecrets) throw new Error("Timeline verifier needs private credential redaction");
  const token = randomBytes(32).toString("hex"); ctx.input.privateSecrets.push(token);
  const key = await ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${agentIds[0]}/keys`, { name: `timeline-byte-reader-${ctx.input.nonce}` }); ctx.input.privateSecrets.push(key.token);
  const receipts: VerificationReceipt[] = []; let connectionId: string | undefined;
  const server = createServer(async (req, res) => {
    const reply = (id: unknown, result: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
    try {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0; for await (const part of req) { size += part.length; if (size > 65536) throw new Error("Oversized verifier request"); chunks.push(part); }
      const m = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (m.method === "initialize") { reply(m.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Launch verification", version: "1" } }); return; }
      if (m.method === "tools/list") { reply(m.id, { tools: [{ name: "verify_launch_html", description: "Run the real accessible-heading and labeled-email-input check on the current launch.html task workspace file. Returns the actual command exit code and byte digest.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } }] }); return; }
      if (m.method !== "tools/call" || m.params?.name !== "verify_launch_html") { res.writeHead(204); res.end(); return; }
      const get = async (path: string) => { const response = await fetch(new URL(path, ctx.input.api.baseURL), { headers: { Authorization: `Bearer ${key.token}` }, redirect: "error", signal: AbortSignal.timeout(15000) }); if (!response.ok) { await response.body?.cancel(); throw new Error("Verifier cannot read actual task workspace"); } return response.json(); };
      const checkout = async (expectedRunId?: string, expectedAgentId?: string) => {
        // Worker credentials remain limited to ordinary task access. Only the
        // trusted fixture reads the board-only file route after this live join.
        const current = await get(`/api/issues/${taskId}`) as { id?: string; companyId?: string; executionRunId?: string; assigneeAgentId?: string };
        const runs = await ctx.allRuns();
        const live = runs.find(run => run.id === current.executionRunId);
        if (current.id !== taskId || current.companyId !== ctx.input.fixtures.company.id || !current.executionRunId
          || !agentIds.includes(current.assigneeAgentId ?? "") || !live || live.companyId !== current.companyId
          || live.agentId !== current.assigneeAgentId || live.status !== "running" || live.runtimeMode !== "native"
          || (live.contextSnapshot?.issueId !== taskId && live.contextSnapshot?.taskId !== taskId)
          || expectedRunId !== undefined && current.executionRunId !== expectedRunId
          || expectedAgentId !== undefined && current.assigneeAgentId !== expectedAgentId)
          throw new Error("No actual authorized native task checkout");
        return { runId: current.executionRunId, agentId: current.assigneeAgentId! };
      };
      const current = await checkout();
      // Fixed owned task/file only: never pass board credentials to the model,
      // provider, worker bearer, or a caller-selected URL/path.
      const file = await ctx.input.api.get<WorkspaceFileContent>(`/api/issues/${taskId}/file-resources/content?workspace=execution&path=launch.html`);
      if (file.resource?.kind !== "file" || file.resource.title !== "launch.html" || file.resource.workspaceKind !== "execution_workspace"
        || !file.content || typeof file.content.data !== "string" || !["utf8", "base64"].includes(file.content.encoding))
        throw new Error("Verifier cannot read actual owned launch file");
      await checkout(current.runId, current.agentId);
      const bytes = file.content.encoding === "base64" ? Buffer.from(file.content.data, "base64") : Buffer.from(file.content.data);
      if (bytes.length > 262144) throw new Error("Oversized launch fixture");
      const script = "const s=Buffer.from(process.argv[1],'base64').toString();process.exit(/<h1[ >]/i.test(s)&&/<label[^>]*for=[\"']email[\"']/i.test(s)&&/<input[^>]*id=[\"']email[\"']/i.test(s)?0:1)";
      const exitCode = await new Promise<number>((resolve, reject) => execFile(process.execPath, ["-e", script, bytes.toString("base64")], { timeout: 10000, maxBuffer: 65536 }, error => { if (!error) resolve(0); else if (typeof error.code === "number") resolve(error.code); else reject(error); }));
      await checkout(current.runId, current.agentId);
      const receipt = { taskId, runId: current.runId, filename: "launch.html", sha256: createHash("sha256").update(bytes).digest("hex"), exitCode, checkedAt: new Date().toISOString(), command: "node accessible-heading-and-email-label-check" };
      receipts.push(receipt); reply(m.id, { content: [{ type: "text", text: JSON.stringify(receipt) }], isError: exitCode !== 0 });
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  let port: number;
  try { port = await listenOnFetchAllowedPort(server); }
  catch (error) { await ctx.input.api.delete(`/api/agents/${agentIds[0]}/keys/${key.id}`, { allowNotFound: true }); throw error; }
  try {
    const root = `/api/companies/${ctx.input.fixtures.company.id}`;
    const app = await ctx.input.api.postSensitive<{ connectionId: string; actions: { readOnly: { catalogEntryId: string }[] } }>(`${root}/tools/apps/connect`, { link: `http://127.0.0.1:${port}/`, name: "Launch verification", authMode: "bearer", credentialValues: { "credentials.authorization": token }, grantKind: "organization" }); connectionId = app.connectionId;
    if (app.actions.readOnly.length !== 1) throw new Error("Verification action was not discovered");
    await ctx.input.api.post(`${root}/tools/apps/${connectionId}/finish`, { enabledCatalogEntryIds: app.actions.readOnly.map(row => row.catalogEntryId), askFirstCatalogEntryIds: [], access: { agentIds } });
    await ctx.input.api.putSensitive(`/api/tool-connections/${connectionId}/installs`, { installs: agentIds.map(targetId => ({ targetType: "agent", targetId })) });
  } catch (error) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await ctx.input.api.delete(`/api/agents/${agentIds[0]}/keys/${key.id}`, { allowNotFound: true }); if (connectionId) await ctx.input.api.delete(`/api/tool-connections/${connectionId}`, { allowNotFound: true }); throw error; }
  return { receipts, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); try { if (connectionId) await ctx.input.api.delete(`/api/tool-connections/${connectionId}`, { allowNotFound: true }); } finally { await ctx.input.api.delete(`/api/agents/${agentIds[0]}/keys/${key.id}`, { allowNotFound: true }); } } };
}
