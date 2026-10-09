/** Test-only external Speko transport. Paperclip routes/DB/permissions stay real. */
import { createServer } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";

type Tool = { id: string; name: string; source: { kind: string; url: string; secret: string }; [key: string]: unknown };
type Session = { id: string; agentId: string; token: string; endedAt: string | null; mode: "browser" | "outbound_phone" | "inbound_phone" };
export async function installSpekoTestProvider(origin: string, port: number) {
  const originalFetch = globalThis.fetch;
  const tools = new Map<string, Tool[]>(), sessions = new Map<string, Session>(), hooks = new Map<string, any>();
  let numberAgentId: string | null = null;
  const creditRejectedAgents = new Set<string>(), creationAttempts = new Map<string, number>();
  // The simulated external provider outlives an app restart, just as Speko does.
  // This file contains only deterministic fixture credentials, never a real key.
  const stateFile = resolve(process.env.PAPERCLIP_HOME!, "speko-fixture-state.json");
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    for (const [key, value] of state.tools) tools.set(key, value);
    numberAgentId = state.numberAgentId ?? null;
    for (const [key, value] of state.hooks ?? []) hooks.set(key, value);
    for (const [key, value] of state.sessions) sessions.set(key, value);
  }
  const persist = () => {
    writeFileSync(`${stateFile}.pending`, JSON.stringify({ tools: [...tools], sessions: [...sessions], hooks: [...hooks], numberAgentId }), { mode: 0o600 });
    renameSync(`${stateFile}.pending`, stateFile);
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://api.speko.dev") return originalFetch(input, init);
    if (new Headers(init?.headers).get("authorization") !== "Bearer fixture-speko-key") return json({ error: "fixture credential rejected" }, 401);
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/v1/phone-numbers" && method === "GET") return json([{id: "pn_fixture", organizationId: "org_fixture", e164: "+12015550123", label: "Fixture company line", agentId: numberAgentId, suspendedAt: null, direction: "both", setupStatus: {status: "ready", inboundReady: true, outboundReady: true, issues: []}}]);
    if (url.pathname === "/v1/phone-numbers/pn_fixture" && method === "PATCH") {numberAgentId = body.agentId; persist(); return json({id: "pn_fixture"});}
    if (url.pathname === "/v1/webhooks" && method === "GET") return json({data: [...hooks.values()].map(({signingSecret: _secret, ...hook}) => hook)});
    const hook = /^\/v1\/webhooks(?:\/([^/]+))?$/.exec(url.pathname);
    if (hook && ["POST", "PATCH"].includes(method)) {const id = hook[1] ?? `hook_${randomUUID()}`; hooks.set(id, {filterTags: {}, ...body, id}); persist(); return json({id});}
    const agent = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    if (agent && method === "GET") return json({ id: agent[1], organizationId: "org_fixture", name: "Fixture voice persona" });
    if (agent && method === "PATCH") return json({ id: agent[1] });
    const tool = /^\/v1\/agents\/([^/]+)\/tools(?:\/([^/]+))?$/.exec(url.pathname);
    if (tool) {
      const entries = tools.get(tool[1]) ?? [];
      if (method === "GET") return json(entries.map(({ source: { secret: _secret, ...source }, ...value }) => ({ ...value, source })));
      if (["POST", "PATCH"].includes(method)) {
        const id = tool[2] ?? `tool_${randomUUID()}`;
        tools.set(tool[1], [...entries.filter(entry => entry.id !== id), { ...body, id }]);
        persist();
        return json({ id });
      }
    }
    if (["/v1/sessions", "/v1/sessions/phone"].includes(url.pathname) && method === "POST") {
      creationAttempts.set(body.agentId, (creationAttempts.get(body.agentId) ?? 0) + 1);
      if (creditRejectedAgents.has(body.agentId)) return json({error: "private fixture provider detail", code: "INSUFFICIENT_CREDITS"},402);
      const id = randomUUID();
      sessions.set(id, { id, agentId: body.agentId, token: body.toolSecrets.paperclip_session_token, endedAt: null, mode: url.pathname.endsWith("/phone") ? "outbound_phone" : "browser" });
      persist();
      if (url.pathname.endsWith("/phone")) return json({ sessionId: id, status: "dialing" });
      return json({ sessionId: id, transportToken: `fixture:${id}`, transportUrl: "wss://speko-transport.invalid" });
    }
    const call = /^\/v1\/calls\/([^/]+)(\/end)?$/.exec(url.pathname);
    if (call) {
      const session = sessions.get(call[1]); if (!session) return json({ error: "unknown fixture call" }, 404);
      if (call[2] && method === "POST") { session.endedAt = new Date().toISOString(); persist(); return json({ status: "already_ended" }); }
      if (method === "GET") return json({ id: session.id, status: session.endedAt ? "ended" : "active", endedAt: session.endedAt, ended_at: session.endedAt, duration_seconds: session.endedAt ? 60 : null, report: session.endedAt ? {session_id: session.id, cost_micro_usd: "152340", updated_at: session.endedAt, transcript: {entries: [{id: "fixture-report-turn", index: 0, source: "user", text: "Fixture call transcript", started_at: session.endedAt, ended_at: session.endedAt}]} } : null, recording_resource_uri: "private-fixture-recording-do-not-fetch" });
    }
    throw new Error(`Unimplemented Speko fixture request: ${method} ${url.pathname}`);
  };
  const server = createServer(async (req, res) => {
    if (req.headers.origin !== origin) { res.writeHead(403).end(); return; }
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    if (req.method !== "POST" || req.url !== "/command") { res.writeHead(404).end(); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new Error("Fixture payload too large"); chunks.push(chunk); }
      const command = JSON.parse(Buffer.concat(chunks).toString());
      if (command.action === "credits_required") {
        if (command.enabled) creditRejectedAgents.add(command.agentId); else creditRejectedAgents.delete(command.agentId);
        res.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({creationAttempts: creationAttempts.get(command.agentId) ?? 0})); return;
      }
      if (command.action === "inbound") {
        const hook = [...hooks.values()].find(h => h.agentIds.includes(command.agentId) && h.events.includes("call.pre_call"));
        if (!hook || numberAgentId !== command.agentId) {res.writeHead(409).end(); return;}
        const id = randomUUID(), body = JSON.stringify({type: "call.pre_call", call_id: id, session_id: id, organization_id: "org_fixture", direction: "inbound", phone_number_id: "pn_fixture", dialed_number: "+12015550123", from: command.callerId ?? "+12015551234"});
        const timestamp = String(Math.floor(Date.now()/1000)), webhookId = `msg_${id}`;
        const signature = createHmac("sha256", Buffer.from(hook.signingSecret.slice(6), "base64")).update(`${webhookId}.${timestamp}.${body}`).digest("base64");
        const response = await originalFetch(`${origin}${new URL(hook.url).pathname}`, {method: "POST", headers: {"content-type": "application/json", "webhook-id": webhookId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}`}, body});
        const payload = await response.json() as any;
        if (!response.ok) {res.writeHead(response.status).end(JSON.stringify(payload)); return;}
        sessions.set(id, {id, agentId: command.agentId, token: payload.toolSecrets.paperclip_session_token, endedAt: null, mode: "inbound_phone"}); persist();
        res.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({sessionId: id, firstMessage: payload.firstMessage})); return;
      }
      const session = sessions.get(command.sessionId);
      const tool = session && tools.get(session.agentId)?.find(item => item.name === command.tool);
      if (!session || session.endedAt || !tool) { res.writeHead(404).end(); return; }
      const toolId = command.toolCallId ?? randomUUID();
      const body = JSON.stringify({ session_id: session.id, tool_call_id: toolId, idempotency_key: `${session.id}:${toolId}`, tool: command.tool, args: command.args });
      const timestamp = String(Math.floor(Date.now() / 1000)), webhookId = `msg_${toolId}`;
      const signature = createHmac("sha256", Buffer.from(tool.source.secret.slice(6), "base64")).update(`${webhookId}.${timestamp}.${body}`).digest("base64");
      // Only external transport is stubbed: enter the production signed route.
      const response = await originalFetch(`${origin}${new URL(tool.source.url).pathname}`, { method: "POST", headers: {
        "content-type": "application/json", "webhook-id": webhookId, "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`, authorization: `Bearer ${session.token}`,
      }, body });
      res.writeHead(response.status, { "content-type": "application/json" }).end(await response.text());
    } catch { res.writeHead(500).end(JSON.stringify({ error: "Fixture command failed" })); }
  }).listen(port, "127.0.0.1");
  await once(server, "listening");
  return async () => { globalThis.fetch = originalFetch; server.close(); server.closeAllConnections(); };
}
