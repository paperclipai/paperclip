import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// End-to-end coverage for scripts/paperclip-issue-update.sh: the helper must
// only exit 0 when the server confirms the write by echoing the update, must
// classify failures (retry connection-level faults and 5xx, never retry a
// definitive 4xx), and must stop at two attempts total to honor the shared
// bounded-write-retry rule.
const HELPER_PATH = path.resolve("scripts/paperclip-issue-update.sh");

interface HelperResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

describe("paperclip issue update helper", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      if (!cleanup) continue;
      await cleanup().catch(() => undefined);
    }
  });

  async function startServer(
    respond: (request: RecordedRequest, attempt: number, res: http.ServerResponse) => void,
  ): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const recorded: RecordedRequest = {
          method: req.method ?? "",
          url: req.url ?? "",
          body,
        };
        requests.push(recorded);
        respond(recorded, requests.length, res);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanupFns.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, requests };
  }

  function runHelper(apiUrl: string, args: string[]): Promise<HelperResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [HELPER_PATH, ...args], {
        env: {
          ...process.env,
          PAPERCLIP_API_URL: apiUrl,
          PAPERCLIP_API_KEY: "test-key",
          PAPERCLIP_RUN_ID: "test-run",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  const doneArgs = ["--issue-id", "issue-1", "--status", "done", "--comment", "closing note"];

  it("exits 0 and prints the issue JSON when the server echoes the requested status", async () => {
    const { baseUrl, requests } = await startServer((request, _attempt, res) => {
      const payload = JSON.parse(request.body) as { status?: string; comment?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "issue-1", status: payload.status }));
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "issue-1", status: "done" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url).toBe("/api/issues/issue-1");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ status: "done", comment: "closing note" });
  });

  it("fails an empty 2xx body instead of treating it as success", async () => {
    const { baseUrl } = await startServer((_request, _attempt, res) => {
      res.writeHead(200, { "content-length": "0" });
      res.end();
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("empty response body");
  });

  it("fails when the server echoes a different status than requested", async () => {
    const { baseUrl } = await startServer((_request, _attempt, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "issue-1", status: "in_progress" }));
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("echoed status in_progress");
  });

  it("does not retry a definitive 4xx rejection", async () => {
    const { baseUrl, requests } = await startServer((_request, _attempt, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "validation" }));
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("rejected (HTTP 422)");
    expect(requests).toHaveLength(1);
  });

  it("retries a 5xx once and succeeds when the retry lands", async () => {
    const { baseUrl, requests } = await startServer((request, attempt, res) => {
      if (attempt === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      const payload = JSON.parse(request.body) as { status?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "issue-1", status: payload.status }));
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(result.stderr).toContain("retrying");
  });

  it("stops after two attempts on connection-level failure and reports the write as not saved", async () => {
    // Bind and close a listener so the port is real but refuses connections.
    const probe = http.createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, "127.0.0.1", resolve);
    });
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });

    const result = await runHelper(`http://127.0.0.1:${port}`, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FAILED after 2 attempts");
    expect(result.stderr).toContain("NOT saved");
  }, 15_000);
});
