import { execFile, spawn } from "node:child_process";
import type { CommandManagedRuntimeRunner, CommandManagedDuplexChannel } from "@paperclipai/adapter-utils/command-managed-runtime";

export function loopbackCheckpointChannel(command: readonly string[]): CommandManagedDuplexChannel {
  const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  return {
    write: bytes => { child.stdin.write(bytes); },
    onData: listener => { child.stdout.on("data", listener); child.stderr.on("data", listener); },
    onExit: listener => { child.once("close", exitCode => listener({ exitCode })); },
    stop: () => { child.kill("SIGKILL"); },
    close: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; },
  };
}

export function loopbackCheckpointDuplexRunner(): CommandManagedRuntimeRunner {
  return { ...loopbackCheckpointRunner(), openDuplexChannel: async ({ command }) => loopbackCheckpointChannel(command) };
}

/** Execute the actual command transport on a private test directory. No SSH,
 * provider, API keys or Docker resources are borrowed by these protocol tests. */
export function loopbackCheckpointRunner(onCommand?: (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0], stdout: string) => string): CommandManagedRuntimeRunner {
  return { execute: input => new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, timeout: input.timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ exitCode: 0, signal: null, timedOut: false, stdout: onCommand?.(input, stdout) ?? stdout, stderr, pid: child.pid ?? null, startedAt });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input.stdin);
  }) };
}
