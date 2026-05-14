import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type RunningServer } from "../src/server";

const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    mockExecFile(cmd, args, opts);
    cb(null, "", "");
  },
}));

describe("server /open and /reveal", () => {
  let running: RunningServer;
  let allowedRoot: string;
  let filePath: string;

  beforeEach(() => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "doc-opener-srv-"));
    allowedRoot = join(tmpRoot, "allowed");
    mkdirSync(allowedRoot);
    filePath = join(allowedRoot, "doc.md");
    writeFileSync(filePath, "hello");
    mockExecFile.mockClear();
  });

  afterEach(async () => {
    await running?.close();
  });

  async function start() {
    running = await createServer({
      config: {
        port: 0,
        roots: [allowedRoot],
        allowedOrigins: ["http://localhost:3100"],
      },
      port: 0,
    });
    const addr = running.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async function post(base: string, route: string, body: unknown) {
    return fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "http://localhost:3100",
      },
      body: JSON.stringify(body),
    });
  }

  it("POST /open with valid path returns 200 and calls execFile", async () => {
    const base = await start();
    const res = await post(base, "/open", { path: filePath });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecFile.mock.calls[0]!;
    expect(cmd).toMatch(/^(open|cmd)$/); // darwin or win32 (CI may be either)
    expect(args).toContain(filePath);
  });

  it("POST /reveal with valid path returns 200 and calls execFile", async () => {
    const base = await start();
    const res = await post(base, "/reveal", { path: filePath });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("POST /open with non-existent path returns 404", async () => {
    const base = await start();
    const res = await post(base, "/open", { path: join(allowedRoot, "nope.md") });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not found/i) });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("POST /open with path outside roots returns 403", async () => {
    const base = await start();
    const res = await post(base, "/open", { path: "/etc/hosts" });
    expect(res.status).toBe(403);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("POST /open with empty body returns 400", async () => {
    const base = await start();
    const res = await fetch(`${base}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "http://localhost:3100" },
      body: "",
    });
    expect(res.status).toBe(400);
  });

  it("POST /open with missing path field returns 400", async () => {
    const base = await start();
    const res = await post(base, "/open", { foo: "bar" });
    expect(res.status).toBe(400);
  });

  it("POST /open when config is null returns 503", async () => {
    running = await createServer({ config: null, port: 0 });
    const addr = running.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    const res = await post(base, "/open", { path: filePath });
    expect(res.status).toBe(503);
  });
});
