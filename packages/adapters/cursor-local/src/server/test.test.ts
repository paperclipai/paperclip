import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { testEnvironment } from "./test.js";

function buildFakeAgentScript(): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'Cursor Agent 1.2.3'
  exit 0
fi
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"cursor-session-envtest-1","model":"auto"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"output_text","text":"hello"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","session_id":"cursor-session-envtest-1","result":"ok"}'
`;
}

function buildInstallSimulationCommand(commandPath: string): string {
  return [
    `mkdir -p ${JSON.stringify(path.dirname(commandPath))}`,
    `cat > ${JSON.stringify(commandPath)} <<'EOF'`,
    buildFakeAgentScript(),
    "EOF",
    `chmod +x ${JSON.stringify(commandPath)}`,
  ].join("\n");
}

function createSandboxRunner(options: { homeDir: string; installCommandPath: string }) {
  let counter = 0;
  const installCommands: string[] = [];
  const systemPath = "/usr/bin:/bin";
  return {
    installCommands,
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    }) => {
      counter += 1;
      const args = [...(input.args ?? [])];
      if (args[1] === SANDBOX_INSTALL_COMMAND) {
        installCommands.push(args[1]);
        args[1] = buildInstallSimulationCommand(options.installCommandPath);
      }
      return await runChildProcess(`cursor-envtest-runner-${counter}`, input.command, args, {
        cwd: input.cwd ?? process.cwd(),
        env: {
          ...(input.env ?? {}),
          HOME: input.env?.HOME ?? options.homeDir,
          PATH: input.env?.PATH ?? systemPath,
        },
        stdin: input.stdin,
        timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
        graceSec: 5,
        onLog: input.onLog ?? (async () => {}),
        onSpawn: input.onSpawn
          ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
          : undefined,
      });
    },
  };
}

describe("cursor testEnvironment", () => {
  it("re-resolves the installed agent under ~/.cursor/bin and verifies --version before the hello probe", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-envtest-"));
    const homeDir = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const remoteWorkspace = path.join(root, "remote-workspace");
    const agentPath = path.join(homeDir, ".cursor", "bin", "agent");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(remoteWorkspace, { recursive: true });

    const runner = createSandboxRunner({
      homeDir,
      installCommandPath: agentPath,
    });

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "cursor",
        config: {
          command: "agent",
          cwd: workspace,
          env: {
            PATH: "/usr/bin:/bin",
          },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          shellCommand: "bash",
          remoteCwd: remoteWorkspace,
          runner,
          timeoutMs: 30_000,
        },
      });

      expect(result.status).toBe("pass");
      expect(runner.installCommands).toEqual([SANDBOX_INSTALL_COMMAND]);
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "cursor_command_resolvable",
            level: "info",
            message: `Command is executable: ${agentPath}`,
          }),
          expect.objectContaining({
            code: "cursor_version_probe_passed",
            level: "info",
            detail: "Cursor Agent 1.2.3",
          }),
          expect.objectContaining({
            code: "cursor_hello_probe_passed",
            level: "info",
          }),
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
