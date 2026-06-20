import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCodexCommandReadyForExecution,
  codexCommandConfigError,
  resolveDefaultCodexCommand,
} from "./codex-command.js";

describe("resolveDefaultCodexCommand", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers PAPERCLIP_CODEX_COMMAND when it points to an executable", () => {
    vi.stubEnv("PAPERCLIP_CODEX_COMMAND", process.execPath);

    expect(resolveDefaultCodexCommand()).toBe(process.execPath);
  });

  it("falls back to a PATH-resolved absolute executable when no override is set", async () => {
    vi.stubEnv("PAPERCLIP_CODEX_COMMAND", "");
    vi.stubEnv("CODEX_COMMAND", "");
    vi.stubEnv("CODEX_BIN", "");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-command-"));
    const commandPath = path.join(root, process.platform === "win32" ? "codex.cmd" : "codex");
    await fs.writeFile(commandPath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(commandPath, 0o755);
    }
    vi.stubEnv("PATH", root);

    const resolved = resolveDefaultCodexCommand();
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(["codex", "codex.cmd", "codex.exe"]).toContain(path.basename(resolved).toLowerCase());

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("assertCodexCommandReadyForExecution", () => {
  it("accepts an absolute executable path", () => {
    expect(assertCodexCommandReadyForExecution(process.execPath)).toBe(process.execPath);
  });

  it("rejects missing or relative commands", () => {
    expect(() => assertCodexCommandReadyForExecution("")).toThrow(codexCommandConfigError());
    expect(() => assertCodexCommandReadyForExecution("codex")).toThrow(codexCommandConfigError());
  });
});
