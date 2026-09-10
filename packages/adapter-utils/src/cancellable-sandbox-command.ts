import { randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import {
  hasAdapterRunCancellation,
  registerAdapterRunStop,
  throwIfAdapterRunCancelled,
} from "./adapter-run-cancellation.js";

// The supervisor owns the child and its process group inside the sandbox.
// Cancellation transfers only a random command-scoped marker, never a PID.
const supervisor = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { command, args, marker, graceMs } = JSON.parse(process.argv[1]);
const cancelled = () => {
  try { const s = fs.lstatSync(marker); if (!s.isFile() || s.isSymbolicLink()) throw Error('Invalid cancellation marker'); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
};
if (cancelled()) { fs.unlinkSync(marker); process.exit(143); }
const child = spawn(command, args, { stdio: 'inherit', detached: true });
let stopping = false, exited = false, escalation;
const signal = value => {
  if (!child.pid) return;
  try { process.kill(-child.pid, value); } catch (e) { if (e.code !== 'ESRCH') throw e; }
};
const stop = () => {
  if (stopping || exited) return;
  stopping = true; signal('SIGTERM');
  escalation = setTimeout(() => { if (!exited) signal('SIGKILL'); }, graceMs);
};
const poll = setInterval(() => { if (cancelled()) stop(); }, 100);
for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, stop);
const cleanup = () => { clearInterval(poll); clearTimeout(escalation); try { fs.unlinkSync(marker); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
child.once('error', () => { exited = true; cleanup(); process.exitCode = 127; });
child.once('exit', (code, childSignal) => {
  // Do not leave a shell/tool child holding the provider's output pipe after
  // the CLI exits in response to cancellation. Never retain a PID kill timer.
  if (stopping) signal('SIGKILL');
  exited = true; cleanup();
  if (!stopping && childSignal) {
    // Preserve the real termination signal instead of reporting exit code 128.
    process.removeAllListeners(childSignal);
    process.kill(process.pid, childSignal);
    return;
  }
  process.exitCode = stopping ? 143 : (code ?? 1);
});
process.once('exit', () => { if (!exited) signal('SIGKILL'); });
`;

const requestStop = String.raw`
const fs = require('node:fs'), marker = process.argv[1];
try { fs.closeSync(fs.openSync(marker, 'wx', 0o600)); }
catch (e) { if (e.code !== 'EEXIST') throw e; const s = fs.lstatSync(marker); if (!s.isFile() || s.isSymbolicLink()) throw Error('Invalid cancellation marker'); }
`;

export async function executeCancellableSandboxCommand(
  runId: string,
  runner: CommandManagedRuntimeRunner,
  input: Parameters<CommandManagedRuntimeRunner["execute"]>[0],
  graceMs: number,
) {
  if (!hasAdapterRunCancellation(runId)) return runner.execute(input);
  throwIfAdapterRunCancelled(runId);
  const marker = `/tmp/paperclip-command-cancel-${randomUUID()}`;
  let execution: ReturnType<CommandManagedRuntimeRunner["execute"]> | undefined;
  const unregister = registerAdapterRunStop(runId, async () => {
    if (!execution) return;
    const result = await runner.execute({
      command: "node", args: ["-e", requestStop, marker], cwd: input.cwd,
      env: { PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" },
      timeoutMs: 10_000, bypassSession: true,
    });
    if (result.timedOut || result.exitCode !== 0) throw new Error("Sandbox cancellation request failed; execution may still be active");
    await execution;
  });
  try {
    throwIfAdapterRunCancelled(runId);
    execution = runner.execute({
      ...input,
      command: "node",
      args: ["-e", supervisor, JSON.stringify({
        command: input.command, args: input.args, marker,
        graceMs: Math.max(1, Math.min(30_000, Math.trunc(graceMs) || 1)),
      })],
    });
    return await execution;
  } finally { unregister(); }
}
