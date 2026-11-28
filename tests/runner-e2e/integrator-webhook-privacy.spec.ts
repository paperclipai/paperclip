/** Explicit offline canary only; normal runner testMatch excludes this file. */
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { finishPrivateWebhook } from "./chat-catalog-domains/integrator-webhook-private.js";
const routineId = "11111111-1111-4111-8111-111111111111", triggerId = "22222222-2222-4222-8222-222222222222", invocationId = "33333333-3333-4333-8333-333333333333", issueId = "44444444-4444-4444-8444-444444444444";
test("isolated webhook child keeps synthetic cookie and one-time key out of actual Test reporters", async () => {
  const input = JSON.parse(await readFile(process.env.PAPERCLIP_OFFLINE_API_CANARY_INPUT!, "utf8")) as { cookie: string; credential: string };
  let invoked = false, finished = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === `/api/routine-triggers/${triggerId}/rotate-secret`) { json(200, { secretMaterial: { webhookSecret: input.credential, webhookUrl: `http://${req.headers.host}/api/routine-triggers/public/synthetic/fire` } }); return; }
    if (url.pathname === `/api/routine-triggers/${triggerId}` && req.method === "PATCH") { finished = true; json(200, {}); return; }
    if (url.pathname === `/api/routines/${routineId}/runs`) { json(200, invoked ? [{ id: invocationId }] : []); return; }
    if (url.pathname === "/api/routine-triggers/public/synthetic/fire") { if (req.headers.authorization !== `Bearer ${input.credential}`) { json(401, {}); return; } if (!finished) { json(202, { status: "test_received" }); return; } invoked = true; json(202, { id: invocationId, linkedIssueId: issueId }); return; }
    res.writeHead(200, { "content-type": "text/html" }); res.end(`<button id="generate">Generate new key</button><code hidden></code><button id="check">Check connection</button><button id="finish" hidden>Finish without checking</button><script>document.querySelector('#generate').onclick=async()=>{const r=await fetch('/api/routine-triggers/${triggerId}/rotate-secret',{method:'POST'});const b=await r.json();const c=document.querySelector('code');c.textContent=b.secretMaterial.webhookSecret;c.hidden=false};document.querySelector('#check').onclick=()=>document.querySelector('#finish').hidden=false;document.querySelector('#finish').onclick=()=>fetch('/api/routine-triggers/${triggerId}',{method:'PATCH'});</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic loopback address missing");
    let registered = false;
    const receipt = await finishPrivateWebhook({ baseURL: `http://127.0.0.1:${address.port}`, route: `/ACN/routines/${routineId}`, routineId, triggerId, setupPending: true, signingMode: "bearer", nonce: "synthetic-only", cookies: [{ name: "session", value: input.cookie, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }] }, value => { registered = value === input.credential; });
    expect(registered && receipt.invalidStatus === 401 && receipt.validStatus === 202 && !receipt.invalidCreatedInvocation && receipt.processIsolation && !receipt.testRunnerAttached).toBe(true);
    // Deliberate ordinary Test failure exercises stdout/JUnit/blob/HTML sinks.
    throw new Error("Controlled offline webhook privacy failure; no private values in diagnosis");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
