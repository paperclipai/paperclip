import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { decodeBase32, generateTotp, parseOtpAuthUri } from "./totp.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./totp.mjs", import.meta.url));

test("decodes Base32 secrets", () => {
  assert.equal(decodeBase32("JBSW Y3DP-EHPK3PXP").toString("hex"), "48656c6c6f21deadbeef");
});

test("matches the RFC 6238 SHA-1 vector at 59 seconds", () => {
  const result = generateTotp({
    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    timestampMs: 59_000,
    digits: 8,
    period: 30,
    algorithm: "SHA1",
  });
  assert.equal(result.code, "94287082");
  assert.equal(result.secondsRemaining, 1);
});

test("parses an otpauth URI without exposing account metadata", () => {
  assert.deepEqual(
    parseOtpAuthUri("otpauth://totp/Example:test@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example"),
    {
      secret: "JBSWY3DPEHPK3PXP",
      digits: 6,
      period: 30,
      algorithm: "SHA1",
    },
  );
});

test("downloads the newest Paperclip image and does not expose its reusable seed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-totp-test-"));
  const fakeZbar = path.join(tempRoot, "zbarimg");
  await writeFile(
    fakeZbar,
    "#!/bin/sh\nprintf '%s\\n' 'otpauth://totp/Test:test@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=30'\n",
  );
  await chmod(fakeZbar, 0o755);

  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === "/api/issues/issue-1/heartbeat-context") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        attachments: [{
          id: "attachment-1",
          filename: "authenticator.png",
          contentType: "image/png",
          createdAt: "2026-07-10T00:00:00.000Z",
        }],
      }));
      return;
    }
    if (request.url === "/api/attachments/attachment-1/content") {
      response.setHeader("content-type", "image/png");
      response.end("test-image");
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [scriptPath, "--issue", "issue-1", "--at", "59", "--min-validity", "0"],
      {
        env: {
          ...process.env,
          PATH: `${tempRoot}${path.delimiter}${process.env.PATH || ""}`,
          PAPERCLIP_API_URL: `http://127.0.0.1:${address.port}`,
          PAPERCLIP_API_KEY: "test-token",
        },
      },
    );
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      code: "94287082",
      secondsRemaining: 1,
      digits: 8,
      period: 30,
      source: "Paperclip attachment authenticator.png",
    });
    assert.ok(!stdout.includes("GEZDGNBVGY3TQOJQ"));
    assert.deepEqual(requests, [
      { path: "/api/issues/issue-1/heartbeat-context", authorization: "Bearer test-token" },
      { path: "/api/attachments/attachment-1/content", authorization: "Bearer test-token" },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("enrolls and retrieves native authenticators without emitting the seed", async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/api/companies/company-1/authenticators") {
      response.statusCode = 201;
      response.end(JSON.stringify({ id: "auth-1", name: "Google", agentIds: ["agent-1"] }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/companies/company-1/authenticators") {
      response.end(JSON.stringify([{ id: "auth-1", name: "Google", issuer: "Google", accountName: "person@example.com" }]));
      return;
    }
    if (request.method === "POST" && request.url === "/api/authenticators/auth-1/code") {
      response.end(JSON.stringify({ code: "123456", expiresAt: "2026-07-13T00:00:30.000Z" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const env = {
      ...process.env,
      PAPERCLIP_API_URL: `http://127.0.0.1:${address.port}`,
      PAPERCLIP_API_KEY: "test-token",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_TASK_ID: "issue-1",
      PAPERCLIP_RUN_ID: "run-1",
    };
    const enrolled = await execFileAsync(process.execPath, [scriptPath, "--uri", "otpauth://totp/Google:person@example.com?secret=JBSWY3DPEHPK3PXP", "--save-name", "Google"], { env });
    assert.deepEqual(JSON.parse(enrolled.stdout), { id: "auth-1", name: "Google", agentIds: ["agent-1"], saved: true, source: "otpauth URI" });
    assert.ok(!enrolled.stdout.includes("JBSWY3DPEHPK3PXP"));

    const current = await execFileAsync(process.execPath, [scriptPath, "--current-native", "Google"], { env });
    assert.deepEqual(JSON.parse(current.stdout), { code: "123456", expiresAt: "2026-07-13T00:00:30.000Z", name: "Google", id: "auth-1" });
    assert.deepEqual(requests[0], {
      method: "POST",
      path: "/api/companies/company-1/authenticators",
      body: { name: "Google", secret: "JBSWY3DPEHPK3PXP", agentIds: ["agent-1"] },
    });
    assert.deepEqual(requests.slice(1), [
      { method: "GET", path: "/api/companies/company-1/authenticators", body: null },
      { method: "POST", path: "/api/authenticators/auth-1/code", body: { issueId: "issue-1", runId: "run-1" } },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
