/** Explicit opt-in offline credential/reporting calibration; no real account/provider/DB. */
import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { privateClaudeOperation } from "./runtime-claude-private.js";
for (const branch of ["success", "private-child-failure", "parent-failure"] as const) test(`standalone Claude credential boundary ${branch}`, async () => {
  test.skip(!process.env.PAPERCLIP_CLAUDE_CANARY_PRIVATE_FILE, "Explicit synthetic-only privacy canary");
  const credential = `synthetic-claude-${randomUUID()}`, cookie = `synthetic-cookie-${randomUUID()}`;
  await appendFile(process.env.PAPERCLIP_CLAUDE_CANARY_PRIVATE_FILE!, `${credential}\n${cookie}\n`, { mode: 0o600 });
  const companyId = randomUUID(), environmentId = randomUUID(), connectionId = randomUUID(), grantId = randomUUID(); let keyObserved = false, cookieObserved = false;
  const server = createServer(async (req, res) => {
    cookieObserved ||= req.headers.cookie === `canary=${cookie}`;
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      const environment = { id: environmentId, driver: "local", status: "active" };
      res.end(JSON.stringify(req.url?.endsWith("/environments") ? [environment] : req.url?.includes("/environments/") ? environment : { id: companyId })); return;
    }
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    if (req.url?.endsWith("/ai-connections")) {
      keyObserved = body.apiKey === credential;
      if (branch === "private-child-failure") { res.statusCode = 500; res.end(JSON.stringify({ sensitiveDiagnostic: credential })); return; }
      res.end(JSON.stringify({ connectionId, grantId })); return;
    }
    res.end(JSON.stringify({ status: "pass", checks: [{ code: "synthetic_probe_receipt_only" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic canary did not bind");
  try {
    const operation = privateClaudeOperation({ operation: "prepare-account", credential, companyId, environmentId, harnessExecutable: "synthetic-command-never-executed", model: "synthetic-model-never-called", baseURL: `http://127.0.0.1:${address.port}`, cookies: [{ name: "canary", value: cookie, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }] });
    if (branch === "private-child-failure") await expect(operation).rejects.toThrow("diagnostics withheld");
    else { const receipt = await operation; expect(receipt.processIsolation).toBe(true); expect(receipt.testRunnerAttached).toBe(false); expect(receipt.probeStatus).toBe("pass"); }
    expect(keyObserved && cookieObserved).toBe(true);
    if (branch === "parent-failure") { test.fail(); throw new Error("Deliberate safe parent failure after standalone synthetic Claude credential request"); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
