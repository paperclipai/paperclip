import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { reserveRunnerE2EDatabasePort } from "./ports.js";
import { runnerE2EWebServerGracefulShutdown } from "./web-server-command.js";

const require = createRequire(import.meta.url);

it("lets Playwright reap a restarted server through the production bounded shutdown policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-playwright-shutdown-"));
  const reservation = await reserveRunnerE2EDatabasePort(3100);
  const port = reservation.port;
  const supervisorPath = path.join(root, "supervisor.cjs");
  const workerPath = path.join(root, "worker.cjs");
  const stoppedPath = path.join(root, "stopped.json");
  const pidsPath = path.join(root, "pids.json");
  const configPath = path.join(root, "playwright.config.cjs");
  const testModule = require.resolve("@playwright/test");
  const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reservationReleased = false;
  try {
    await writeFile(workerPath, `
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        res.end(process.env.REVISION);
        if (req.url === '/restart') process.send('restart');
      });
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
      server.listen(${port}, '127.0.0.1');
    `);
    await writeFile(supervisorPath, `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      let stopping = false;
      let revision = 0;
      let child;
      const pids = [];
      function start() {
        child = spawn(process.execPath, [${JSON.stringify(workerPath)}], {
          env: { ...process.env, REVISION: String(++revision) },
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        pids.push(child.pid);
        fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify(pids));
        child.once('message', () => child.kill('SIGTERM'));
        child.once('exit', () => {
          if (!stopping) return start();
          fs.writeFileSync(${JSON.stringify(stoppedPath)}, JSON.stringify({ revision, pids }));
        });
      }
      process.on('SIGTERM', () => { stopping = true; child.kill('SIGTERM'); });
      start();
    `);
    await writeFile(configPath, `module.exports = {
      testDir: ${JSON.stringify(root)}, testMatch: 'shutdown.spec.cjs', workers: 1,
      reporter: 'line', timeout: 10000,
      webServer: {
        command: ${JSON.stringify(`"${process.execPath}" "${supervisorPath}"`)},
        url: 'http://127.0.0.1:${port}', timeout: 10000,
        gracefulShutdown: ${JSON.stringify(runnerE2EWebServerGracefulShutdown)},
      },
    };`);
    await writeFile(path.join(root, "shutdown.spec.cjs"), `
      const { test, expect } = require(${JSON.stringify(testModule)});
      test('restarts before teardown', async ({ request }) => {
        await request.get('http://127.0.0.1:${port}/restart');
        await expect.poll(async () => {
          try { return await (await request.get('http://127.0.0.1:${port}')).text(); }
          catch { return ''; }
        }).toBe('2');
      });
    `);
    await reservation.close();
    reservationReleased = true;
    child = spawn(process.execPath, [cli, "test", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1" },
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    const exit = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("exit", resolve);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Playwright cleanup stalled: ${output}`)), 20_000);
      }),
    ]);
    expect(exit, output).toBe(0);
    const stopped = JSON.parse(await readFile(stoppedPath, "utf8"));
    expect(stopped.revision).toBe(2);
    expect(stopped.pids).toHaveLength(2);
    for (const pid of stopped.pids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  } finally {
    if (timer) clearTimeout(timer);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    const pids: number[] = JSON.parse(await readFile(pidsPath, "utf8").catch(() => "[]"));
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ }
    }
    if (!reservationReleased) await reservation.close();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
