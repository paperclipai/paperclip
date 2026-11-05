import { fileURLToPath } from 'node:url';
import { defaultCadenceNetwork } from './default-cadence-network.js';
import { fork } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';


export async function startDefaultCadenceBridge(options: {
  checkout: string; node: string;
  physicalStop(): Promise<void>; physicalWake(): Promise<{ origin: string }>;
}) {
  const child = fork(path.join(options.checkout, 'dist/sleep/fixtures/default-cadence-bridge.js'), [], {
    cwd: options.checkout, execPath: options.node, execArgv: ["--require", fileURLToPath(new URL("../../../../../scripts/fixtures/skill-default-cadence-network-guard.cjs", import.meta.url))],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG: process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '', id = 0;
  child.stdout?.on('data', bytes => { output += String(bytes); });
  child.stderr?.on('data', bytes => { output += String(bytes); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const physicalWork = new Set<Promise<void>>();
  const physicalCleanupFailures: unknown[] = [];
  let closing = false;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.on('message', (message: any) => {
    if (message.ready) {
      const guard = message.defaultCadenceGuard;
      if (!guard?.loaded || guard.pid !== child.pid || guard.ppid !== process.pid || guard.sourceHash !== defaultCadenceNetwork().sourceHash) {
        readyReject(new Error('Actual Cloud child did not report the expected preloaded guard identity')); return;
      }
      readyResolve(); return;
    }
    if (message.callbackId) {
      if (closing) {
        if (child.connected) child.send({ callbackId: message.callbackId, error: 'Default cadence bridge is closing' });
        return;
      }
      const operation = message.physical === 'stop' ? options.physicalStop() : options.physicalWake();
      const handled = operation.then(async result => {
        if (closing && message.physical === 'wake') await options.physicalStop();
        if (child.connected) child.send({ callbackId: message.callbackId, result });
      }, error => {
        if (child.connected) child.send({ callbackId: message.callbackId, error: error instanceof Error ? error.stack : String(error) });
      });
      physicalWork.add(handled);
      void handled.then(() => physicalWork.delete(handled), error => {
        physicalWork.delete(handled); physicalCleanupFailures.push(error);
      });
      return;
    }
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) {
      output += `\nCloud RPC failure: ${message.error}`;
      console.error(`[default-cadence-bridge] ${message.error}`);
      request?.reject(new Error(message.error));
    } else request?.resolve(message.result);
  });
  child.once('error', readyReject);
  const exited = new Promise<void>(resolve => child.once('exit', () => {
    const failure = new Error(`Default cadence bridge exited: ${output.slice(-8000)}`);
    readyReject(failure); for (const request of pending.values()) request.reject(failure); resolve();
  }));
  async function bounded<T>(work: Promise<T>, ms: number) {
    const abort = new AbortController();
    try { return await Promise.race([work, delay(ms, undefined, { signal: abort.signal }).then(() => { throw new Error(`Default cadence bridge deadline: ${output.slice(-8000)}`); })]); }
    finally { abort.abort(); }
  }
  try { await bounded(ready, 15_000); } catch (error) { child.kill("SIGKILL"); await exited; throw error; }
  async function rpc<T = any>(method: string, input?: unknown, budgetMs = 210_000): Promise<T> {
    const requestId = ++id;
    const response = new Promise<T>((resolve, reject) => pending.set(requestId, { resolve, reject }));
    child.send({ id: requestId, method, input });
    try { return await bounded(response, budgetMs); } finally { pending.delete(requestId); }
  }
  return { rpc: <T = any>(method: string, input?: unknown) => rpc<T>(method, input), pid: child.pid, get output() { return output; }, async close() {
    closing = true;
    const deadline = performance.now() + 210_000;
    const remaining = () => Math.max(0, deadline - performance.now());
    try {
      await bounded(Promise.all([...physicalWork]), remaining());
      if (physicalCleanupFailures.length) throw new AggregateError(physicalCleanupFailures, 'Physical callback cleanup failed');
      if (child.exitCode === null && child.connected) { await rpc('close', undefined, remaining()); console.info(`[default-cadence-bridge] close acknowledged pid=${child.pid}`); }
    } finally {
      console.info(`[default-cadence-bridge] disconnect pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode}`);
      if (child.connected) child.disconnect();
      await bounded(exited, 10_000).catch(async error => { child.kill('SIGKILL'); await exited; throw error; });
    }
  } };
}
