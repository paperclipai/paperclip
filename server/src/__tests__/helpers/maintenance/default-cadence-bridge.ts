import { fileURLToPath } from 'node:url';
import { defaultCadenceNetwork } from './default-cadence-network.js';
import { fork } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Focused IPC adapter; Cloud runs its actual compiled Node22 controller. */
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
      const operation = message.physical === 'stop' ? options.physicalStop() : options.physicalWake();
      void operation.then(result => child.send({ callbackId: message.callbackId, result }), error =>
        child.send({ callbackId: message.callbackId, error: error instanceof Error ? error.stack : String(error) }));
      return;
    }
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result);
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
  async function rpc<T = any>(method: string, input?: unknown): Promise<T> {
    const requestId = ++id;
    const response = new Promise<T>((resolve, reject) => pending.set(requestId, { resolve, reject }));
    child.send({ id: requestId, method, input });
    try { return await bounded(response, 210_000); } finally { pending.delete(requestId); }
  }
  return { rpc, pid: child.pid, get output() { return output; }, async close() {
    try { if (child.exitCode === null && child.connected) await rpc('close'); }
    finally { child.disconnect(); await bounded(exited, 10_000).catch(async error => { child.kill('SIGKILL'); await exited; throw error; }); }
  } };
}
