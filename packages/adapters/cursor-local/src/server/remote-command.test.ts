import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { prepareCursorSandboxCommand } from "./remote-command.js";

function createLocalSandboxRunner() {
  let counter = 0;
  return {
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
      return await runChildProcess(`cursor-remote-command-${counter}`, input.command, input.args ?? [], {
        cwd: input.cwd ?? process.cwd(),
        env: input.env ?? {},
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

async function writeFakeAgent(commandPath: string): Promise<void> {
  const script = `#!/bin/sh
printf '%s\\n' ok
`;
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("prepareCursorSandboxCommand", () => {
  it("prefers the Cursor installer bin directory when the default agent entrypoint is installed there", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-remote-command-cursor-bin-"));
    const systemHomeDir = path.join(root, "system-home");
    const managedHomeDir = path.join(root, "managed-home");
    const remoteWorkspace = path.join(root, "workspace");
    const cursorAgentPath = path.join(systemHomeDir, ".cursor", "bin", "agent");
    await fs.mkdir(remoteWorkspace, { recursive: true });
    await writeFakeAgent(cursorAgentPath);

    try {
      const result = await prepareCursorSandboxCommand({
        runId: "run-remote-command-cursor-bin",
        target: {
          kind: "remote",
          transport: "sandbox",
          shellCommand: "bash",
          remoteCwd: remoteWorkspace,
          runner: createLocalSandboxRunner(),
          timeoutMs: 30_000,
        },
        command: "agent",
        cwd: remoteWorkspace,
        env: {
          HOME: managedHomeDir,
          PATH: "/usr/bin:/bin",
        },
        remoteSystemHomeDirHint: systemHomeDir,
        timeoutSec: 30,
        graceSec: 5,
      });

      expect(result.command).toBe(cursorAgentPath);
      expect(result.preferredCommandPath).toBe(cursorAgentPath);
      expect(result.remoteSystemHomeDir).toBe(systemHomeDir);
      expect(result.addedPathEntry).toBe(path.join(systemHomeDir, ".local", "bin"));
      expect(result.env.PATH?.split(":").slice(0, 2)).toEqual([
        path.join(systemHomeDir, ".local", "bin"),
        path.join(systemHomeDir, ".cursor", "bin"),
      ]);
      expect(result.env.PATH).not.toContain(path.join(managedHomeDir, ".cursor", "bin"));
      expect(result.env.PATH).not.toContain(path.join(managedHomeDir, ".local", "bin"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps probing the original sandbox home after managed HOME overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-remote-command-"));
    const systemHomeDir = path.join(root, "system-home");
    const managedHomeDir = path.join(root, "managed-home");
    const remoteWorkspace = path.join(root, "workspace");
    const systemAgentPath = path.join(systemHomeDir, ".local", "bin", "agent");
    await fs.mkdir(remoteWorkspace, { recursive: true });
    await writeFakeAgent(systemAgentPath);

    try {
      const result = await prepareCursorSandboxCommand({
        runId: "run-remote-command-1",
        target: {
          kind: "remote",
          transport: "sandbox",
          shellCommand: "bash",
          remoteCwd: remoteWorkspace,
          runner: createLocalSandboxRunner(),
          timeoutMs: 30_000,
        },
        command: "agent",
        cwd: remoteWorkspace,
        env: {
          HOME: managedHomeDir,
          PATH: "/usr/bin:/bin",
        },
        remoteSystemHomeDirHint: systemHomeDir,
        timeoutSec: 30,
        graceSec: 5,
      });

      expect(result.command).toBe(systemAgentPath);
      expect(result.preferredCommandPath).toBe(systemAgentPath);
      expect(result.remoteSystemHomeDir).toBe(systemHomeDir);
      expect(result.addedPathEntry).toBe(path.join(systemHomeDir, ".local", "bin"));
      expect(result.env.PATH?.split(":").slice(0, 2)).toEqual([
        path.join(systemHomeDir, ".local", "bin"),
        path.join(systemHomeDir, ".cursor", "bin"),
      ]);
      expect(result.env.PATH).not.toContain(path.join(managedHomeDir, ".local", "bin"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
