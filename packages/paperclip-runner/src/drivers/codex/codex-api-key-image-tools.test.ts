import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { resolvePinnedCodexCommand } from "./codex-command.js";
import { createIsolatedCodexAppServerArgs, createSecuredCodexThreadParams } from "./codex-security-config.js";
import { WORKSPACE } from "./codex-app-server-driver.test-support.js";

/**
 * N-12 (walk step 26): what an OpenAI API-key Codex agent actually gets to call.
 * Drives the pinned Codex app-server with the runner's isolated launch and the
 * API-key auth file the runner writes, against a local Responses endpoint, and
 * reads the tool list from the first model request.
 */
describe("Codex API-key image tools (pinned binary)", () => {
  it("hides Codex's built-in image_gen under API-key auth, so Paperclip's generate_image is the image path", async () => {
    const requests: string[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url?.startsWith("/v1/responses")) requests.push(Buffer.concat(chunks).toString("utf8"));
        // 426 makes Codex fall back from its Responses websocket to HTTP.
        res.writeHead(req.method === "GET" && req.url?.startsWith("/v1/responses") ? 426 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "test endpoint", type: "invalid_request_error" } }));
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    const codexHome = mkdtempSync(join(tmpdir(), "paperclip-n12-api-key-home-"));
    // The same files prepareIsolatedCodexHome writes for an API-key agent.
    writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n[features]\nshell_snapshot = false\n');
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test-not-a-real-key" }), { mode: 0o600 });
    const source = { PATH: process.env.PATH, HOME: codexHome, CODEX_HOME: codexHome };
    const launch = createIsolatedCodexAppServerArgs(source);
    const child = spawn(resolvePinnedCodexCommand(), [...launch.slice(0, -1),
      "-c", `openai_base_url="http://127.0.0.1:${port}/v1"`, "-c", `chatgpt_base_url="http://127.0.0.1:${port}/backend-api"`, launch.at(-1)!], {
      env: source, stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      let nextId = 0;
      const pending = new Map<number, (message: Record<string, unknown>) => void>();
      createInterface({ input: child.stdout! }).on("line", line => {
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (typeof message.id === "number" && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
        } catch { /* notifications and logs */ }
      });
      const call = (method: string, params: unknown) => new Promise<Record<string, unknown>>(done => {
        const id = ++nextId;
        pending.set(id, done);
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
      await call("initialize", { clientInfo: { name: "paperclip-runner", title: "Paperclip Runner", version: "test" }, capabilities: { experimentalApi: true } });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
      const thread = await call("thread/start", {
        ...createSecuredCodexThreadParams(WORKSPACE, "default", true, false, source),
        model: "gpt-5.6-sol",
        dynamicTools: [{ name: "generate_image", description: "Generate a PNG with the agent's existing OpenAI connection.",
          inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } }],
      });
      expect(thread.error).toBeUndefined();
      const threadId = String((thread.result as { thread: { id: string } }).thread.id);
      await call("turn/start", { threadId, input: [{ type: "text", text: "Make a cake logo image." }] });
      const deadline = Date.now() + 30_000;
      while (!requests.length && Date.now() < deadline) await new Promise(done => setTimeout(done, 200));
      expect(requests.length).toBeGreaterThan(0);
      const body = JSON.parse(requests[0]!) as { tools?: Array<Record<string, unknown>>; input: Array<Record<string, unknown>> };
      const names: string[] = [];
      for (const tool of body.tools ?? []) names.push(String(tool.name ?? tool.type));
      for (const item of body.input) {
        if (item.type !== "additional_tools") continue;
        for (const namespace of item.tools as Array<Record<string, unknown>>) {
          for (const tool of (namespace.tools as Array<Record<string, unknown>> | undefined) ?? [namespace]) {
            names.push(`${String(namespace.name ?? namespace.type)}.${String(tool.name ?? tool.type)}`);
          }
        }
      }
      // Codex gates image_gen on ChatGPT/Codex-backend auth, so an API key never gets it.
      expect(names.some(name => /image_gen|imagegen|image_generation/.test(name))).toBe(false);
      // Paperclip's server-side tool does reach the model on this path.
      expect(JSON.stringify(body)).toContain("generate_image");
    } finally {
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(done => child.once("exit", done));
      child.kill("SIGKILL");
      await exited;
      server.close();
      rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90_000);
});
