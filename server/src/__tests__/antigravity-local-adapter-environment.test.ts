// Diagnostics environment tests for Antigravity local adapter
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-antigravity-local/server";

async function writeFakeAgyCommand(binDir: string, argsCapturePath: string): Promise<string> {
  const isWindows = process.platform === "win32";
  const commandPath = path.join(binDir, "agy");
  const jsPath = isWindows ? commandPath + ".js" : commandPath;
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const outPath = process.env.PAPERCLIP_TEST_ARGS_PATH;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(process.argv.slice(2)), "utf8");
}
console.log(JSON.stringify({
  event: "init",
  conversation_id: "test-probe-1",
}));
console.log(JSON.stringify({
  event: "result",
  result: {
    status: "SUCCESS",
    response: "hello",
  },
}));
`;
  await fs.writeFile(jsPath, script, "utf8");
  if (isWindows) {
    const cmdPath = commandPath + ".cmd";
    const cmdScript = `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`;
    await fs.writeFile(cmdPath, cmdScript, "utf8");
    return cmdPath;
  }
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("antigravity_local environment diagnostics", () => {
  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-antigravity-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "antigravity_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "antigravity_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("runs the readiness probe and reports ready", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-antigravity-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const argsCapturePath = path.join(root, "args.json");
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeAgyCommand(binDir, argsCapturePath);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "antigravity_local",
      config: {
        command: "agy",
        cwd,
        env: {
          PAPERCLIP_TEST_ARGS_PATH: argsCapturePath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "antigravity_cli_ready")).toBe(true);
    const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
    expect(args).toContain("--help");
    expect(args).not.toContain("--approval-mode");
    expect(args).not.toContain("yolo");

    await fs.rm(root, { recursive: true, force: true });
  });
});
