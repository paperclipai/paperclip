import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The plugin module imports `@daytonaio/sdk` as a value, but the sync tests never
// touch a real Daytona client — every sandbox call goes through a local mock. Stub
// the SDK so the import resolves without the excluded provider package.
import { vi } from "vitest";
vi.mock("@daytonaio/sdk", () => ({
  Daytona: class MockDaytona {},
  DaytonaNotFoundError: class MockDaytonaNotFoundError extends Error {},
  DaytonaTimeoutError: class MockDaytonaTimeoutError extends Error {},
}));

import { performSyncIn } from "./file-sync.js";
import type { PluginSyncOperation } from "@paperclipai/plugin-sdk";

// One recorded in-sandbox command, so a test can assert the exact cleanup command.
interface RecordedCommand {
  command: string;
}

// Build a mock Daytona sandbox for the inbound directory path. `executeCommand`
// records every command and returns exit 0, except that any command whose text
// matches `failCommandMatch` returns exit 1 (to simulate an extract failure).
// `uploadFiles` records each upload destination so a test can read the reserved
// scratch tar path the runtime chose.
function createMockSandbox(input: {
  failCommandMatch?: RegExp;
  uploadedDestinations: string[];
  commands: RecordedCommand[];
}) {
  return {
    process: {
      executeCommand: async (command: string) => {
        input.commands.push({ command });
        if (input.failCommandMatch && input.failCommandMatch.test(command)) {
          return { exitCode: 1, result: "simulated extract failure" };
        }
        return { exitCode: 0, result: "" };
      },
    },
    fs: {
      uploadFiles: async (uploads: Array<{ source: string; destination: string }>) => {
        for (const upload of uploads) input.uploadedDestinations.push(upload.destination);
      },
    },
  };
}

describe("daytona file-sync inbound scratch cleanup", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("removes the reserved scratch tar when a directory extraction fails", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-daytona-scratch-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "referenced-project");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "README.md"), "referenced project\n", "utf8");

    const remoteDir = "/workspace";
    const targetPath = "/workspace/.paperclip-runtime/test-adapter/project-abc";
    const uploadedDestinations: string[] = [];
    const commands: RecordedCommand[] = [];
    // Fail the extract round trip (the only command that runs `tar -xf`).
    const sandbox = createMockSandbox({
      failCommandMatch: /tar -xf/,
      uploadedDestinations,
      commands,
    });

    const operations: PluginSyncOperation[] = [{
      operationId: "sync-op-1",
      files: [{ sourcePath: sourceDir, targetPath, kind: "directory" }],
    }];

    await expect(
      performSyncIn({
        // The mock stands in for the Daytona SDK Sandbox; only the two methods the
        // inbound directory path calls are needed.
        sandbox: sandbox as never,
        operations,
        remoteDir,
        timeoutSeconds: 30,
      }),
    ).rejects.toThrow(/syncIn extract/);

    // The runtime uploaded exactly one reserved scratch tar under the workspace
    // root. Its name carries the reserved `.paperclip-upload-` prefix.
    expect(uploadedDestinations).toHaveLength(1);
    const scratchTar = uploadedDestinations[0];
    expect(scratchTar).toContain(".paperclip-upload-");
    expect(scratchTar.startsWith(`${remoteDir}/`)).toBe(true);

    // The failure path swept the scratch tar: a standalone `rm -f` of the exact
    // scratch path ran after the failed extract. The extract command itself also
    // contains an `rm -f`, so the cleanup is the `rm -f` command that does NOT run
    // `tar -xf`.
    const cleanupCommands = commands.filter(
      (entry) =>
        entry.command.includes(scratchTar) &&
        entry.command.includes("rm -f") &&
        !entry.command.includes("tar -xf"),
    );
    expect(cleanupCommands.length).toBeGreaterThan(0);
  });

  it("does not sweep scratch on the happy path (extract removes it)", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-daytona-scratch-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "referenced-project");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "README.md"), "referenced project\n", "utf8");

    const remoteDir = "/workspace";
    const targetPath = "/workspace/.paperclip-runtime/test-adapter/project-abc";
    const uploadedDestinations: string[] = [];
    const commands: RecordedCommand[] = [];
    // No failure: every command succeeds, so the extract's own `rm -f` clears the
    // scratch and no extra cleanup round trip runs.
    const sandbox = createMockSandbox({ uploadedDestinations, commands });

    const operations: PluginSyncOperation[] = [{
      operationId: "sync-op-1",
      files: [{ sourcePath: sourceDir, targetPath, kind: "directory" }],
    }];

    await performSyncIn({
      sandbox: sandbox as never,
      operations,
      remoteDir,
      timeoutSeconds: 30,
    });

    const scratchTar = uploadedDestinations[0];
    // The standalone cleanup command (a `rm -f` without `tar -xf`) never runs on the
    // happy path — only the extract command, which ends with its own `rm -f`.
    const standaloneRemoves = commands.filter(
      (entry) =>
        entry.command.includes(scratchTar) &&
        entry.command.includes("rm -f") &&
        !entry.command.includes("tar -xf"),
    );
    expect(standaloneRemoves).toHaveLength(0);
  });
});
