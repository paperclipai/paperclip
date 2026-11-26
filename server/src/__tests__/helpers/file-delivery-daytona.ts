import { createRequire } from "node:module";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { openDaytonaDuplexChannelSession, type DaytonaPtyProcess } from "../../../../packages/plugins/sandbox-providers/daytona/src/duplex-command-stream.js";

/** Opt-in live fixture; uses an isolated sandbox and never reuses a user's lease. */
export async function startFileDeliveryDaytona() {
  const require = createRequire(new URL("../../../../packages/plugins/sandbox-providers/daytona/package.json", import.meta.url));
  const { Daytona } = require("@daytonaio/sdk");
  const sandbox: {
    id: string;
    process: DaytonaPtyProcess & { executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<{ exitCode: number; result: string }> };
    delete(): Promise<void>;
  } = await new Daytona({ apiKey: process.env.DAYTONA_API_KEY }).create({
    language: "typescript", autoStopInterval: 10,
    labels: { "paperclip-test": "gus-file-delivery" },
  });
  const workspace = "/home/daytona/gus-file-delivery";
  // Capture stdout/stderr separately: SDK result text otherwise combines them.
  const executeSource = `
    const {spawn} = require('node:child_process');
    const input = JSON.parse(process.argv[1]);
    const child = spawn(input.command, input.args || [], {
      cwd: input.cwd, env: {...process.env, ...input.env}, timeout: input.timeoutMs || 30000
    });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => stderr.push(Buffer.from(error.message)));
    child.on('close', (exitCode, signal) => process.stdout.write(JSON.stringify({
      exitCode, signal, timedOut: signal === 'SIGTERM', pid: null,
      startedAt: new Date().toISOString(),
      stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString()
    })));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stderr.push(Buffer.from(error.message)); });
    child.stdin.end(input.stdin || '');
  `;
  const runner: CommandManagedRuntimeRunner = {
    execute: async input => {
      const command = `node --input-type=commonjs -e ${shellQuote(executeSource)} ${shellQuote(JSON.stringify(input))}`;
      const result = await sandbox.process.executeCommand(command, undefined, undefined, Math.ceil((input.timeoutMs ?? 30000) / 1000) + 10);
      if (result.exitCode !== 0) throw new Error(`Daytona test command transport failed (exit ${result.exitCode})`);
      return JSON.parse(result.result);
    },
    openDuplexChannel: async ({ command }) => {
      const session = await openDaytonaDuplexChannelSession(sandbox.process, command);
      return {
        write: bytes => session.write(bytes), onData: listener => session.onData(listener),
        onExit: listener => { void session.wait().then(listener); },
        stop: () => session.kill(), close: () => session.close(),
      };
    },
  };
  try {
    const setup = await runner.execute({ command: "bash", args: ["-lc", `mkdir -p ${shellQuote(workspace)} && command -v node && command -v curl && command -v jq`], timeoutMs: 30000 });
    if (setup.exitCode !== 0) throw new Error("Daytona test image requires node, curl, and jq");
    return { workspace, runner, close: () => sandbox.delete() };
  } catch (error) { await sandbox.delete(); throw error; }
}
