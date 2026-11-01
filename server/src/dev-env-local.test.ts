import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devEnvLocalNodeArgs, devEnvLocalWatchArgs, resolveRepoEnvLocalPath } from "./dev-env-local.js";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("dev .env.local loading", () => {
  let repoRoot: string;
  let fakeServerRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-env-local-"));
    fakeServerRoot = path.join(repoRoot, "server");
    mkdirSync(fakeServerRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("resolves the repo-root file from the server root", () => {
    expect(resolveRepoEnvLocalPath(fakeServerRoot)).toBe(path.join(repoRoot, ".env.local"));
  });

  it("always passes the file and a watch glob that works before the file exists", () => {
    const envLocalPath = path.join(repoRoot, ".env.local");
    expect(devEnvLocalNodeArgs(fakeServerRoot)).toEqual([`--env-file-if-exists=${envLocalPath}`]);
    expect(devEnvLocalWatchArgs(fakeServerRoot)).toEqual(["--include", `${envLocalPath}*`]);
  });

  it("wires the same file into the server dev script and the watch wrapper", () => {
    const packageJson = JSON.parse(readFileSync(path.join(serverRoot, "package.json"), "utf8"));
    expect(packageJson.scripts.dev).toContain("--env-file-if-exists=../.env.local");
    const devWatch = readFileSync(path.join(serverRoot, "scripts/dev-watch.ts"), "utf8");
    expect(devWatch).toContain("devEnvLocalNodeArgs(serverRoot)");
    expect(devWatch).toContain("devEnvLocalWatchArgs(serverRoot)");
  });

  it("rereads the file on every process start and lets shell values win", () => {
    const envLocalPath = path.join(repoRoot, ".env.local");
    const read = (env: NodeJS.ProcessEnv) =>
      execFileSync(
        process.execPath,
        [...devEnvLocalNodeArgs(fakeServerRoot), "-e", "process.stdout.write(String(process.env.FOO))"],
        { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );

    expect(read({})).toBe("undefined");
    writeFileSync(envLocalPath, "FOO=first\n");
    expect(read({})).toBe("first");
    writeFileSync(envLocalPath, "FOO=second\n");
    expect(read({})).toBe("second");
    expect(read({ FOO: "shell" })).toBe("shell");
    writeFileSync(envLocalPath, "BAR=other\n");
    expect(read({})).toBe("undefined");
  });

  it("restarts a tsx watch process when the file is created, edited, and deleted", async () => {
    const envLocalPath = path.join(repoRoot, ".env.local");
    const entry = path.join(fakeServerRoot, "entry.ts");
    writeFileSync(entry, 'console.log("FOO=" + process.env.FOO);\n');

    let output = "";
    const child = spawn(
      process.execPath,
      [tsxCliPath, "watch", ...devEnvLocalWatchArgs(fakeServerRoot), ...devEnvLocalNodeArgs(fakeServerRoot), entry],
      { cwd: fakeServerRoot, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    child.stdout.on("data", (chunk) => { output += String(chunk); });

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitForAfter = async (offset: number, expected: string, action?: () => void) => {
      const deadline = Date.now() + 30_000;
      while (!output.slice(offset).includes(expected)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${expected}; saw: ${output}`);
        action?.();
        await sleep(250);
      }
    };

    try {
      await waitForAfter(0, "FOO=undefined");
      await waitForAfter(output.length, "FOO=created", () => writeFileSync(envLocalPath, "FOO=created\n"));
      await waitForAfter(output.length, "FOO=edited", () => writeFileSync(envLocalPath, "FOO=edited\n"));
      await waitForAfter(output.length, "FOO=undefined", () => rmSync(envLocalPath, { force: true }));
      expect(child.exitCode).toBeNull();
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 5_000);
      await exited;
      clearTimeout(timer);
    }
  }, 120_000);
});
