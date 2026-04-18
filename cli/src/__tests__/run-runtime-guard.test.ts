import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRunLock, isPidAlive, waitForReadiness } from "../commands/run-runtime-guard.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-run-guard-"));
  tmpDirs.push(dir);
  return dir;
}

describe("run-runtime-guard", () => {
  it("acquires and releases run lock", () => {
    const dir = mkTempDir();
    const lock = acquireRunLock(dir, "default");
    expect(fs.existsSync(lock.lockPath)).toBe(true);
    lock.release();
    expect(fs.existsSync(lock.lockPath)).toBe(false);
  });

  it("blocks when existing live lock owner exists", () => {
    const dir = mkTempDir();
    const lockA = acquireRunLock(dir, "default");
    expect(() => acquireRunLock(dir, "default")).toThrow(/Another paperclipai run appears active/);
    lockA.release();
  });

  it("replaces stale lock", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10)"]);
    const deadPid = child.pid ?? -1;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    const dir = mkTempDir();
    const lockPath = path.join(dir, "run.lock.json");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString(), command: "x", instanceId: "default" }),
      "utf8",
    );
    const lock = acquireRunLock(dir, "default");
    const payload = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number };
    expect(payload.pid).toBe(process.pid);
    lock.release();
  });

  it("waitForReadiness passes in full mode when api and ui are ok", async () => {
    const fetcher = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      return new Response("ok", { status: u.endsWith("/api/health") || u.endsWith("/") ? 200 : 404 });
    };

    const result = await waitForReadiness({
      baseUrl: "http://127.0.0.1:3100",
      mode: "full",
      timeoutMs: 100,
      intervalMs: 10,
      fetcher: fetcher as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.apiOk).toBe(true);
    expect(result.uiOk).toBe(true);
  });

  it("waitForReadiness fails in full mode if ui never becomes available", async () => {
    const fetcher = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      return new Response("x", { status: u.endsWith("/api/health") ? 200 : 404 });
    };

    const result = await waitForReadiness({
      baseUrl: "http://127.0.0.1:3100",
      mode: "full",
      timeoutMs: 60,
      intervalMs: 10,
      fetcher: fetcher as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.apiOk).toBe(true);
    expect(result.uiOk).toBe(false);
  });

  it("waitForReadiness passes in api-only mode when api is ok", async () => {
    const fetcher = async (): Promise<Response> => new Response("ok", { status: 200 });

    const result = await waitForReadiness({
      baseUrl: "http://127.0.0.1:3100",
      mode: "api-only",
      timeoutMs: 100,
      intervalMs: 10,
      fetcher: fetcher as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.apiOk).toBe(true);
    expect(result.uiOk).toBe(true);
  });

  it("isPidAlive works for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});
