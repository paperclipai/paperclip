import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet" }),
      JSON.stringify({ type: "result", session_id: "s1", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, runChildProcess };
});

import { execute } from "./execute.js";

/**
 * The hoisted mock infers a zero-arity signature, so read its recorded args
 * positionally: (runId, command, args, options).
 */
function firstSpawnCall(): { command: string; options: { env?: Record<string, string> } } {
  const [call] = runChildProcess.mock.calls as unknown as unknown[][];
  return { command: call?.[1] as string, options: (call?.[3] ?? {}) as { env?: Record<string, string> } };
}

/** Lay down an executable stub named `claude` and return its containing dir. */
async function fakeClaudeBin(rootDir: string): Promise<string> {
  const binDir = path.join(rootDir, "bin");
  await mkdir(binDir, { recursive: true });
  const binPath = path.join(binDir, "claude");
  await writeFile(binPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(binPath, 0o755);
  return binDir;
}

async function runLocalExecute(rootDir: string, binDir: string, configEnv: Record<string, string> = {}) {
  const workspaceDir = path.join(rootDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await execute({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      // The CLI lane is what owns the spawn; ACP resolves its own server binary.
      engine: "cli",
      command: "claude",
      cwd: workspaceDir,
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}`, ...configEnv },
    },
    context: { prompt: "hi" },
    onLog: async () => {},
  } as unknown as Parameters<typeof execute>[0]);
}

describe.skipIf(process.platform === "win32")("claude_local binary-swap hardening", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("spawns the absolute binary path rather than re-resolving 'claude' at spawn time", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-pin-"));
    cleanupDirs.push(rootDir);
    const binDir = await fakeClaudeBin(rootDir);

    await runLocalExecute(rootDir, binDir);

    expect(runChildProcess).toHaveBeenCalled();
    expect(firstSpawnCall().command).toBe(path.join(binDir, "claude"));
  });

  it("applies DISABLE_AUTOUPDATER=1 by default", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-autoupdate-"));
    cleanupDirs.push(rootDir);
    const binDir = await fakeClaudeBin(rootDir);

    await runLocalExecute(rootDir, binDir);

    expect(firstSpawnCall().options.env?.DISABLE_AUTOUPDATER).toBe("1");
  });

  it("lets an explicit adapter-config value override the default", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-autoupdate-override-"));
    cleanupDirs.push(rootDir);
    const binDir = await fakeClaudeBin(rootDir);

    await runLocalExecute(rootDir, binDir, { DISABLE_AUTOUPDATER: "0" });

    expect(firstSpawnCall().options.env?.DISABLE_AUTOUPDATER).toBe("0");
  });
});
