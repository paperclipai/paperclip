import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const record = (command: string, args: unknown, options: unknown) => {
    if (command === "git" && Array.isArray(args)) recorded.calls.push({ args: args as string[], env: (options as { env?: NodeJS.ProcessEnv } | undefined)?.env });
  };
  const promisified = promisify(actual.execFile);
  const execFile = Object.assign((...args: Parameters<typeof actual.execFile>) => {
    record(args[0], args[1], args[2]);
    return (actual.execFile as (...values: unknown[]) => unknown)(...args);
  }, {
    [promisify.custom]: (command: string, args: string[], options: object) => {
      record(command, args, options);
      return promisified(command, args, options);
    },
  });
  const spawn = (command: string, args: string[], options: import("node:child_process").SpawnOptions) => {
    record(command, args, options);
    return actual.spawn(command, args, options);
  };
  return { ...actual, execFile, spawn, default: { ...actual, execFile, spawn } };
});
// Windows value of os.devNull. Git for Windows rejects it as GIT_CONFIG_GLOBAL.
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  const devNull = "\\\\.\\nul";
  return { ...actual, devNull, default: { ...actual, devNull } };
});

import { currentRestorePointSnapshot } from "../services/git-restore-point.js";
import { assertReproducibleBaseGitStorage, hasCommitsMissingUpstream, verifyRemoteGitCommit } from "../services/git-workspace-restoration.js";

const fixtureEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: fixtureEnv }).trim();
const noAuth = async () => null;

function expectGitNullDevice() {
  const isolated = recorded.calls.filter(call => call.env?.GIT_CONFIG_NOSYSTEM === "1");
  expect(isolated.length).toBeGreaterThan(0);
  for (const call of isolated) expect(call.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  for (const arg of recorded.calls.flatMap(call => call.args).filter(arg => arg.startsWith("core.hooksPath="))) {
    expect(arg).toBe("core.hooksPath=/dev/null");
  }
}

describe("Git config isolation uses /dev/null even where os.devNull is the Windows device path", () => {
  let root: string;
  let repo: string;
  let head: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-null-device-"));
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    git(repo, "init", "--quiet", "-b", "main");
    await fs.writeFile(path.join(repo, "file.txt"), "content\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "--quiet", "-m", "Fixture");
    head = git(repo, "rev-parse", "HEAD");
    recorded.calls = [];
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("restore point snapshots", async () => {
    await fs.writeFile(path.join(repo, "file.txt"), "changed\n");
    await currentRestorePointSnapshot(repo);
    expectGitNullDevice();
  });

  it("remote commit verification", async () => {
    await verifyRemoteGitCommit(repo, head, noAuth);
    expectGitNullDevice();
  });

  it("upstream coverage checks", async () => {
    await expect(hasCommitsMissingUpstream(repo, [head], repo, noAuth)).resolves.toBe(false);
    expectGitNullDevice();
  });

  it("stock Git template comparison", async () => {
    await assertReproducibleBaseGitStorage(repo, undefined, { savedCommitMessage: true });
    expectGitNullDevice();
  });
});
