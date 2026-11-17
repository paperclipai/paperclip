import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { readRecoveredFeedback } from "./feedback-recovery.js";
import { runnerE2EWebServerCommand, runnerE2EPlaywrightInvocation, runnerE2EWebServerGracefulShutdown, runnerE2EPlaywrightShutdownSignal } from "./web-server-command.js";
import { createProcessTreeOwner, stopOwnedProcessTree } from "./process-tree-owner.js";

it.skipIf(process.platform === "win32")("retains feedback before shutdown through the real Playwright launch chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval feedback 'shutdown-"));
  const repository = path.resolve(import.meta.dirname, "../..");
  const caseDirectory = path.join(root, "case");
  const identity = { campaignId: "campaign", attemptId: "attempt", executionId: "execution" };
  const companyId = "88c1939b-2d9f-4bb3-8ebc-8a7a85efeeac";
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let supervisorPid: number | undefined;
  let owner: ReturnType<typeof createProcessTreeOwner> | undefined;
  try {
    await mkdir(path.join(root, "tests/runner-e2e"), { recursive: true });
    await mkdir(path.join(caseDirectory, "snapshots"), { recursive: true });
    await symlink(path.join(repository, "cli"), path.join(root, "cli"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(path.join(caseDirectory, "snapshots/fixtures.json"), JSON.stringify({ executionId: identity.executionId, companyId }));
    await writeFile(path.join(root, "tests/runner-e2e/server.ts"), `
      import { createServer } from 'node:http';
      import { writeFile } from 'node:fs/promises';
      import { recoverInterruptedFeedback } from ${JSON.stringify(pathToFileURL(path.join(repository, "tests/runner-e2e/feedback-recovery.ts")).href)};
      const entries = ['complaint', 'suggestion'].map(kind => ({ id: kind, kind, runId: 'run', body: 'Saved ' + kind + ' private-canary-value' }));
      const server = createServer((req, res) => {
        setTimeout(() => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(req.url.includes('agent-commentary?') ? { items: entries, total: 2 }
            : req.url.includes('agent-commentary/') ? entries.find(entry => req.url.endsWith('/' + entry.id))
            : req.url.endsWith('/heartbeat-runs/run') ? { id: 'run', runtimeMode: 'native', status: 'running' }
            : req.url.includes('heartbeat-runs?') ? [{ id: 'run' }] : []));
        }, 100);
      });
      let closing;
      process.on('SIGTERM', () => closing ??= (async () => {
        await recoverInterruptedFeedback({ identity: ${JSON.stringify(identity)}, caseDirectory: ${JSON.stringify(caseDirectory)},
          deadlineAt: Date.now() + 5000, secrets: ['private-canary-value'], api: {
            async get(endpoint, options) {
              return (await fetch('http://127.0.0.1:' + server.address().port + endpoint,
                { signal: AbortSignal.timeout(options?.timeout ?? 1000) })).json();
            }
          } });
        server.close();
        server.closeAllConnections();
      })());
      server.listen(0, '127.0.0.1', async () => {
        await writeFile(${JSON.stringify(path.join(root, "ready.json"))}, JSON.stringify({ pid: process.pid }));
        console.log('SUPERVISOR_READY');
      });
    `);
    const testModule = createRequire(import.meta.url).resolve("@playwright/test");
    const configPath = path.join(root, "playwright.config.cjs");
    await writeFile(configPath, `module.exports = {
      testDir: ${JSON.stringify(root)}, testMatch: 'interrupted.spec.cjs', workers: 1, reporter: 'line', timeout: 30000,
      webServer: { command: ${JSON.stringify(runnerE2EWebServerCommand(root))},
        wait: { stdout: /SUPERVISOR_READY/ }, timeout: 10000,
        gracefulShutdown: ${JSON.stringify(runnerE2EWebServerGracefulShutdown)} }
    };`);
    await writeFile(path.join(root, "interrupted.spec.cjs"), `
      const { test } = require(${JSON.stringify(testModule)});
      const { writeFile } = require('node:fs/promises');
      test('interrupted worker', async () => {
        await writeFile(${JSON.stringify(path.join(root, "worker-ready"))}, 'ready');
        await new Promise(() => {});
      });
    `);
    const invocation = runnerE2EPlaywrightInvocation(repository, ["test", "--config", configPath]);
    child = spawn(invocation.command, invocation.args, { cwd: repository, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    owner = createProcessTreeOwner(child);
    let output = "";
    child.stdout!.on("data", chunk => { output += chunk; });
    child.stderr!.on("data", chunk => { output += chunk; });
    const closed = new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", () => resolve());
    });
    const deadline = Date.now() + 10_000;
    let workerReady = false;
    while ((!supervisorPid || !workerReady) && Date.now() < deadline) {
      const ready = await readFile(path.join(root, "ready.json"), "utf8").catch(() => null);
      if (ready) supervisorPid = JSON.parse(ready).pid;
      workerReady = await readFile(path.join(root, "worker-ready"), "utf8").then(() => true, () => false);
      if (!supervisorPid || !workerReady) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(supervisorPid, output).toBeTypeOf("number");
    expect(workerReady, output).toBe(true);
    await stopOwnedProcessTree(child, owner, 10_000, 2_000, runnerE2EPlaywrightShutdownSignal);
    await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Shutdown did not finish: ${output}`)), 10_000);
    })]);
    expect(await readRecoveredFeedback(caseDirectory, identity), output).toMatchObject({
      collection: "partial", invocationCollection: "partial", complaints: 1, suggestions: 1, bodiesCollected: 2,
    });
    const evidence = await readFile(path.join(caseDirectory, "snapshots/agent-feedback-recovered.json"), "utf8");
    expect(evidence).toContain("Saved complaint");
    expect(evidence).not.toContain("private-canary-value");
    expect(() => process.kill(supervisorPid!, 0)).toThrow();
  } finally {
    owner?.stopObserving();
    if (timer) clearTimeout(timer);
    if (owner) await owner.signal("SIGKILL").catch(() => {});
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
