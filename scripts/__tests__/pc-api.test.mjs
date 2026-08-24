// Tests for scripts/pc-api.sh — the blessed Paperclip API client.
//
// The defect this script exists to prevent: bare `curl -sS` exits 0 on 4xx, so
// `| jq -r '.id'` renders a rejection as "null" and a dropped write looks like a
// success. These tests pin the loud-failure contract for 403 and 404: non-zero
// exit, and the server's `error` string on stderr where run logs will catch it.
//
// Deliberately lives in scripts/__tests__/ (node:test, no DB) rather than
// server/src/__tests__/, which pays a ~90s embedded-Postgres globalSetup boot
// for a bash script that touches no database.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "..", "pc-api.sh");

/**
 * Boot a stub HTTP server that answers every request with the supplied status
 * and JSON payload, recording what it received.
 */
async function withStubServer(handler, run) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run({ baseUrl: `http://127.0.0.1:${port}`, received });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonResponder(status, payload) {
  return (_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
}

function runScript(args, env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [scriptPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const baseEnv = (baseUrl) => ({
  PAPERCLIP_API_URL: baseUrl,
  PAPERCLIP_API_KEY: "test-key",
  PAPERCLIP_RUN_ID: "test-run-id",
});

test("pc-api.sh exits non-zero and reports the error on stderr for 403", async () => {
  await withStubServer(
    jsonResponder(403, { error: "Agent is not assigned to this issue" }),
    async ({ baseUrl }) => {
      const result = await runScript(
        ["patch", "/api/issues/abc", '{"status":"done"}'],
        baseEnv(baseUrl),
      );

      assert.notEqual(result.code, 0, "403 must produce a non-zero exit code");
      assert.match(result.stderr, /HTTP 403/);
      assert.match(result.stderr, /Agent is not assigned to this issue/);
      // Critical: nothing on stdout, so `| jq -r '.id'` cannot yield a fake id.
      assert.equal(result.stdout.trim(), "");
    },
  );
});

test("pc-api.sh exits non-zero and reports the error on stderr for 404", async () => {
  await withStubServer(
    jsonResponder(404, { error: "Issue not found" }),
    async ({ baseUrl }) => {
      const result = await runScript(
        ["get", "/api/issues/does-not-exist"],
        baseEnv(baseUrl),
      );

      assert.notEqual(result.code, 0, "404 must produce a non-zero exit code");
      assert.match(result.stderr, /HTTP 404/);
      assert.match(result.stderr, /Issue not found/);
      assert.equal(result.stdout.trim(), "");
    },
  );
});

test("pc-api.sh emits only the JSON body on stdout for 2xx", async () => {
  await withStubServer(
    jsonResponder(200, { id: "issue-123", status: "done" }),
    async ({ baseUrl, received }) => {
      const result = await runScript(
        ["patch", "/api/issues/issue-123", '{"status":"done"}'],
        baseEnv(baseUrl),
      );

      assert.equal(result.code, 0, result.stderr);
      // Drop-in for raw curl: parseable by jq with no extra noise.
      assert.deepEqual(JSON.parse(result.stdout), { id: "issue-123", status: "done" });

      const req = received.at(-1);
      assert.equal(req.method, "PATCH");
      assert.equal(req.headers.authorization, "Bearer test-key");
      assert.equal(req.headers["content-type"], "application/json");
      assert.equal(req.headers["x-paperclip-run-id"], "test-run-id");
      assert.equal(req.body, '{"status":"done"}');
    },
  );
});

test("pc-api.sh normalizes an /api-suffixed base URL without doubling the segment", async () => {
  await withStubServer(jsonResponder(200, { ok: true }), async ({ baseUrl, received }) => {
    const result = await runScript(["get", "/api/agents/me"], {
      ...baseEnv(baseUrl),
      PAPERCLIP_API_URL: `${baseUrl}/api/`,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(received.at(-1).url, "/api/agents/me");
  });
});

test("pc-api.sh omits the run-id header on GET requests", async () => {
  await withStubServer(jsonResponder(200, { ok: true }), async ({ baseUrl, received }) => {
    const result = await runScript(["get", "/api/agents/me"], baseEnv(baseUrl));

    assert.equal(result.code, 0, result.stderr);
    assert.equal(received.at(-1).headers["x-paperclip-run-id"], undefined);
  });
});

test("pc-api.sh surfaces a non-JSON error body on stderr", async () => {
  await withStubServer(
    (_req, res) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("upstream unavailable");
    },
    async ({ baseUrl }) => {
      const result = await runScript(["get", "/api/agents/me"], baseEnv(baseUrl));

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /HTTP 502/);
      assert.match(result.stderr, /upstream unavailable/);
      assert.equal(result.stdout.trim(), "");
    },
  );
});

test("pc-api.sh rejects the removed --py flag instead of eval'ing input", async () => {
  const result = await runScript(["--py", ".id", "get", "/api/agents/me"], {
    PAPERCLIP_API_URL: "http://127.0.0.1:1",
    PAPERCLIP_API_KEY: "test-key",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--py was removed/);
});

test("pc-api.sh fails fast when required env vars are missing", async () => {
  const result = await runScript(["get", "/api/agents/me"], {
    PAPERCLIP_API_URL: "",
    PAPERCLIP_API_KEY: "",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PAPERCLIP_API_URL not set/);
});
