import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRunnerE2EServerStopper, runnerE2EServerDetached } from "./server-stop.js";
import { readProcessTable } from "./process-tree.js";
import { createProcessTreeOwner, stopOwnedProcessTree } from "./process-tree-owner.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";

const children: ChildProcess[] = [];
const directories: string[] = [];
const worker = `
  process.once('SIGTERM', () => {
    process.send('stopping');
    process.once('message', () => {
      process.send('close-complete', () => process.exit(0));
    });
  });
  process.send('ready');
  setInterval(() => {}, 1000);
`;
async function fixture(source = worker) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-server-stop-"));
  directories.push(root);
  const entry = path.join(root, "worker.cjs");
  await writeFile(entry, source);
  return { root, entry };
}
function start(entry: string) {
  const child = spawn(process.execPath, [entry], {
    detached: runnerE2EServerDetached,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return child;
}
function stopper(gracefulTimeoutMs = 2_000) {
  const logs: string[] = [];
  const errors = new WeakSet<ChildProcess>();
  const stop = createRunnerE2EServerStopper({
    gracefulTimeoutMs, forcedTimeoutMs: 2_000,
    hasSpawnError: child => errors.has(child),
    markExpectedStop: () => {}, log: line => logs.push(line),
  });
  return { stop, logs, errors };
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit").catch(() => {});
    try {
      if (runnerE2EServerDetached && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { child.kill("SIGKILL"); }
    await exited;
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")("joins signal, final cleanup and repeated calls while a once-handler finishes asynchronous close", async () => {
  const { entry } = await fixture();
  const child = start(entry);
  expect((await once(child, "message"))[0]).toBe("ready");
  const { stop, logs } = stopper();
  const stopping = once(child, "message");
  const first = stop(child);
  expect((await stopping)[0]).toBe("stopping");
  // The server supervisor reaches final cleanup after its 200ms poll.
  await new Promise(resolve => setTimeout(resolve, 250));
  const messages: unknown[] = [];
  child.on("message", message => messages.push(message));
  const finalCleanup = stop(child);
  const repeated = stop(child, "SIGINT");
  // Give an erroneous repeated signal time to interrupt the held close before
  // releasing it. A behavioral failure must not depend on promise identity.
  await new Promise(resolve => setTimeout(resolve, 50));
  if (child.connected) child.send("finish");
  await Promise.all([first, finalCleanup, repeated]);
  expect(messages).toContain("close-complete");
  expect([child.exitCode, child.signalCode]).toEqual([0, null]);
  expect(finalCleanup).toBe(first);
  expect(repeated).toBe(first);
  expect(stop(child)).toBe(first);
  await stop(child);
  expect(logs).toEqual([]);
});

it.skipIf(process.platform === "win32")("bounds an unresponsive child and reaps it with one escalation", async () => {
  const { entry } = await fixture(`process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`);
  const child = start(entry);
  await once(child, "message");
  const { stop, logs } = stopper(50);
  await Promise.all([stop(child), stop(child), stop(child)]);
  expect(child.signalCode).toBe("SIGKILL");
  expect(logs).toHaveLength(1);
  expect(() => process.kill(child.pid!, 0)).toThrow();
});

it("settles an already-exited child without signals or escalation", async () => {
  const { entry } = await fixture("process.exit(0)");
  const child = start(entry);
  await once(child, "exit");
  const { stop, logs } = stopper();
  await stop(child);
  expect([child.exitCode, child.signalCode, logs]).toEqual([0, null, []]);
});

it("settles a failed spawn without attempting escalation", async () => {
  const { root } = await fixture();
  const child = spawn(path.join(root, "missing-server-executable"));
  const { stop, logs, errors } = stopper();
  child.once("error", () => errors.add(child));
  await new Promise<void>(resolve => child.once("error", () => resolve()));
  await stop(child);
  expect(logs).toEqual([]);
});

it.skipIf(process.platform === "win32")("lets launcher cancellation join wrapper shutdown without signaling the server twice", async () => {
  const { root, entry } = await fixture();
  const supervisor = path.join(root, "supervisor.mts");
  const helper = path.join(import.meta.dirname, "server-stop.ts");
  await writeFile(supervisor, `
    import { spawn } from 'node:child_process';
    import { createRunnerE2EServerStopper, runnerE2EServerDetached } from ${JSON.stringify(helper)};
    const child = spawn(process.execPath, [${JSON.stringify(entry)}], {
      detached: runnerE2EServerDetached, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const stop = createRunnerE2EServerStopper({ gracefulTimeoutMs: 2000, forcedTimeoutMs: 2000,
      hasSpawnError: () => false, markExpectedStop: () => {}, log: () => {} });
    const finish = () => { void stop(child).then(() => {
      process.send!({ exitCode: child.exitCode, signalCode: child.signalCode }, () => process.exit(0));
    }); };
    process.on('SIGTERM', finish);
    process.on('message', message => { if (message === 'stop') finish(); else child.send('finish'); });
    child.on('message', message => process.send!({ message, pid: child.pid }));
  `);
  const wrapper = spawn(process.execPath, runnerE2ETypeScriptProcessArgs(path.resolve(import.meta.dirname, "../.."), supervisor), {
    detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(wrapper);
  let wrapperErrors = "";
  wrapper.stderr?.on("data", chunk => { wrapperErrors += chunk; });
  let workerPid: number | undefined;
  const owner = createProcessTreeOwner(wrapper);
  try {
    workerPid = (await once(wrapper, "message"))[0].pid;
    const stopping = once(wrapper, "message");
    wrapper.send("stop");
    expect((await stopping)[0].message).toBe("stopping");
    // If Paperclip shared the wrapper group, this would kill its once-handler
    // during the async close even though the helper sends only one signal.
    const messages: unknown[] = [];
    wrapper.on("message", message => messages.push(message));
    const exited = once(wrapper, "exit");
    await owner.observe();
    const cancellation = stopOwnedProcessTree(wrapper, owner, 2_000, 2_000);
    await new Promise(resolve => setTimeout(resolve, 250));
    if (wrapper.connected) wrapper.send("finish");
    await exited;
    await cancellation;
    expect(messages, wrapperErrors).toContainEqual({ message: "close-complete", pid: workerPid });
    expect(messages).toContainEqual({ exitCode: 0, signalCode: null });
    expect(() => process.kill(workerPid!, 0)).toThrow();
  } finally {
    owner.stopObserving();
    if (workerPid) { try { process.kill(-workerPid, "SIGKILL"); } catch { /* reaped */ } }
  }
});


it.skipIf(process.platform === "win32")("escalates the owned server group so a hung descendant cannot remain", async () => {
  const { entry } = await fixture(`
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.on('SIGTERM', () => {});
    process.send({ pid: descendant.pid });
    setInterval(() => {}, 1000);
  `);
  const child = start(entry);
  const pid = (await once(child, "message"))[0].pid as number;
  try {
    await stopper(50).stop(child);
    expect(child.signalCode).toBe("SIGKILL");
    // A stopped orphan may remain a zombie until the host's init reaps it.
    const table = await readProcessTable();
    expect(table).not.toBeNull();
    expect(table!.some(row => row.pid === pid && !row.state?.startsWith("Z"))).toBe(false);
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* reaped */ }
  }
});


it.skipIf(process.platform === "win32")("retires observed descendants after the server leader exits early", async () => {
  const { root, entry } = await fixture();
  const marker = path.join(root, "descendant-closed");
  const descendant = `
    process.once('SIGTERM', () => setTimeout(() => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'closed'); process.exit(0);
    }, 50));
    process.send('ready'); setInterval(() => {}, 1000);
  `;
  await writeFile(entry, `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.once('message', () => process.send({ pid: child.pid }));
    process.once('message', () => process.exit(1));
  `);
  const child = start(entry);
  const pid = (await once(child, "message"))[0].pid as number;
  const { stop } = stopper();
  try {
    await stop.watch(child);
    const exited = once(child, "exit");
    child.send("crash");
    await exited;
    await stop(child);
    expect(await readFile(marker, "utf8")).toBe("closed");
    const table = await readProcessTable();
    expect(table).not.toBeNull();
    expect(table!.some(row => row.pid === pid && !row.state?.startsWith("Z"))).toBe(false);
  } finally { try { process.kill(pid, "SIGKILL"); } catch { /* stopped */ } }
});

it.skipIf(process.platform === "win32")("recovers a failed cleanup without repeating the graceful signal", async () => {
  const { entry } = await fixture();
  const child = start(entry);
  await once(child, "message");
  let failInspection = false;
  let markInspectionFailed!: () => void;
  const inspectionFailed = new Promise<void>(resolve => { markInspectionFailed = resolve; });
  let owner: ReturnType<typeof createProcessTreeOwner> | undefined;
  const messages: unknown[] = [];
  child.on("message", message => {
    messages.push(message);
    if (message === "stopping") failInspection = true;
  });
  const stop = createRunnerE2EServerStopper({
    gracefulTimeoutMs: 2_000, forcedTimeoutMs: 2_000,
    hasSpawnError: () => false, markExpectedStop: () => {}, log: () => {},
    createOwner: candidate => {
      owner = createProcessTreeOwner(candidate);
      return { ...owner, observe: async () => {
        if (failInspection) {
          failInspection = false;
          markInspectionFailed();
          throw new Error("transient inspection failure");
        }
        await owner!.observe();
      } };
    },
  });
  try {
    const failed = expect(stop(child)).rejects.toThrow("transient inspection failure");
    // Process-table inspection can take longer than 100ms on a loaded host.
    // Keep the child alive until the intended inspection failure actually occurs.
    await inspectionFailed;
    if (child.connected) child.send("finish");
    await failed;
    const recovery = stop(child);
    // A second graceful signal would terminate this child's once-handler.
    await new Promise(resolve => setTimeout(resolve, 50));
    if (child.connected) child.send("finish");
    await recovery;
    expect(messages).toEqual(["stopping", "close-complete"]);
    expect([child.exitCode, child.signalCode]).toEqual([0, null]);
  } finally { owner?.stopObserving(); }
});

it.skipIf(process.platform === 'win32').each([['launcher', 'null'], ['server', 'null'], ['launcher', 'throw'], ['server', 'throw']] as const)(
  'bounds the known %s child when inspection fails with %s', async (kind, failure) => {
    const { entry } = await fixture(`process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`);
    const child = start(entry);
    await once(child, 'message');
    const groupSignals: number[] = [];
    const owner = createProcessTreeOwner(child, {
      readTable: async () => { if (failure === "throw") throw new Error("inspection failed"); return null; },
      signalGroup: pid => { groupSignals.push(pid); },
    });
    try {
      const stopping = kind === 'launcher'
        ? stopOwnedProcessTree(child, owner, 50, 500)
        : createRunnerE2EServerStopper({ gracefulTimeoutMs: 50, forcedTimeoutMs: 500,
          hasSpawnError: () => false, markExpectedStop: () => {}, log: () => {}, createOwner: () => owner })(child);
      await expect(stopping).rejects.toThrow(/inspect|incomplete/i);
      expect(child.signalCode).toBe('SIGKILL');
      expect(groupSignals).toEqual([]);
    } finally { owner.stopObserving(); }
  },
);

it.skipIf(process.platform === 'win32')('does not re-signal a server after its graceful wrapper forwards and exits', async () => {
  const { root, entry } = await fixture();
  const marker = path.join(root, 'async-close-finished');
  await writeFile(entry, `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`
      process.once('SIGTERM', () => setTimeout(() => {
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'closed'); process.exit(0);
      }, 300));
      process.send('ready'); setInterval(() => {}, 1000);
    `)}], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', () => process.send({ pid: child.pid }));
    process.once('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
  `);
  const wrapper = start(entry);
  const pid = (await once(wrapper, 'message'))[0].pid as number;
  const owner = createProcessTreeOwner(wrapper);
  try {
    await owner.observe();
    await stopOwnedProcessTree(wrapper, owner, 2_000, 500);
    expect(await readFile(marker, 'utf8')).toBe('closed');
    expect(wrapper.exitCode).toBe(0);
  } finally {
    owner.stopObserving();
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already stopped */ }
  }
});
