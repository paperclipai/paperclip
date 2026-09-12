import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The keychain read runs `security`, so the child-process call is mocked. The
// handle lets each test control the result.
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile };
});

import { readClaudeToken } from "./quota.js";

// promisify(execFile) calls the mock with a callback. This helper answers that
// callback with stdout, or with an error.
function keychainReturns(stdout: string): void {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(null, { stdout, stderr: "" });
    return undefined;
  });
}

function keychainFails(message: string): void {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(new Error(message), { stdout: "", stderr: "" });
    return undefined;
  });
}

const CREDENTIALS = JSON.stringify({
  claudeAiOauth: { accessToken: "keychain-token", subscriptionType: "max" },
});

describe("readClaudeToken", () => {
  const cleanupDirs: string[] = [];
  const originalPlatform = process.platform;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }

  async function emptyConfigDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-quota-"));
    cleanupDirs.push(dir);
    process.env.CLAUDE_CONFIG_DIR = dir;
    return dir;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    execFile.mockReset();
    setPlatform(originalPlatform);
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prefers the credentials file over the keychain", async () => {
    const dir = await emptyConfigDir();
    await fs.writeFile(
      path.join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } }),
      "utf8",
    );
    setPlatform("darwin");
    keychainReturns(CREDENTIALS);

    await expect(readClaudeToken()).resolves.toBe("file-token");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reads the keychain on macOS when no credentials file exists", async () => {
    await emptyConfigDir();
    setPlatform("darwin");
    keychainReturns(CREDENTIALS);

    await expect(readClaudeToken()).resolves.toBe("keychain-token");
    const [command, args] = execFile.mock.calls[0] ?? [];
    expect(command).toBe("security");
    expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  });

  it("does not read the keychain on other platforms", async () => {
    await emptyConfigDir();
    setPlatform("linux");
    keychainReturns(CREDENTIALS);

    await expect(readClaudeToken()).resolves.toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns null when the keychain item is absent", async () => {
    await emptyConfigDir();
    setPlatform("darwin");
    keychainFails("The specified item could not be found in the keychain.");

    await expect(readClaudeToken()).resolves.toBeNull();
  });

  it("returns null when the keychain item is not the expected JSON", async () => {
    await emptyConfigDir();
    setPlatform("darwin");
    keychainReturns("not json");

    await expect(readClaudeToken()).resolves.toBeNull();
  });
});
