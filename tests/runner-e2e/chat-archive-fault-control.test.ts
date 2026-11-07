import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, chmod, realpath, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ARCHIVE_CONTROL_ENV, ARCHIVE_SCENARIO, archiveFaultClient, archiveServerEnvironment, startArchiveFaultControl } from "./chat-archive-fault-control.js";
import { buildPaperclipServerEnvironment } from "./harness-env.js";
import { reserveRunnerE2EServerPort } from "./ports.js";
const id = `chat-features.runner-codex-subscription.local.${ARCHIVE_SCENARIO}`;
it.each(["runner-codex-subscription", "runner-opencode"])("binds %s archive control to its own selected execution and private handoff", async profile => {
  const id = `chat-features.${profile}.local.${ARCHIVE_SCENARIO}`;
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-runner-e2e-"))); await mkdir(path.join(temporaryRoot, "selected-private-inputs"), { mode: 0o700 });
  const port = await reserveRunnerE2EServerPort(), backendOrigin = `http://127.0.0.1:${port}`, secrets: string[] = [];
  const control = await startArchiveFaultControl({ selected: [id], temporaryRoot, backendOrigin, privateSecrets: secrets });
  const binding = { companyId: randomUUID(), agentId: randomUUID(), personId: randomUUID(), taskIds: [randomUUID(), randomUUID(), randomUUID()] };
  let backendStarted = false; const runId = randomUUID();
  const backend = createServer((req, res) => {
    if (req.url === "/api/agents/me") { res.end(JSON.stringify({ id: binding.agentId, companyId: binding.companyId })); return; }
    if (req.url === `/api/heartbeat-runs/${runId}`) { res.end(JSON.stringify({ id: runId, agentId: binding.agentId, companyId: binding.companyId, responsibleUserId: binding.personId })); return; }
    res.end("owned offline backend");
  });
  try {
    const env = { [ARCHIVE_CONTROL_ENV]: control.filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: temporaryRoot };
    const server = await archiveServerEnvironment({ selected: [id], temporaryRoot, backendOrigin, env });
    expect(server.source[ARCHIVE_CONTROL_ENV]).toBeUndefined(); expect(server.overrides).toEqual({ PAPERCLIP_API_URL: control.proxyOrigin });
    const privateReceipt = JSON.parse(await readFile(control.filename, "utf8"));
    expect(JSON.stringify(server)).not.toContain(privateReceipt.token); expect(JSON.stringify(server)).not.toContain(privateReceipt.controlOrigin);
    const actualProductEnv = buildPaperclipServerEnvironment(server.source, server.overrides);
    expect(actualProductEnv.PAPERCLIP_API_URL).toBe(control.proxyOrigin);
    expect(JSON.stringify(actualProductEnv)).not.toContain(control.filename); expect(JSON.stringify(actualProductEnv)).not.toContain(privateReceipt.token); expect(JSON.stringify(actualProductEnv)).not.toContain(privateReceipt.controlOrigin);
    await new Promise<void>(resolve => backend.listen(port, "127.0.0.1", resolve)); backendStarted = true;
    expect(await (await fetch(`${control.proxyOrigin}/api/health`)).text()).toBe("owned offline backend");
    // A real separate Node test-host process reads the 0600 receipt; no bearer or
    // URL is in argv, stdout or the product environment.
    const script = path.join(temporaryRoot, "offline-client.mjs"), module = new URL("./chat-archive-fault-control.ts", import.meta.url).href;
    await writeFile(script, `import{archiveFaultClient}from${JSON.stringify(module)};const c=await archiveFaultClient({selected:${JSON.stringify(id)},backendOrigin:${JSON.stringify(backendOrigin)}});await c.arm(${JSON.stringify(binding)});console.log(JSON.stringify({originBound:c.backendOrigin===${JSON.stringify(backendOrigin)},receipts:await c.receipts()}));`, { mode: 0o600 });
    const child = await promisify(execFile)(process.execPath, ["--import", fileURLToPath(new URL("../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url)), script], { env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), ...env }, timeout: 10000 });
    expect(JSON.parse(child.stdout)).toEqual({ originBound: true, receipts: [] }); expect(child.stdout + child.stderr).not.toContain(privateReceipt.token); expect(child.stdout + child.stderr).not.toContain(privateReceipt.controlOrigin);
    const client = await archiveFaultClient({ selected: id, backendOrigin, env }); await expect(client!.arm(binding)).rejects.toThrow("control failed");
    await expect(client!.releaseForExplicitRetry()).rejects.toThrow("control failed");
    const response = await fetch(`${control.proxyOrigin}/api/issues/${binding.taskIds[0]}/inbox-archive`, { method: "POST", headers: { authorization: "Bearer offline-marker", "x-paperclip-run-id": runId }, body: JSON.stringify({ userId: binding.personId }) }); await response.text();
    expect(await client!.receipts()).toMatchObject([{ taskId: binding.taskIds[0], runId, forwarded: true, status: 200 }]);
    expect(JSON.stringify(await client!.receipts())).not.toContain("offline-marker");
    expect((await fetch(`${privateReceipt.controlOrigin}/receipts`, { method: "POST", body: "null" })).status).toBe(403);
    await expect(archiveFaultClient({ selected: id, backendOrigin: "http://127.0.0.1:1", env })).rejects.toThrow("another backend");
    await expect(archiveFaultClient({ selected: "unrelated", backendOrigin, env })).rejects.toThrow("exact selected");
    await chmod(control.filename, 0o644); await expect(archiveFaultClient({ selected: id, backendOrigin, env })).rejects.toThrow("unsafe"); await chmod(control.filename, 0o600);
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); backendStarted = false;
    await control.close(); await expect(readFile(control.filename)).rejects.toThrow(); await expect(fetch(`${control.proxyOrigin}/api/health`)).rejects.toThrow();
  } finally { if (backendStarted) { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); } await control.close(); await rm(temporaryRoot, { recursive: true, force: true }); }
});
it("fails closed for a missing selected handoff and rejects unrelated executions without starting resources", async () => {
  await expect(archiveFaultClient({ selected: id, backendOrigin: "http://127.0.0.1:12345", env: {} })).rejects.toThrow("missing");
  await expect(startArchiveFaultControl({ selected: ["other"], temporaryRoot: "/unowned", backendOrigin: "http://127.0.0.1:12345", privateSecrets: [] })).rejects.toThrow("allowlisted");
});

it("preserves a preexisting private receipt when exclusive creation fails", async () => {
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-runner-e2e-")));
  await mkdir(path.join(temporaryRoot, "selected-private-inputs"), { mode: 0o700 });
  const filename = path.join(temporaryRoot, "selected-private-inputs", "archive-fault.json");
  await writeFile(filename, "existing-owned-receipt", { mode: 0o600 });
  try {
    await expect(startArchiveFaultControl({ selected: [id], temporaryRoot, backendOrigin: "http://127.0.0.1:12345", privateSecrets: [] })).rejects.toThrow();
    expect(await readFile(filename, "utf8")).toBe("existing-owned-receipt");
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});
