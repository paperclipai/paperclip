
import { spawn } from 'node:child_process';
import { nowIso } from '../shared/utils.js';

const testHooks = {
  runChildProcess: null,
};

export function __setTestRunChildProcess(fn) {
  testHooks.runChildProcess = fn;
}

export function __resetTestRunChildProcess() {
  testHooks.runChildProcess = null;
}

/**
 * Spawn a child process with streaming logs, timeout handling, and simple
 * process metadata hooks.
 *
 * @param {{
 *   runId: string,
 *   command: string,
 *   args: string[],
 *   cwd: string,
 *   env: Record<string, string>,
 *   stdin?: string,
 *   timeoutSec?: number,
 *   graceSec?: number,
 *   onLog?: (stream: 'stdout'|'stderr', chunk: string) => Promise<void>|void,
 *   onSpawn?: (meta: {pid: number, startedAt: string}) => Promise<void>|void,
 * }} options
 */
export async function runChildProcess(options) {
  if (testHooks.runChildProcess) {
    return await testHooks.runChildProcess(options);
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let timeoutHandle = null;
    let graceHandle = null;

    if (typeof child.pid === 'number' && options.onSpawn) {
      Promise.resolve(options.onSpawn({ pid: child.pid, startedAt: nowIso() })).catch(() => {});
    }

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      Promise.resolve(options.onLog?.('stdout', text)).catch(() => {});
    });

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      Promise.resolve(options.onLog?.('stderr', text)).catch(() => {});
    });

    child.on('error', (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (graceHandle) clearTimeout(graceHandle);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (graceHandle) clearTimeout(graceHandle);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
        wasKilled: killed,
      });
    });

    if (typeof options.stdin === 'string' && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }

    const timeoutSec = Number(options.timeoutSec ?? 0);
    const graceSec = Number(options.graceSec ?? 10);

    if (timeoutSec > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill('SIGTERM');
        graceHandle = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, Math.max(graceSec, 1) * 1000);
      }, timeoutSec * 1000);
    }
  });
}
