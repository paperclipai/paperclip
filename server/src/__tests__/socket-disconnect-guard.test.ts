import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createSocketDisconnectGuard,
  installSocketDisconnectGuard,
  isRecoverableSocketDisconnect,
} from "../services/socket-disconnect-guard.js";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const childHelper = fileURLToPath(new URL("./helpers/socket-disconnect-child.ts", import.meta.url));

function socketError(code: string, syscall?: string) {
  return Object.assign(new Error(`write ${code}`), syscall === undefined ? { code } : { code, syscall });
}

async function runChild(mode: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", tsxLoader, childHelper, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr };
}

describe("socket disconnect guard", () => {
  it("treats a broken pipe on a write as a dropped connection", () => {
    expect(isRecoverableSocketDisconnect(socketError("EPIPE", "write"))).toBe(true);
    expect(isRecoverableSocketDisconnect(socketError("EPIPE"))).toBe(true);
  });

  it("keeps every other uncaught exception fatal", () => {
    expect(isRecoverableSocketDisconnect(socketError("EPIPE", "read"))).toBe(false);
    expect(isRecoverableSocketDisconnect(socketError("ECONNRESET", "write"))).toBe(false);
    expect(isRecoverableSocketDisconnect(new TypeError("boom"))).toBe(false);
    expect(isRecoverableSocketDisconnect("write EPIPE")).toBe(false);
    expect(isRecoverableSocketDisconnect(null)).toBe(false);
  });

  it("logs a dropped connection instead of throwing it", () => {
    const warn = vi.fn();
    const guard = createSocketDisconnectGuard(warn);
    const error = socketError("EPIPE", "write");
    expect(() => guard(error)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(error);
  });

  it("installs one process listener and removes it again", () => {
    const before = process.listenerCount("uncaughtException");
    const dispose = installSocketDisconnectGuard(vi.fn());
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    dispose();
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });

  it("lets the next uncaught-exception listener handle an unexpected error", async () => {
    const result = await runChild("crash");
    expect(result.stdout).toContain("sentry:TypeError");
    expect(result.code).toBe(7);
  });

  it("keeps the process alive for a broken write", async () => {
    const result = await runChild("epipe");
    expect(result.stdout).toContain("alive");
    expect(result.stderr).toContain("guard:Error");
    expect(result.code).toBe(0);
  });
});
