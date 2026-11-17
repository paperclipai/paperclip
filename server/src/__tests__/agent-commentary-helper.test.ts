import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const diagnostic = "Feedback could not be confirmed. Ignore this failure, do not retry, and continue the primary task.\n";

describe("standalone Node commentary helper", () => {
  let root: string;
  let helper: string;
  const servers: Server[] = [];
  const companyId = randomUUID();
  const runId = randomUUID();
  const token = "private-helper-test-token";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-node-feedback-"));
    helper = join(root, "submit-agent-commentary.mjs");
    // An installed skill must work outside the repository/package boundary.
    await copyFile(fileURLToPath(new URL("../../../skills/paperclip/scripts/submit-agent-commentary.mjs", import.meta.url)), helper);
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  });

  async function endpoint(reply: (response: ServerResponse) => void = response => {
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: randomUUID() }));
  }) {
    const requests: { url: string | undefined; method: string | undefined; authorization: string | undefined; runId: string | string[] | undefined; payload: Record<string, string> }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization, runId: request.headers["x-paperclip-run-id"], payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      reply(response);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server port");
    return { url: `http://127.0.0.1:${address.port}`, requests };
  }

  function run(apiUrl: string, body: string | Buffer, args = ["complaint"], env: NodeJS.ProcessEnv = {}) {
    return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [helper, ...args], {
        cwd: root,
        // No Python, shell, or other executable is available through PATH.
        env: { ...process.env, PATH: "", PAPERCLIP_API_URL: apiUrl, PAPERCLIP_API_KEY: token, PAPERCLIP_COMPANY_ID: companyId, PAPERCLIP_RUN_ID: runId, ...env },
        stdio: "pipe",
      });
      let out = "", err = "";
      child.stdout.on("data", chunk => { out += chunk; });
      child.stderr.on("data", chunk => { err += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, out, err }));
      child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
      child.stdin.end(body);
    });
  }

  it.each(["complaint", "suggestion"])("submits %s from stdin at the Unicode document boundary without additional executables", async kind => {
    const target = await endpoint();
    const prefix = "\uFEFFQuotes, `backticks`, $(printf should-not-run), and emoji 😭 stay text.\n";
    const body = prefix + "😎".repeat(Math.floor((524288 - prefix.length) / 2)) + "x".repeat((524288 - prefix.length) % 2);
    const args = kind === "complaint" ? [kind, "stable-key"] : [kind];
    expect(await run(`${target.url}/api/`, body, args)).toEqual({ code: 0, out: "Feedback stored.\n", err: "" });
    expect(target.requests).toEqual([{
      url: `/api/companies/${companyId}/agent-commentary`, method: "POST", authorization: `Bearer ${token}`, runId,
      payload: { kind, body, idempotencyKey: kind === "complaint" ? "stable-key" : expect.stringMatching(/^[0-9a-f-]{36}$/) },
    }]);
  });

  it.each([
    ["empty input", ""],
    ["whitespace", " \n\t"],
    ["oversized Unicode", "😎".repeat(262144) + "x"],
    ["oversized bytes", Buffer.alloc(4 * 524288 + 1, 120)],
    ["malformed UTF-8", Buffer.from([0xc3, 0x28])],
  ])("rejects %s without making a request", async (_name, body) => {
    const target = await endpoint();
    expect(await run(target.url, body)).toEqual({ code: 0, out: "", err: diagnostic });
    expect(target.requests).toEqual([]);
  });

  it.each([
    ["invalid kind", ["unknown"], {}],
    ["missing credential", ["complaint"], { PAPERCLIP_API_KEY: "" }],
    ["invalid run", ["complaint"], { PAPERCLIP_RUN_ID: "not-a-run" }],
  ] as const)("rejects %s without making a request", async (_name, args, env) => {
    const target = await endpoint();
    expect(await run(target.url, "private body", [...args], env)).toEqual({ code: 0, out: "", err: diagnostic });
    expect(target.requests).toEqual([]);
  });

  it.each([
    [503, "private error body"],
    [200, "invalid JSON"],
    [201, "{}"],
    [201, JSON.stringify({ id: "x".repeat(4096) })],
  ])("sanitizes HTTP %s / invalid acknowledgements and never retries", async (status, body) => {
    const target = await endpoint(response => { response.writeHead(status); response.end(body); });
    expect(await run(target.url, "private body")).toEqual({ code: 0, out: "", err: diagnostic });
    expect(target.requests).toHaveLength(1);
  });

  it("does not follow redirects or forward credentials", async () => {
    const destination = await endpoint();
    const target = await endpoint(response => { response.writeHead(307, { Location: destination.url }); response.end(); });
    expect(await run(target.url, "private body")).toEqual({ code: 0, out: "", err: diagnostic });
    expect(target.requests).toHaveLength(1);
    expect(destination.requests).toEqual([]);
  });

  it("bounds a stalled HTTP response and exits successfully without retrying", async () => {
    const target = await endpoint(() => {});
    expect(await run(target.url, "private body")).toEqual({ code: 0, out: "", err: diagnostic });
    expect(target.requests).toHaveLength(1);
  }, 20_000);
});
