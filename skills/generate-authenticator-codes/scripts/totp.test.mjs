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
