import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

const state = vi.hoisted(() => ({
  restoring: false,
  releasedWhileRestoring: false,
  remoteDir: "",
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual = await importActual<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: async (input: Parameters<typeof actual.prepareAdapterExecutionTargetRuntime>[0]) => {
      const runtime = await actual.prepareAdapterExecutionTargetRuntime(input);
      state.remoteDir = runtime.workspaceRemoteDir ?? "";
      return {
        ...runtime,
        restoreWorkspace: async (...args: Parameters<typeof runtime.restoreWorkspace>) => {
          state.restoring = true;
          try {
            await new Promise((resolve) => setTimeout(resolve, 200));
            await runtime.restoreWorkspace(...args);
          } finally {
            state.restoring = false;
          }
        },
        cleanupWorkspaceSnapshot: async () => {
          if (state.restoring) state.releasedWhileRestoring = true;
          await runtime.cleanupWorkspaceSnapshot?.();
        },
      };
    },
    startAdapterExecutionTargetPaperclipBridge: async () => ({
      env: {},
      stop: async () => {
        throw new Error("bridge stop failed");
      },
    }),
    runAdapterExecutionTargetProcess: async () => {
      if (state.remoteDir) await writeFile(path.join(state.remoteDir, "file.txt"), "remote edit\n");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    },
  };
});

import { execute } from "./execute.js";

it("waits for the workspace restore before releasing the baseline when a parallel cleanup step fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-kimi-restore-order-"));
  const previous = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };
  const tmp = path.join(root, "tmp");
  const workspace = path.join(root, "workspace");
  const remote = path.join(root, "remote");
  await Promise.all([tmp, workspace, remote, path.join(root, "home")].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(path.join(workspace, "file.txt"), "contents\n");
  process.env.TMPDIR = tmp;
  process.env.HOME = path.join(root, "home");
  let counter = 0;
  try {
    await expect(execute({
      runId: "run-restore-order",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "kimi_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test",
        remoteCwd: remote,
        timeoutMs: 30_000,
        runner: {
          execute: (command) => {
            counter += 1;
            return runChildProcess(`restore-order-${counter}`, command.command, command.args ?? [], {
              cwd: command.cwd ?? root,
              env: command.env ?? {},
              stdin: command.stdin,
              timeoutSec: 30,
              graceSec: 1,
              onLog: command.onLog ?? (async () => {}),
            });
          },
        },
      },
      config: { engine: "cli", command: process.execPath, cwd: workspace },
      context: createPromptContextFixture(),
      authToken: "run-jwt-token",
      onLog: async () => {},
    })).rejects.toThrow("bridge stop failed");
    expect(state.releasedWhileRestoring).toBe(false);
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("remote edit\n");
    const baselines = (await readdir(tmp, { recursive: true }))
      .filter((entry) => path.basename(entry).startsWith("paperclip-workspace-baseline-"));
    expect(baselines).toEqual([]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
