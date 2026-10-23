import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));

const spec: SshRemoteExecutionSpec = {
  host: "fixture.invalid",
  port: 22,
  username: "fixture",
  remoteWorkspacePath: "/workspace",
  remoteCwd: "/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

interface Exit {
  code: number | null | undefined;
  signal?: NodeJS.Signals | null;
  stderr?: string;
}

const failures: Array<{ name: string; exit: Exit; message: string }> = [
  { name: "null exit", exit: { code: null }, message: "without an exit code" },
  { name: "absent exit", exit: { code: undefined }, message: "without an exit code" },
  { name: "SIGTERM", exit: { code: null, signal: "SIGTERM" }, message: "signal SIGTERM" },
  { name: "SIGKILL", exit: { code: null, signal: "SIGKILL" }, message: "signal SIGKILL" },
  { name: "signal with zero exit", exit: { code: 0, signal: "SIGTERM" }, message: "signal SIGTERM" },
  { name: "nonzero exit", exit: { code: 1, stderr: "remote command failed" }, message: "code 1: remote command failed" },
  { name: "transport EOF", exit: { code: 255, stderr: "fatal: early EOF\nfatal: index-pack failed" }, message: "code 255: fatal: early EOF\nfatal: index-pack failed" },
];

let localDir: string;

function mockProcesses(exits: Partial<Record<"ssh" | "tar", Exit>> = {}) {
  mocks.spawn.mockImplementation((command: "ssh" | "tar") => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn().mockReturnValue(true),
    });
    const exit = exits[command] ?? { code: 0 };
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end(exit.stderr ?? "");
      child.emit("close", exit.code, exit.signal ?? null);
    });
    return child;
  });
}

beforeEach(async () => {
  mocks.spawn.mockReset();
  mocks.execFile.mockReset();
  localDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-exit-test-"));
  await writeFile(path.join(localDir, "preserved.txt"), "existing workspace evidence");
  mocks.execFile.mockImplementation((
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    let stdout = "";
    if (args.includes("--is-inside-work-tree")) stdout = "true\n";
    else if (args.includes("--abbrev-ref")) stdout = "fixture-branch\n";
    else if (args.includes("rev-parse")) stdout = "fixture-head\n";
    if (args.includes("bundle") && args.includes("create")) {
      void writeFile(args[args.indexOf("create") + 1]!, "fixture bundle").then(
        () => callback(null, stdout, ""),
        (error: Error) => callback(error, "", ""),
      );
    } else {
      callback(null, stdout, "");
    }
    return new EventEmitter();
  });
});

afterEach(async () => {
  await rm(localDir, { recursive: true, force: true });
});

describe.each(["to", "from"] as const)("SSH directory transfer %s", (direction) => {
  const transfer = () => direction === "to"
    ? syncDirectoryToSsh({ spec, localDir, remoteDir: spec.remoteCwd })
    : syncDirectoryFromSsh({ spec, localDir, remoteDir: spec.remoteCwd });

  describe.each(["ssh", "tar"] as const)("%s process", (command) => {
    it.each(failures)("rejects $name and preserves the workspace", async ({ exit, message }) => {
      mockProcesses({ [command]: exit });
      await expect(transfer()).rejects.toMatchObject({
        message: expect.stringContaining(message),
        code: exit.code ?? null,
        signal: exit.signal ?? null,
        stderr: exit.stderr ?? "",
      });
      expect(await readFile(path.join(localDir, "preserved.txt"), "utf8"))
        .toBe("existing workspace evidence");
    });
  });

  it("accepts explicit zero exits from both processes", async () => {
    mockProcesses();
    await expect(transfer()).resolves.toBeUndefined();
  });
});

describe.each(["import", "export"] as const)("SSH Git bundle %s", (direction) => {
  it.each(failures)("rejects $name before applying the transferred workspace", async ({ exit, message }) => {
    mockProcesses({ ssh: exit });
    const transfer = direction === "import"
      ? prepareWorkspaceForSshExecution({ spec, localDir })
      : restoreWorkspaceFromSshExecution({ spec, localDir });
    await expect(transfer).rejects.toMatchObject({
      message: expect.stringContaining(message),
      code: exit.code ?? null,
      signal: exit.signal ?? null,
      stderr: exit.stderr ?? "",
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls.some((call) =>
      (call[1] as string[]).includes("fetch") || (call[1] as string[]).includes("reset"),
    )).toBe(false);
    expect(await readFile(path.join(localDir, "preserved.txt"), "utf8"))
      .toBe("existing workspace evidence");
  });

  it("accepts an explicit zero exit before applying the transferred workspace", async () => {
    mockProcesses();
    if (direction === "import") {
      await expect(prepareWorkspaceForSshExecution({ spec, localDir }))
        .resolves.toEqual({ gitBacked: true });
    } else {
      await expect(restoreWorkspaceFromSshExecution({ spec, localDir }))
        .resolves.toBeUndefined();
      expect(mocks.execFile.mock.calls.some((call) => (call[1] as string[]).includes("fetch")))
        .toBe(true);
    }
  });
});

it("reports a failed transfer without a successful progress receipt", async () => {
  mockProcesses({ ssh: { code: null, signal: "SIGTERM" } });
  const progress: string[] = [];
  await expect(syncDirectoryToSsh({
    spec, localDir, remoteDir: spec.remoteCwd, onProgress: (line) => { progress.push(line); },
  })).rejects.toMatchObject({ code: null, signal: "SIGTERM" });
  expect(progress.join("")).not.toContain("100%");
});

it.each(failures)("preserves $name at the SSH command boundary", async ({ exit, message }) => {
  mockProcesses({ ssh: exit });
  await expect(runSshCommand(spec, "cat", { stdin: "fixture input" }))
    .rejects.toMatchObject({
      message: expect.stringContaining(message),
      code: exit.code ?? null,
      signal: exit.signal ?? null,
      stderr: exit.stderr ?? "",
    });
});
