import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => ({
  ...(await importActual<typeof import("@paperclipai/adapter-utils/execution-target")>()),
  startAdapterExecutionTargetPaperclipBridge: async () => {
    throw new Error("bridge start failed");
  },
}));

import { execute } from "./execute.js";

it("releases the host workspace baseline when the run fails after the sandbox stage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-baseline-"));
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
      runId: "run-baseline",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "gemini_local", adapterConfig: {} },
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
            return runChildProcess(`baseline-${counter}`, command.command, command.args ?? [], {
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
    })).rejects.toThrow("bridge start failed");
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
