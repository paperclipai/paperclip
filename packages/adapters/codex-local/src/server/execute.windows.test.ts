import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { readPaperclipRuntimeSkillEntries } = vi.hoisted(() => ({
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

import { execute } from "./execute.js";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

describe("codex execute Windows cleanup", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "cleans up a lingering cmd/node tree after turn completion",
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-win-cleanup-"));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      const codexHomeDir = path.join(rootDir, "codex-home");
      const workerScriptPath = path.join(rootDir, "worker.js");
      const wrapperPath = path.join(rootDir, "codex.cmd");

      await mkdir(workspaceDir, { recursive: true });
      await mkdir(codexHomeDir, { recursive: true });
      await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
      await writeFile(
        workerScriptPath,
        [
          "process.stdout.write(`worker:${process.pid}\\n`);",
          `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "thread.started", thread_id: "thread_test" }))} + "\\n");`,
          `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }))} + "\\n");`,
          `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }))} + "\\n");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        wrapperPath,
        `@echo off\r\n"${process.execPath.replaceAll('"', '""')}" "%~dp0worker.js"\r\n`,
        "utf8",
      );

      const result = await execute({
        runId: "run-win-cleanup",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CodexCoder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: wrapperPath,
          timeoutSec: 3,
          graceSec: 1,
          terminalResultCleanupGraceMs: 100,
          env: {
            CODEX_HOME: codexHomeDir,
          },
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        onLog: async () => {},
      });

      const stdout = typeof result.resultJson?.stdout === "string" ? result.resultJson.stdout : "";
      const workerPid = Number.parseInt(stdout.match(/worker:(\d+)/)?.[1] ?? "", 10);

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.errorMessage).toBeNull();
      expect(result.sessionId).toBe("thread_test");
      expect(result.summary).toBe("done");
      expect(Number.isInteger(workerPid) && workerPid > 0).toBe(true);
      expect(await waitForPidExit(workerPid, 2_000)).toBe(true);
    },
  );
});
