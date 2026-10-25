import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HELPER_PATH = path.resolve("skills/paperclip/scripts/paperclip-api.sh");

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  authorization: string | undefined;
  runId: string | string[] | undefined;
  contentType: string | undefined;
}

async function realCurl() {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("bash", ["-c", "command -v curl"]);
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
}

describe("paperclip api helper", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function startServer(status: number, responseBody: string) {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body,
          authorization: req.headers.authorization,
          runId: req.headers["x-paperclip-run-id"],
          contentType: req.headers["content-type"],
        });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(responseBody);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, requests };
  }

  function runHelper(apiUrl: string, args: string[], input?: string, extraEnv: Record<string, string> = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("bash", [HELPER_PATH, ...args], {
        env: { ...process.env, PAPERCLIP_API_URL: apiUrl, PAPERCLIP_API_KEY: "test-key", PAPERCLIP_RUN_ID: "test-run", ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(input);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it.each(["", "/api", "/api/"])("resolves the base URL when PAPERCLIP_API_URL ends with %j", async (suffix) => {
    const { baseUrl, requests } = await startServer(200, '{"id":"agent-1"}');

    const result = await runHelper(`${baseUrl}${suffix}`, ["GET", "/api/agents/me"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: "agent-1" });
    expect(requests[0]).toMatchObject({ method: "GET", url: "/api/agents/me", authorization: "Bearer test-key", runId: "test-run" });
  });

  it("keeps the bearer token out of curl arguments", async () => {
    const { baseUrl, requests } = await startServer(200, "{}");
    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-api-curl-"));
    const argvLog = path.join(shimDir, "argv");
    await fs.writeFile(path.join(shimDir, "curl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexec ${await realCurl()} "$@"\n`, { mode: 0o755 });

    try {
      const result = await runHelper(baseUrl, ["GET", "/api/agents/me"], undefined, { PATH: `${shimDir}:${process.env.PATH}` });

      expect(result.code).toBe(0);
      expect(requests[0]?.authorization).toBe("Bearer test-key");
      const argv = await fs.readFile(argvLog, "utf8");
      expect(argv).toContain("/api/agents/me");
      expect(argv).not.toContain("test-key");
    } finally {
      await fs.rm(shimDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["inline", ['{"title":"a"}'], undefined],
    ["stdin", ["-"], '{"title":"a\\n\\nb"}'],
  ])("sends a JSON body from %s", async (_label, bodyArgs, input) => {
    const { baseUrl, requests } = await startServer(201, '{"id":"issue-1"}');

    const result = await runHelper(baseUrl, ["post", "/api/companies/c1/issues", ...bodyArgs], input);

    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({ method: "POST", url: "/api/companies/c1/issues", contentType: "application/json" });
    expect(requests[0]?.body).toBe(input ?? bodyArgs[0]);
  });

  it("fails on HTTP errors and shows the server response on stderr", async () => {
    const { baseUrl } = await startServer(422, '{"error":"invalid monitor kind"}');

    const result = await runHelper(baseUrl, ["PATCH", "/api/issues/issue-1", '{"status":"done"}']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTP 422");
    expect(result.stderr).toContain("invalid monitor kind");
  });

  it("fails a write that returns an empty body", async () => {
    const { baseUrl } = await startServer(200, "");

    const result = await runHelper(baseUrl, ["PATCH", "/api/issues/issue-1", '{"status":"done"}']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("<empty response>");
  });

  it("fails when the server is unreachable", async () => {
    const result = await runHelper("http://127.0.0.1:1", ["GET", "/api/agents/me"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FAILED");
  });
});
