import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createRunnerE2EServerStopper } from "./server-stop.js";
import { createProcessTreeOwner } from "./process-tree-owner.js";
import { readProcessTable } from "./process-tree.js";
import { readLinuxProcessStartedAt } from "../../packages/paperclip-runner/src/live/linux-process-start.js";

it.skipIf(process.platform === "win32")("keeps the real admitted daemon and child alive across controller exit, then drains both controller generations", async () => {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "pc-restart-owner-"));
  const daemon = "/bin/sh";
  const fixtureDaemons = new Set<number>();
  const entry = path.join(directory, "controller.cjs");
  const stop = createRunnerE2EServerStopper({ gracefulTimeoutMs: 3000, forcedTimeoutMs: 2000,
    hasSpawnError: () => false, markExpectedStop: () => {}, log: () => {},
    // Only the fixture's declared role is synthetic. PID, start, ancestry,
    // groups, observation and signal delivery all use the real kernel table.
    createOwner: child => createProcessTreeOwner(child, { readTable: async () => {
      const table = await readProcessTable();
      return table?.map(row => fixtureDaemons.has(row.pid) && row.kind === "sh" ? { ...row, kind: "paperclip-runnerd" } : row) ?? null;
    } }),
  });
  const closed: Promise<void>[] = [];
  try {
    // This is a tiny inert process-role fixture, not a provider or real daemon.
    await writeFile(entry, `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const marker = ${JSON.stringify(path.join(directory, "child-ready"))} + process.pid;
      const daemon = spawn(${JSON.stringify(daemon)}, ['-c', ${JSON.stringify("trap 'exit 0' TERM; /bin/sleep 600 & printf '%s' \"$!\" > \"$1\"; wait")}, 'fixture', marker], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let daemonError = ''; daemon.stderr.on('data', chunk => { daemonError += chunk; });
      daemon.once('exit', (code, signal) => { if (process.connected) process.send({ failure: { code, signal, stderr: daemonError } }); });
      const background = spawn('/bin/sleep', ['600'], { detached: true, stdio: 'ignore' });
      process.on('SIGTERM', () => process.exit(0));
      const ready = setInterval(() => {
        if (fs.existsSync(marker)) { clearInterval(ready); process.send({ daemon: daemon.pid, background: background.pid }); }
      }, 10);
      setInterval(() => {}, 1000);
    `);
    const start = async () => {
      const child = spawn(process.execPath, [entry], { detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      closed.push(new Promise(resolve => child.once("close", () => resolve())));
      const message = once(child, "message");
      await stop.watch(child);
      const result = (await message)[0];
      expect(result.failure, JSON.stringify(result)).toBeUndefined();
      fixtureDaemons.add(result.daemon);
      return { child, ids: result as { daemon: number; background: number } };
    };
    const first = await start();
    const before = await readProcessTable();
    expect(before).not.toBeNull();
    const runner = before!.find(row => row.pid === first.ids.daemon)!;
    expect(runner.kind).toBe("sh");
    const descendants = before!.filter(row => row.parentPid === runner.pid);
    expect(descendants.length).toBeGreaterThan(0);
    await stop.forRestart(first.child, { processPid: runner.pid, processGroupId: runner.processGroupId,
      processStartedAt: process.platform === "linux" ? readLinuxProcessStartedAt(runner.pid) : new Date(runner.started).toISOString() });
    const after = await readProcessTable();
    expect(after!.find(row => row.pid === runner.pid)?.started).toBe(runner.started);
    for (const descendant of descendants) expect(after!.find(row => row.pid === descendant.pid)?.started).toBe(descendant.started);
    expect(after!.some(row => row.pid === first.ids.background && !row.state?.startsWith("Z"))).toBe(false);
    const second = await start();
    await stop.stopAll(); await Promise.all(closed);
    const final = await readProcessTable();
    const expectedGone = [first.child.pid, first.ids.daemon, first.ids.background, ...descendants.map(row => row.pid),
      second.child.pid, second.ids.daemon, second.ids.background];
    expect(final!.filter(row => expectedGone.includes(row.pid) && !row.state?.startsWith("Z"))).toEqual([]);
  } finally {
    try { await stop.stopAll(); await Promise.all(closed); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}, 15000);
