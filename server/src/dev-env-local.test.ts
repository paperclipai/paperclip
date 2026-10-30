import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devEnvLocalNodeArgs, devEnvLocalWatchArgs, resolveRepoEnvLocalPath } from "./dev-env-local.js";

describe("dev .env.local loading", () => {
  let repoRoot: string;
  let serverRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-env-local-"));
    serverRoot = path.join(repoRoot, "server");
    mkdirSync(serverRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("resolves the repo-root file from the server root", () => {
    expect(resolveRepoEnvLocalPath(serverRoot)).toBe(path.join(repoRoot, ".env.local"));
  });

  it("adds no arguments when the file is absent", () => {
    expect(devEnvLocalNodeArgs(serverRoot)).toEqual([]);
    expect(devEnvLocalWatchArgs(serverRoot)).toEqual([]);
  });

  it("passes the file to Node and to the watcher when it exists", () => {
    const envLocalPath = path.join(repoRoot, ".env.local");
    writeFileSync(envLocalPath, "FOO=from_file\n");
    expect(devEnvLocalNodeArgs(serverRoot)).toEqual([`--env-file=${envLocalPath}`]);
    expect(devEnvLocalWatchArgs(serverRoot)).toEqual(["--include", envLocalPath]);
  });

  it("rereads the file on every process start and lets shell values win", () => {
    const envLocalPath = path.join(repoRoot, ".env.local");
    const read = (env: NodeJS.ProcessEnv) =>
      execFileSync(
        process.execPath,
        [...devEnvLocalNodeArgs(serverRoot), "-e", "process.stdout.write(String(process.env.FOO))"],
        { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" },
      );

    writeFileSync(envLocalPath, "FOO=first\n");
    expect(read({})).toBe("first");
    writeFileSync(envLocalPath, "FOO=second\n");
    expect(read({})).toBe("second");
    expect(read({ FOO: "shell" })).toBe("shell");
    writeFileSync(envLocalPath, "BAR=other\n");
    expect(read({})).toBe("undefined");
  });
});
