import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Isolated remote-startup smoke for the bundled paperclip-tools MCP shim.
 *
 * QA reported (SPO-50, 2026-05-12) that when only the shim source file is
 * synced to a remote execution target, the Node process crashes with
 * ERR_MODULE_NOT_FOUND because @modelcontextprotocol/sdk is not resolvable
 * from the isolated runtime asset directory. These tests guard against
 * regression by:
 *
 *  1. Spawning the *built* shim file from a freshly created tmp dir that has
 *     no reachable node_modules and only the shim itself in scope, and
 *  2. Talking real MCP stdio to it -- initialize + tools/list -- proving the
 *     bundle is functional, not just importable.
 *
 * The test is skipped when the build artifact is absent so source-only test
 * runs (pre-build) keep passing.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// The runtime artifact is the self-contained esbuild bundle, not the tsc-emitted
// .js (which still imports @modelcontextprotocol/sdk from node_modules). The
// bundle name is kept in sync with SHIM_FILENAME in paperclip-tools-mcp.ts.
const SHIM_BUILD_PATH = path.resolve(
  moduleDir,
  "../../dist/server/paperclip-tools-mcp-shim.bundle.js",
);

const hasBuiltShim = fs.existsSync(SHIM_BUILD_PATH);
const itIfBuilt = hasBuiltShim ? it : it.skip;

interface FakeServer {
  url: string;
  close(): Promise<void>;
}

async function startFakePaperclip(): Promise<FakeServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url?.endsWith("/tools")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              name: "paperclip-plugin-hindsight:hindsight_recall",
              description: "Recall",
              parametersSchema: {
                type: "object",
                required: ["query"],
                properties: { query: { type: "string" } },
              },
            },
          ]),
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fake paperclip server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("paperclip-tools MCP shim isolated remote startup", () => {
  let fake: FakeServer;
  const cleanupDirs: string[] = [];

  beforeAll(async () => {
    if (!hasBuiltShim) return;
    fake = await startFakePaperclip();
  });

  afterAll(async () => {
    if (fake) await fake.close();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  itIfBuilt("exits cleanly when run from an isolated dir without env (no module-resolution errors)", () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-shim-isolated-"));
    cleanupDirs.push(isolatedDir);
    const isolatedShim = path.join(isolatedDir, "paperclip-tools-mcp-shim.js");
    fs.copyFileSync(SHIM_BUILD_PATH, isolatedShim);

    const result = spawnSync(process.execPath, [isolatedShim], {
      cwd: isolatedDir,
      env: {
        // Deliberately drop NODE_PATH and PATH so we mimic an isolated runtime
        // and ensure the shim is not silently picking up a sibling tree.
        PATH: "/usr/bin:/bin",
        PAPERCLIP_API_URL: "",
        PAPERCLIP_API_KEY: "",
        PAPERCLIP_COMPANY_ID: "",
        PAPERCLIP_AGENT_ID: "",
      },
      timeout: 10_000,
      encoding: "utf8",
    });

    expect(result.stderr ?? "").not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(result.stderr ?? "").not.toMatch(/Cannot find package/);
    expect(result.stderr ?? "").not.toMatch(/Cannot find module/);
    expect(result.stderr ?? "").toMatch(/required env var PAPERCLIP_API_URL/);
    expect(result.status).toBe(1);
  });

  itIfBuilt("answers MCP initialize + tools/list over stdio from an isolated dir", async () => {
    const isolatedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-shim-isolated-mcp-"));
    cleanupDirs.push(isolatedDir);
    const isolatedShim = path.join(isolatedDir, "paperclip-tools-mcp-shim.js");
    fs.copyFileSync(SHIM_BUILD_PATH, isolatedShim);

    const child = spawn(process.execPath, [isolatedShim], {
      cwd: isolatedDir,
      env: {
        PATH: "/usr/bin:/bin",
        PAPERCLIP_API_URL: fake.url,
        PAPERCLIP_API_KEY: "test-token",
        PAPERCLIP_COMPANY_ID: "company-x",
        PAPERCLIP_AGENT_ID: "agent-x",
        PAPERCLIP_RUN_ID: "run-iso",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    const responses: Array<Record<string, unknown>> = [];
    const responseDeadlinePerStep = 6_000;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx = stdoutBuf.indexOf("\n");
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.length > 0) {
          try {
            responses.push(JSON.parse(line));
          } catch {
            // ignore non-JSON lines from the shim
          }
        }
        idx = stdoutBuf.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });

    const waitForResponseId = (id: number, timeoutMs: number) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          const found = responses.find((message) => (message as { id?: number }).id === id);
          if (found) return resolve(found);
          if (child.exitCode !== null) {
            return reject(
              new Error(
                `shim exited with code ${child.exitCode} before responding to id=${id}; stderr=${stderrBuf}`,
              ),
            );
          }
          if (Date.now() > deadline) {
            return reject(
              new Error(`Timed out waiting for response id=${id}; stderr=${stderrBuf}`),
            );
          }
          setTimeout(tick, 50);
        };
        tick();
      });

    const send = (payload: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "isolated-test", version: "0" },
        },
      });
      const initResponse = await waitForResponseId(1, responseDeadlinePerStep);
      expect(initResponse).toMatchObject({ id: 1 });
      expect((initResponse as { error?: unknown }).error).toBeUndefined();

      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listResponse = await waitForResponseId(2, responseDeadlinePerStep);
      expect(listResponse).toMatchObject({ id: 2 });
      const result = (listResponse as { result?: { tools?: Array<{ name: string }> } }).result;
      expect(result?.tools?.map((t) => t.name)).toEqual(["hindsight_recall"]);

      expect(stderrBuf).not.toMatch(/ERR_MODULE_NOT_FOUND/);
      expect(stderrBuf).not.toMatch(/Cannot find package/);
      expect(stderrBuf).not.toMatch(/Cannot find module/);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
      });
    }
  });
});
