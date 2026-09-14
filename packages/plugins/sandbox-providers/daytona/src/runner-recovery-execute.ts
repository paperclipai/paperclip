import { posix } from "node:path";
import type { Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentExecuteResult, PluginEnvironmentRunnerRecoveryExecuteParams, PluginEnvironmentRunnerRecoveryExecuteResult } from "@paperclipai/plugin-sdk";
import { handleDaytonaRunProcessControl } from "./run-process-control.js";

export const MAX_RUNNER_RECOVERY_COMMAND_MS = 120_000;

// Validate and select the physical directory inside the process that launches
// recovery work. The child inherits the selected cwd; no later path lookup can
// follow a swapped symlink. This constrains placement, not command capabilities.
export const runnerRecoveryExecuteSource = String.raw`
const { spawn } = require('node:child_process');
const input = JSON.parse(process.env.PAPERCLIP_RECOVERY_EXECUTION);
delete process.env.PAPERCLIP_RECOVERY_EXECUTION;
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV']) delete process.env[key];
try {
  process.chdir(input.root);
  if (process.cwd() !== input.root) throw new Error();
  process.chdir(input.cwd === input.root ? '.' : input.cwd.slice(input.root.length + 1));
  const physical = process.cwd();
  if (physical !== input.root && !physical.startsWith(input.root + '/')) throw new Error();
} catch {
  process.stderr.write('PAPERCLIP_RECOVERY_CWD_UNVERIFIED');
  process.exit(125);
}
const child = spawn(input.command, input.args, { stdio: 'inherit', env: process.env });
child.on('error', () => { process.stderr.write('PAPERCLIP_RECOVERY_EXEC_FAILED'); process.exitCode = 126; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code;
});
`;

/** One-shot host work in the original, already-started allocation. The caller
 * verifies the saved connection before lookup and supplies a profile-free
 * executor. An exited original root permits checkpoint reads, not replacement. */
export async function handleDaytonaRunnerRecoveryExecute(
  sandbox: Sandbox,
  params: PluginEnvironmentRunnerRecoveryExecuteParams,
  execute: (execution: PluginEnvironmentRunnerRecoveryExecuteParams["execution"]) => Promise<PluginEnvironmentExecuteResult>,
): Promise<PluginEnvironmentRunnerRecoveryExecuteResult> {
  const unavailable = { state: "unverified" } as const;
  const root = params.workspaceRoot;
  const command = params.execution;
  const cwd = command?.cwd ?? root;
  if (typeof root !== "string" || root === "/" || root.length > 4096 || root.includes("\0") || posix.resolve(root) !== root
    || typeof cwd !== "string" || cwd.includes("\0") || posix.resolve(cwd) !== cwd || (cwd !== root && !cwd.startsWith(`${root}/`))
    || !command || typeof command.command !== "string" || !command.command || command.command.includes("\0")
    || (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string" || arg.includes("\0"))))
    || (command.stdin !== undefined && typeof command.stdin !== "string")
    || (command.timeoutMs !== undefined && (!Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0 || command.timeoutMs > MAX_RUNNER_RECOVERY_COMMAND_MS))) return unavailable;
  const inspect = () => handleDaytonaRunProcessControl(sandbox, { ...params, operation: { action: "inspect" } });
  const before = await inspect();
  if (sandbox.state !== "started" || !["running", "exited"].includes(before.state)) return unavailable;
  const result = await execute({
    command: "/usr/bin/env",
    args: ["-u", "NODE_OPTIONS", "-u", "NODE_PATH", "-u", "BASH_ENV", "-u", "ENV", "node", "-e", runnerRecoveryExecuteSource],
    cwd: "/", stdin: command.stdin, timeoutMs: command.timeoutMs ?? 30_000,
    env: { ...command.env, PAPERCLIP_RECOVERY_EXECUTION: JSON.stringify({ root, cwd, command: command.command, args: command.args ?? [] }) },
  });
  if (result.exitCode === 125 && `${result.stdout}${result.stderr}`.includes("PAPERCLIP_RECOVERY_CWD_UNVERIFIED")) return unavailable;
  if (result.timedOut || result.exitCode === null || !Number.isInteger(result.exitCode)
    || typeof result.stdout !== "string" || typeof result.stderr !== "string") return unavailable;
  const after = await inspect();
  if (sandbox.state !== "started" || !["running", "exited"].includes(after.state)) return unavailable;
  return { state: "executed", workspaceConnection: params.workspaceConnection, result };
}
