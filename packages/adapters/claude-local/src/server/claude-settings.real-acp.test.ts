import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const enabled = process.env.PAPERCLIP_TEST_REAL_CLAUDE_ACP === "1";

describe.skipIf(!enabled)("real Claude ACP project settings", () => {
  it.each([["1", false, false], ["0", true, false], ["1", false, true]])("uses trust mode %s (hook: %s, Runner isolated: %s)", async (userOnly, hookExpected, runnerIsolated) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-acp-test-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");
    const config = path.join(root, "config");
    const marker = path.join(root, "hook-marker");
    const hook = path.join(root, "hook.cjs");
    const userMarker = path.join(root, "user-hook-marker");
    const userHook = path.join(root, "user-hook.cjs");
    let providerRequested!: () => void;
    const requested = new Promise<void>((resolve) => { providerRequested = resolve; });
    const server = createServer((_req, res) => {
      providerRequested();
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "synthetic" } }));
    });
    try {
      await mkdir(path.join(cwd, ".claude"), { recursive: true });
      await mkdir(home); await mkdir(config);
      await writeFile(path.join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
      await writeFile(hook, `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`);
      await writeFile(userHook, `require("fs").writeFileSync(${JSON.stringify(userMarker)}, "ran")`);
      await writeFile(path.join(config, "settings.json"), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node "${userHook}"` }] }] },
      }));
      await writeFile(path.join(cwd, ".claude", "settings.json"), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node "${hook}"` }] }] },
      }));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test server address");
      const provider = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
      const child = spawn(process.execPath, [provider], { cwd, env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "synthetic",
        PAPERCLIP_LEGACY_CLAUDE_USER_ONLY: userOnly,
        PAPERCLIP_LEGACY_CLAUDE_SETTINGS: JSON.stringify({ permissions: { defaultMode: "default" },
          ...(runnerIsolated ? { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node "${hook}"` }] }] } } : {}) }),
        ...(runnerIsolated ? { PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1" } : {}),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CI: "1",
      } });
      try {
        let buffered = "";
        const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        const failed = new Promise<never>((_resolve, reject) => {
          child.once("error", reject);
          child.once("exit", () => reject(new Error("ACP provider exited before the synthetic provider request")));
          child.stdout.on("data", (chunk: Buffer) => {
            buffered += chunk.toString();
            const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
            for (const line of lines) {
              let message: { id?: number; result?: { sessionId?: string }; error?: unknown };
              try { message = JSON.parse(line); } catch { continue; }
              if (message.error && (message.id === 1 || message.id === 2)) { reject(new Error(`ACP setup failed: ${JSON.stringify(message.error)}`)); continue; }
              if (message.id === 1 && message.result) send(2, "session/new", { cwd, mcpServers: [], _meta: { claudeCode: { options: { settingSources: ["project", "local"] } } } });
              if (message.id === 2 && message.result?.sessionId) send(3, "session/prompt", { sessionId: message.result.sessionId, prompt: [{ type: "text", text: "test" }] });
            }
          });
        });
        send(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: "paperclip-test", version: "1" } });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([requested, failed, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("ACP probe timed out")), 40000); })]);
          // The provider can make an authentication preflight request before
          // the SessionStart hook runs. Give startup time to reach the hook.
          let hookRan = false;
          let userHookRan = false;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            hookRan = await readFile(marker, "utf8").then(() => true, () => false);
            userHookRan = await readFile(userMarker, "utf8").then(() => true, () => false);
            if (hookRan && userHookRan) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          expect(hookRan).toBe(hookExpected);
          expect(userHookRan).toBe(true);
        } finally { if (timeout) clearTimeout(timeout); }
      } finally {
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill();
        await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
    }
  }, 50000);
});
