import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

// Regression tests for paperclipai/paperclip#15531.
//
// `startNetworkAllowlistProxy` hands the CONNECT `clientSocket` to its handler
// with no `'error'` listener, so an agent dropping a tunnel (mid-stream reset,
// or a reset before the proxy finished writing the 200/denial) surfaces as an
// unhandled `'error'` event that exits the whole server process. The plain-HTTP
// branch additionally leaks one upstream connection per aborted request.
//
// The crash paths must not run inside this vitest worker: the point is that
// the buggy code *exits the process*. Each scenario therefore runs in its own
// child node process (harness below) that starts the real proxy by importing
// the real `local-process-sandbox.ts` source (type stripping; engines requires
// node >= 24.11) and reports outcomes as one `RESULT {json}` line. The test
// asserts exit code 0 (no unhandled error killed the harness) plus the JSON
// payload (probe tunnel still answered, zero leaked upstream connections).

const execFileAsync = promisify(execFile);

const MODULE_UNDER_TEST = fileURLToPath(new URL("./local-process-sandbox.ts", import.meta.url));

const HARNESS_SOURCE = String.raw`
// Spawned by local-process-sandbox-network-proxy.test.ts.
// argv[2] = absolute path of local-process-sandbox.ts, argv[3] = scenario.
import http from "node:http";
import net from "node:net";
import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MODULE_PATH = process.argv[2];
const SCENARIO = process.argv[3];
const TUNNEL_DROPS = 50; // 25 mid-stream + 25 before the proxy answered
const ABORTED_POSTS = 50;

const watchdog = setTimeout(() => {
  report({ ok: false, error: "harness watchdog timeout" });
}, 90_000);
watchdog.unref();

function report(payload) {
  // Synchronous write: console.log to a piped stdout is async and a following
  // process.exit() would drop the line the parent test needs to parse.
  writeSync(1, "RESULT " + JSON.stringify(payload) + "\n");
  process.exit(payload.ok ? 0 : 2);
}

// The harness intentionally resets its own sockets; never let that kill it.
function silence(socket) {
  socket.on("error", () => {});
  return socket;
}

function settle(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// TCP target that keeps streaming 64 KiB chunks and counts live connections.
function startStreamingTarget() {
  return new Promise((resolveTarget, rejectTarget) => {
    let live = 0;
    const server = net.createServer((socket) => {
      live += 1;
      socket.on("close", () => { live -= 1; });
      silence(socket);
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const timer = setInterval(() => {
        if (socket.destroyed) {
          clearInterval(timer);
          return;
        }
        socket.write(chunk);
      }, 5);
      socket.on("close", () => clearInterval(timer));
    });
    server.on("error", rejectTarget);
    server.listen(0, "127.0.0.1", () => resolveTarget({
      port: server.address().port,
      liveCount: () => live,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    }));
  });
}

// HTTP target that answers only once the request body is complete, counting
// the raw TCP connections underneath (that is what the leak keeps open: an
// aborted upload never completes, so the target never answers and the proxy's
// upstream socket stays attached to it).
function startSlowPostTarget() {
  return new Promise((resolveTarget, rejectTarget) => {
    let live = 0;
    const server = http.createServer((request, response) => {
      let received = 0;
      request.on("data", (chunk) => { received += chunk.length; });
      request.on("end", () => response.end("ok\n"));
    });
    server.on("connection", (socket) => {
      live += 1;
      socket.on("close", () => { live -= 1; });
      silence(socket);
    });
    server.on("error", rejectTarget);
    server.listen(0, "127.0.0.1", () => resolveTarget({
      port: server.address().port,
      liveCount: () => live,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    }));
  });
}

// Opens CONNECT host:port through the proxy on a raw socket.
// earlyDestroyMs > 0 destroys the client before the proxy answers.
// Otherwise it waits for "200 Connection Established" + readBytes tunnel data
// and then destroys the client mid-stream.
function tunnelDrop(socketPath, hostPort, { earlyDestroyMs = 0, readBytes = 256 * 1024 } = {}) {
  return new Promise((resolve) => {
    const client = silence(net.connect(socketPath));
    const outcome = { established: false, bytes: 0 };
    let buffer = Buffer.alloc(0);
    const finish = () => resolve(outcome);
    client.on("close", finish);
    if (earlyDestroyMs > 0) {
      client.write("CONNECT " + hostPort + " HTTP/1.1\r\n\r\n");
      setTimeout(() => {
        client.destroy();
        setTimeout(finish, 25);
      }, earlyDestroyMs);
      return;
    }
    client.on("data", (chunk) => {
      if (!outcome.established) {
        buffer = Buffer.concat([buffer, chunk]);
        const headEnd = buffer.indexOf("\r\n\r\n");
        if (headEnd === -1) return;
        const head = buffer.slice(0, headEnd).toString("utf8");
        if (!head.startsWith("HTTP/1.1 200")) {
          client.destroy();
          return;
        }
        outcome.established = true;
        outcome.bytes = buffer.length - (headEnd + 4);
        buffer = Buffer.alloc(0);
      } else {
        outcome.bytes += chunk.length;
      }
      if (outcome.bytes >= readBytes) client.destroy();
    });
    client.write("CONNECT " + hostPort + " HTTP/1.1\r\n\r\n");
  });
}

// Aborts one POST mid-body through the plain-HTTP proxy branch.
function abortedPost(socketPath, targetUrl) {
  return new Promise((resolve) => {
    const request = http.request({
      socketPath,
      method: "POST",
      path: targetUrl,
      headers: { "content-length": String(4 * 1024 * 1024) },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve());
      response.on("error", () => resolve());
    });
    request.on("error", () => resolve());
    request.write(Buffer.alloc(64 * 1024));
    setTimeout(() => {
      request.destroy();
      setTimeout(resolve, 25);
    }, 30);
  });
}

async function waitFor(predicate, { timeoutMs = 10_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value = await predicate();
  while (!value && Date.now() < deadline) {
    await settle(everyMs);
    value = await predicate();
  }
  return value;
}

const mod = await import(MODULE_PATH);
const startNetworkAllowlistProxy = mod.startNetworkAllowlistProxy;
if (typeof startNetworkAllowlistProxy !== "function") {
  report({ ok: false, error: "startNetworkAllowlistProxy is not exported from the module under test" });
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-proxy-harness-"));
try {
  const proxySocket = path.join(workspace, "proxy.sock");

  if (SCENARIO === "connect-drop") {
    const target = await startStreamingTarget();
    const proxy = await startNetworkAllowlistProxy(["127.0.0.1:" + target.port], [], proxySocket);
    try {
      for (let i = 0; i < TUNNEL_DROPS; i += 1) {
        await tunnelDrop(proxySocket, "127.0.0.1:" + target.port, { earlyDestroyMs: 1 + (i % 3) });
        await tunnelDrop(proxySocket, "127.0.0.1:" + target.port, { readBytes: 64 * 1024 });
      }
      const probe = await tunnelDrop(proxySocket, "127.0.0.1:" + target.port, { readBytes: 64 * 1024 });
      const drained = await waitFor(() => target.liveCount() === 0);
      report({
        ok: drained && probe.established,
        dropped: TUNNEL_DROPS * 2,
        upstreamLeaked: target.liveCount(),
        probeEstablished: probe.established,
      });
    } finally {
      await proxy.close();
      await target.close();
    }
  } else if (SCENARIO === "deny-drop") {
    const target = await startStreamingTarget();
    const proxy = await startNetworkAllowlistProxy(["127.0.0.1:" + target.port], [], proxySocket);
    try {
      for (let i = 0; i < TUNNEL_DROPS; i += 1) {
        await tunnelDrop(proxySocket, "denied.example.invalid:443", { earlyDestroyMs: 1 + (i % 3) });
      }
      const probe = await tunnelDrop(proxySocket, "127.0.0.1:" + target.port, { readBytes: 64 * 1024 });
      report({
        ok: probe.established,
        denied: TUNNEL_DROPS,
        probeEstablished: probe.established,
      });
    } finally {
      await proxy.close();
      await target.close();
    }
  } else if (SCENARIO === "http-abort-leak") {
    const target = await startSlowPostTarget();
    const proxy = await startNetworkAllowlistProxy(["127.0.0.1:" + target.port], [], proxySocket);
    try {
      for (let i = 0; i < ABORTED_POSTS; i += 1) {
        await abortedPost(proxySocket, "http://127.0.0.1:" + target.port + "/upload");
      }
      const drained = await waitFor(() => target.liveCount() === 0);
      report({
        ok: drained,
        aborted: ABORTED_POSTS,
        upstreamLeaked: target.liveCount(),
      });
    } finally {
      await proxy.close();
      await target.close();
    }
  } else {
    report({ ok: false, error: "unknown scenario: " + SCENARIO });
  }
} catch (error) {
  report({ ok: false, error: String((error && error.stack) || error) });
}
`;

interface HarnessResult {
  ok: boolean;
  error?: string;
  dropped?: number;
  denied?: number;
  aborted?: number;
  upstreamLeaked?: number;
  probeEstablished?: boolean;
}

async function runHarnessScenario(tempDir: string, scenario: string): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  result: HarnessResult | null;
}> {
  const harnessPath = path.join(tempDir, "network-proxy-harness.mjs");
  await writeFile(harnessPath, HARNESS_SOURCE, { mode: 0o600 });
  try {
    const { stdout } = await execFileAsync(process.execPath, [harnessPath, MODULE_UNDER_TEST, scenario], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      killSignal: "SIGKILL",
    });
    return { exitCode: 0, signal: null, stderrTail: "", result: parseResultLine(stdout) };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      signal?: NodeJS.Signals;
      stderr?: string;
      stdout?: string;
      killed?: boolean;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : null,
      signal: failure.signal ?? null,
      stderrTail: (failure.stderr ?? "").slice(-2_000),
      result: parseResultLine(failure.stdout ?? ""),
    };
  }
}

function parseResultLine(stdout: string): HarnessResult | null {
  const line = stdout.split("\n").reverse().find((candidate) => candidate.startsWith("RESULT "));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("RESULT ".length)) as HarnessResult;
  } catch {
    return null;
  }
}

describe.skipIf(process.platform === "win32")("local process sandbox network allowlist proxy resilience", () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
  });

  it("survives an allowlisted agent dropping CONNECT tunnels mid-stream and before the proxy answers", { timeout: 150_000 }, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-proxy-test-"));
    tempDirs.push(tempDir);
    const run = await runHarnessScenario(tempDir, "connect-drop");

    expect(run.exitCode, `harness exited with ${run.exitCode}/${run.signal}, stderr: ${run.stderrTail}`).toBe(0);
    expect(run.stderrTail, "proxy crash diagnostics leaked to the harness stderr").not.toMatch(/error/i);
    expect(run.result, `harness produced no RESULT line; stderr: ${run.stderrTail}`).not.toBeNull();
    expect(run.result?.ok).toBe(true);
    expect(run.result?.dropped).toBe(100);
    expect(run.result?.probeEstablished).toBe(true);
    expect(run.result?.upstreamLeaked).toBe(0);
  });

  it("survives a client resetting while the proxy denies a non-allowlisted CONNECT", { timeout: 150_000 }, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-proxy-test-"));
    tempDirs.push(tempDir);
    const run = await runHarnessScenario(tempDir, "deny-drop");

    expect(run.exitCode, `harness exited with ${run.exitCode}/${run.signal}, stderr: ${run.stderrTail}`).toBe(0);
    expect(run.stderrTail, "proxy crash diagnostics leaked to the harness stderr").not.toMatch(/error/i);
    expect(run.result, `harness produced no RESULT line; stderr: ${run.stderrTail}`).not.toBeNull();
    expect(run.result?.ok).toBe(true);
    expect(run.result?.denied).toBe(50);
    expect(run.result?.probeEstablished).toBe(true);
  });

  it("releases the upstream connection of every aborted plain-HTTP request (50 aborted -> 0 leaked)", { timeout: 150_000 }, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-proxy-test-"));
    tempDirs.push(tempDir);
    const run = await runHarnessScenario(tempDir, "http-abort-leak");

    expect(run.exitCode, `harness exited with ${run.exitCode}, stderr: ${run.stderrTail}`).toBe(0);
    expect(run.result?.ok).toBe(true);
    expect(run.result?.aborted).toBe(50);
    expect(run.result?.upstreamLeaked).toBe(0);
  });
});
