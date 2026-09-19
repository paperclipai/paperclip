import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paperclipCurlLauncherSource, startPaperclipApiPipeBridge } from "./paperclip-api-pipe.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function run(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(process.platform !== "linux")("Paperclip API FIFO bridge", () => {
  it("forwards authenticated GET and mutation calls without exposing a TCP socket to the child", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-api-pipe-test-"));
    cleanupDirs.push(root);
    const launcherDir = path.join(root, "launcher");
    await fs.mkdir(launcherDir, { recursive: true });
    const launcher = path.join(launcherDir, "curl");
    await fs.writeFile(launcher, paperclipCurlLauncherSource(), { mode: 0o700 });

    const requests: Array<{ method: string; url: string; authorization: string | null; runId: string | null; body: string }> = [];
    const api = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: req.headers.authorization ?? null,
          runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, method: req.method }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      api.once("error", reject);
      api.listen(0, "127.0.0.1", resolve);
    });
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP API test listener");

    const apiToken = "run-api-token";
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const bridge = await startPaperclipApiPipeBridge({ directory: root, apiUrl, apiToken, runId: "run-1" });
    const env = {
      ...process.env,
      PATH: `${launcherDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PAPERCLIP_API_URL: apiUrl,
      PAPERCLIP_API_KEY: apiToken,
      ...bridge.env,
    };
    try {
      const get = await run(launcher, [
        "-sS",
        "-H", `Authorization: Bearer ${apiToken}`,
        `${apiUrl}/api/agents/me`,
      ], env);
      expect(get).toEqual({ code: 0, stdout: '{"ok":true,"method":"GET"}', stderr: "" });

      const post = await run(launcher, [
        "-sS", "-X", "POST",
        "-H", `Authorization: Bearer ${apiToken}`,
        "-H", "Content-Type: application/json",
        "-H", "X-Paperclip-Run-Id: wrong-run",
        "-d", '{"body":"bridge proof"}',
        "-w", "\n%{http_code}",
        `${apiUrl}/api/issues/issue-1/comments`,
      ], env);
      expect(post).toEqual({ code: 0, stdout: '{"ok":true,"method":"POST"}\n200', stderr: "" });
      expect(requests).toEqual([
        { method: "GET", url: "/api/agents/me", authorization: `Bearer ${apiToken}`, runId: "run-1", body: "" },
        { method: "POST", url: "/api/issues/issue-1/comments", authorization: `Bearer ${apiToken}`, runId: "run-1", body: '{"body":"bridge proof"}' },
      ]);
    } finally {
      await bridge.stop();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
    await expect(fs.access(bridge.env.PAPERCLIP_API_BROKER_PIPE)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
