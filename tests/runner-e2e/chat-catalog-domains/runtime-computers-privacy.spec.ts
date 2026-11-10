/** Opt-in synthetic UI/report sink calibration; no product DB, SSH, provider or native work. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import type { WebSocketServer as ServerType } from "ws";
const { WebSocketServer } = createRequire(new URL("../../../server/package.json", import.meta.url))("ws") as { WebSocketServer: typeof ServerType };
import { privateImagePreparation } from "./runtime-computers-image-private.js";
import { privateSshComputer } from "./runtime-computers-private.js";
for (const branch of ["success", "private-child-failure", "parent-failure"] as const) test(`standalone SSH UI privacy ${branch}`, async () => {
  test.skip(!process.env.PAPERCLIP_COMPUTER_CANARY_PRIVATE_FILE, "Explicit synthetic-only browser privacy calibration");
  const key = `synthetic-ssh-${randomUUID()}`, cookie = `synthetic-cookie-${randomUUID()}`, companyId = randomUUID(), environmentId = randomUUID();
  await appendFile(process.env.PAPERCLIP_COMPUTER_CANARY_PRIVATE_FILE!, `${key}\n${cookie}\n`, { mode: 0o600 });
  let saved: Record<string, unknown> = {}, keyObserved = false, cookieObserved = false;
  const server = createServer(async (req, res) => {
    cookieObserved ||= req.headers.cookie === `canary=${cookie}`;
    if (req.url?.includes("/company/settings/instance/environments/new")) {
      res.setHeader("content-type", "text/html"); res.end(`<form><div><div><label>Driver</label></div><select><option value="ssh">SSH</option></select></div>${["Name", "Host", "Port", "Username", "Remote workspace path", "Private key", "Known hosts"].map(x => `<div><div><label>${x}</label></div>${["Private key", "Known hosts"].includes(x) ? "<textarea></textarea>" : "<input>"}</div>`).join("")}<button>Create environment</button></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=[...document.querySelectorAll('input,textarea')].map(x=>x.value);await fetch('/api/companies/${companyId}/environments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f[0],config:{host:f[1],port:Number(f[2]),username:f[3],remoteWorkspacePath:f[4],privateKey:f[5],knownHosts:f[6],strictHostKeyChecking:true}})});};</script>`); return;
    }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") { let raw = ""; for await (const c of req) raw += c; saved = JSON.parse(raw); keyObserved = (saved.config as Record<string, unknown>).privateKey === key;
      if (branch === "private-child-failure") { res.statusCode = 500; res.end(JSON.stringify({ diagnostic: key })); return; } res.end(JSON.stringify({ id: environmentId })); return; }
    const row = { ...saved, id: environmentId, driver: "ssh", status: "active" }; res.end(JSON.stringify(req.url?.endsWith("/environments") ? [row] : row));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("Synthetic server unavailable");
  try {
    const pending = privateSshComputer({ operation: "create", baseURL: `http://127.0.0.1:${addr.port}`, companyId, companyPrefix: "QA", name: "Development server", host: "synthetic.invalid", port: 22, username: "synthetic", remoteWorkspacePath: "/owned/synthetic", knownHosts: "synthetic-public-host-key", privateKey: key, harness: "claude_local", cookies: [{ name: "canary", value: cookie, domain: "127.0.0.1", path: "/", expires: -1, secure: false, httpOnly: true, sameSite: "Lax" }] });
    if (branch === "private-child-failure") await expect(pending).rejects.toThrow("diagnostics withheld"); else { const receipt = await pending; expect(receipt.savedIdentityMatched).toBe(true); expect(receipt.testRunnerAttached).toBe(false); }
    expect(keyObserved && cookieObserved).toBe(true); if (branch === "parent-failure") { test.fail(); throw new Error("Deliberate safe synthetic parent failure after private SSH UI"); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const branch of ["success", "private-terminal-failure", "parent-failure"] as const) test(`standalone image terminal privacy ${branch}`, async () => {
  test.skip(!process.env.PAPERCLIP_COMPUTER_CANARY_PRIVATE_FILE, "Explicit synthetic-only terminal privacy calibration");
  const token = `synthetic-terminal-${randomUUID()}`, cookie = `synthetic-cookie-${randomUUID()}`, companyId = randomUUID(), environmentId = randomUUID(), sessionId = randomUUID(), templateId = randomUUID();
  await appendFile(process.env.PAPERCLIP_COMPUTER_CANARY_PRIVATE_FILE!, `${token}\n${cookie}\n`, { mode: 0o600 });
  let authenticated = false, commandObserved = false, promoted = false, cancelled = false;
  const session = () => ({ id: sessionId, environmentId, startedByUserId: "synthetic-human", startedByAgentId: null, status: promoted ? "promoted" : "waiting_for_user", promotedTemplateId: promoted ? templateId : null });
  const server = createServer(async (req, res) => {
    if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end("<html><body>Synthetic operator origin</body></html>"); return; }
    for await (const _ of req) { /* synthetic operator requests only */ }
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("terminal-session-token")) res.end(JSON.stringify({ id: randomUUID(), token, setupSessionId: sessionId, environmentId, websocketPath: "/synthetic-terminal", connectionType: "ssh" }));
    else if (req.url?.includes("/finish")) { promoted = true; res.end(JSON.stringify({ session: session(), template: { id: templateId, environmentId, status: "active", templateRef: "synthetic-immutable-provider-id", capturedAt: new Date().toISOString(), createdByUserId: "synthetic-human", createdByAgentId: null } })); }
    else if (req.url?.includes("/cancel")) { cancelled = true; res.end("{}"); }
    else res.end(JSON.stringify(req.method === "GET" ? session() : { session: session() }));
  });
  const wss = new WebSocketServer({ server }); wss.on("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "auth") { authenticated = frame.token === token; ws.send(JSON.stringify(branch === "private-terminal-failure" ? { type: "error", message: token } : { type: "ready" })); }
    if (frame.type === "input") { commandObserved = /node --version && npm --version && git --version/.test(frame.data); const nonce = /'([a-f0-9]{24})'/.exec(frame.data)?.[1]; ws.send(JSON.stringify({ type: "output", data: `v22.0.0\n10.0.0\ngit version 2.0.0\n__PC_${nonce}_TOOLS_OK__\n` })); }
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("Synthetic terminal unavailable");
  try {
    const pending = privateImagePreparation({ baseURL: `http://127.0.0.1:${addr.port}`, companyId, environmentId, cookies: [{ name: "canary", value: cookie, domain: "127.0.0.1", path: "/", expires: -1, secure: false, httpOnly: true, sameSite: "Lax" }] });
    if (branch === "private-terminal-failure") { await expect(pending).rejects.toThrow("diagnostics withheld"); expect(cancelled).toBe(true); }
    else { const receipt = await pending; expect(receipt.actualToolsVerified && receipt.promoted && commandObserved).toBe(true); }
    expect(authenticated).toBe(true); if (branch === "parent-failure") { test.fail(); throw new Error("Deliberate safe synthetic parent failure after private operator terminal"); }
  } finally { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const foreign of [false, true]) test(`saved Morgan runtime binding ${foreign ? "foreign denied" : "exact Codex target"}`, async () => {
  test.skip(!process.env.PAPERCLIP_COMPUTER_CANARY_PRIVATE_FILE, "Explicit synthetic-only saved runtime calibration");
  const companyId = randomUUID(), environmentId = randomUUID(), agentId = randomUUID(), key = `synthetic-ssh-${randomUUID()}`, cookie = `synthetic-cookie-${randomUUID()}`;
  await appendFile(process.env.PAPERCLIP_COMPUTER_CANARY_PRIVATE_FILE!, `${key}\n${cookie}\n`, { mode: 0o600 });
  let actualCodexSavedConfig = false;
  const config = { host: "synthetic.invalid", port: 22, username: "synthetic", remoteWorkspacePath: "/owned/synthetic", knownHosts: "synthetic-public-key", strictHostKeyChecking: true };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const env = { id: environmentId, name: "Development server", driver: "ssh", status: "active", config };
    if (req.method === "GET") { res.end(JSON.stringify(req.url?.includes(`/agents/${agentId}`) ? { id: agentId, companyId: foreign ? randomUUID() : companyId, adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "synthetic-saved-model" }, runtimeConfig: { aiConnection: { provider: "openai", mode: "responsible_user" } } } : req.url?.endsWith("/environments") ? [env] : env)); return; }
    let raw = ""; for await (const c of req) raw += c; const body = JSON.parse(raw);
    if (req.url?.includes("test-environment")) { actualCodexSavedConfig = req.url.includes("/adapters/paperclip_runner/") && body.agentId === agentId && body.environmentId === environmentId && body.adapterConfig.provider === "codex" && body.adapterConfig.model === "synthetic-saved-model" && body.aiConnection.mode === "responsible_user" && body.runner === undefined; res.end(JSON.stringify({ status: "pass", checks: [{ code: "synthetic_saved_runtime" }] })); }
    else res.end(JSON.stringify({ ok: true, driver: "ssh", summary: "synthetic transport", details: {} }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("Synthetic runtime unavailable");
  try {
    const pending = privateSshComputer({ operation: "probe", baseURL: `http://127.0.0.1:${addr.port}`, companyId, companyPrefix: "QA", environmentId, agentId, name: "Development server", ...config, privateKey: key, harness: "saved-agent", cookies: [{ name: "canary", value: cookie, domain: "127.0.0.1", path: "/", expires: -1, secure: false, httpOnly: true, sameSite: "Lax" }] });
    if (foreign) { await expect(pending).rejects.toThrow("diagnostics withheld"); expect(actualCodexSavedConfig).toBe(false); }
    else { const r = await pending; expect(r.agentId === agentId && r.selectedHarness === "codex_local" && actualCodexSavedConfig).toBe(true); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
