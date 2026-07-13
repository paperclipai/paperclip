import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLocalProcessSandboxSpawnTarget, parseLocalProcessSandboxExtraPaths } from "./local-process-sandbox.js";
import { runChildProcess } from "./server-utils.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

describe("local process sandbox", () => {
  it("parses read-only and writable extra paths", () => {
    expect(parseLocalProcessSandboxExtraPaths(["/opt/cache", { path: "/var/lib/tool", access: "rw" }])).toEqual([
      { path: "/opt/cache", access: "ro" },
      { path: "/var/lib/tool", access: "rw" },
    ]);
    expect(() => parseLocalProcessSandboxExtraPaths(["relative"])).toThrow("must be an absolute path");
  });

  it("builds a fresh-root bubblewrap command with workspace access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const managedHome = path.join(root, "managed-home");
    await fs.mkdir(workspace);
    await fs.mkdir(managedHome);
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: workspace,
      options: { workspaceDir: workspace, managedPaths: [{ path: managedHome, access: "rw" }], homeDir: managedHome },
    });
    expect(target.command).toBe("bwrap");
    expect(target.args).toContain("--tmpfs");
    expect(target.args).toContain(workspace);
    expect(target.args).toContain(managedHome);
  });

  it("fails clearly when Bubblewrap is unavailable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-missing-"));
    cleanup.push(workspace);
    await expect(runChildProcess("filesystem-sandbox-missing", process.execPath, ["-e", "process.exit(0)"], {
      cwd: workspace, env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {},
      localProcessSandbox: { workspaceDir: workspace, command: path.join(workspace, "missing-bwrap") },
    })).rejects.toThrow("requires Bubblewrap");
  });

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))("blocks an outside canary and permits declared paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-integration-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "canary.txt");
    const allowed = path.join(root, "allowed.txt");
    await fs.mkdir(workspace);
    await fs.writeFile(outside, "host-secret", "utf8");
    await fs.writeFile(allowed, "allowed-value", "utf8");
    const script = [
      "const fs = require('node:fs');",
      `try { fs.readFileSync(${JSON.stringify(outside)}, 'utf8'); process.exit(9); } catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }`,
      `if (fs.readFileSync(${JSON.stringify(allowed)}, 'utf8') !== 'allowed-value') process.exit(8);`,
      "fs.writeFileSync('workspace-ok.txt', 'ok');",
    ].join("\n");
    const result = await runChildProcess("filesystem-sandbox-test", process.execPath, ["-e", script], {
      cwd: workspace, env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {},
      localProcessSandbox: { workspaceDir: workspace, extraPaths: [{ path: allowed, access: "ro" }], command: process.env.PAPERCLIP_TEST_BWRAP },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    await expect(fs.readFile(path.join(workspace, "workspace-ok.txt"), "utf8")).resolves.toBe("ok");
  });

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP && process.env.PAPERCLIP_TEST_SANDBOX_BUILD))("runs a TypeScript build inside the confined workspace", async () => {
    const workspace = process.cwd();
    const result = await runChildProcess("filesystem-sandbox-build-test", path.join(workspace, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", "packages/adapter-utils/tsconfig.json"], {
      cwd: workspace, env: {}, timeoutSec: 60, graceSec: 2, onLog: async () => {},
      localProcessSandbox: { workspaceDir: workspace, command: process.env.PAPERCLIP_TEST_BWRAP },
    });
    expect(result.exitCode, result.stderr).toBe(0);
  });
});
