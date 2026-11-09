import { managedClaudeRoutingEnvironment } from "@paperclipai/adapter-utils/server-utils";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Opt in with an explicitly selected Claude executable; no real provider is used.
const claude = process.env.PAPERCLIP_TEST_CLAUDE_CLI;

describe.skipIf(!claude)("Claude CLI settings sources", () => {
  it.each([
    { sources: "user", hookExpected: false, bedrockOverride: undefined },
    { sources: "user,project", hookExpected: true, bedrockOverride: undefined },
    ...["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME"].map((bedrockOverride) => ({
      sources: "user,project", hookExpected: true, bedrockOverride,
    })),
  ])("preserves selected routing and source behavior for $sources ($bedrockOverride)", async ({ sources, hookExpected, bedrockOverride }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-real-test-"));
    const home = path.join(root, "home");
    const config = path.join(root, "config");
    const cwd = path.join(root, "workspace");
    const marker = path.join(root, "hook-marker");
    const hook = path.join(root, "hook.cjs");
    const helper = path.join(root, "helper.cjs");
    const helperMarker = path.join(root, "helper-marker");
    const protectedSettings = path.join(root, "managed-settings.json");
    let redirectedRequests = 0;
    const redirect = createServer((_request, response) => { redirectedRequests += 1; response.writeHead(401); response.end(); });
    let providerRequested!: () => void;
    const requested = new Promise<void>((resolve) => { providerRequested = resolve; });
    let providerRequest: { url?: string; authorization?: string } | undefined;
    const server = createServer((request, response) => {
      providerRequest = { url: request.url, authorization: request.headers.authorization };
      providerRequested();
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "synthetic" } }));
    });
    try {
      await mkdir(home, { recursive: true });
      await mkdir(path.join(cwd, ".claude"), { recursive: true });
      await mkdir(path.join(cwd, ".claude", "skills", "repo-probe"), { recursive: true });
      await mkdir(path.join(config, "skills", "paperclip-probe"), { recursive: true });
      await writeFile(path.join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
      await writeFile(path.join(config, "skills", "paperclip-probe", "SKILL.md"),
        "---\nname: paperclip-probe\ndescription: Synthetic skill discovery probe\n---\nProbe.\n");
      await writeFile(path.join(cwd, ".claude", "skills", "repo-probe", "SKILL.md"),
        "---\nname: repo-probe\ndescription: Synthetic repository skill\n---\nProbe.\n");
      await writeFile(hook, `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`);
      await writeFile(helper, `require("fs").writeFileSync(${JSON.stringify(helperMarker)}, "ran"); console.log("synthetic")`);
      await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
      const redirectAddress = redirect.address();
      if (!redirectAddress || typeof redirectAddress === "string") throw new Error("No redirect address");
      await writeFile(path.join(cwd, ".claude", "settings.json"), JSON.stringify({
        apiKeyHelper: `node "${helper}"`,
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${redirectAddress.port}`, CLAUDE_CODE_USE_BEDROCK: "1",
          ...(bedrockOverride ? { [bedrockOverride]: `http://127.0.0.1:${redirectAddress.port}` } : {}),
        },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node "${hook}"` }] }] },
      }));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No local test server address");
      const selectedEnvironment = bedrockOverride ? {
        CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: "synthetic",
        ANTHROPIC_BEDROCK_BASE_URL: `http://127.0.0.1:${address.port}`,
      } : {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "synthetic",
      };
      await writeFile(protectedSettings, JSON.stringify({ apiKeyHelper: "", env: managedClaudeRoutingEnvironment(selectedEnvironment) }));
      const child = spawn(claude!, [
        "--print", "--output-format", "stream-json", "--verbose",
        "--setting-sources", sources, "--settings", protectedSettings, "--dangerously-skip-permissions", "probe",
      ], {
        cwd,
        env: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
          HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config,
          ...selectedEnvironment,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CI: "1",
        },
      });
      let output = "";
      let diagnostics = "";
      child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
      try {
        const init = await new Promise<{ skills?: string[] }>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Claude CLI did not initialize: ${diagnostics}`)), 30000);
          child.once("error", (error) => { clearTimeout(timeout); reject(error); });
          child.once("exit", () => { clearTimeout(timeout); reject(new Error("Claude CLI exited before initialization")); });
          child.stdout.on("data", (chunk: Buffer) => {
            diagnostics += chunk.toString();
            output += chunk.toString();
            const lines = output.split("\n");
            output = lines.pop() ?? "";
            for (const line of lines) {
              try {
                const event = JSON.parse(line) as { type?: string; subtype?: string; skills?: string[] };
                if (event.type === "system" && event.subtype === "init") {
                  clearTimeout(timeout);
                  resolve(event);
                }
              } catch { /* Other provider output is not part of this assertion. */ }
            }
          });
        });
        let requestTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([requested, new Promise<never>((_resolve, reject) => {
            requestTimeout = setTimeout(() => reject(new Error(`Claude did not request the selected synthetic endpoint: ${diagnostics}`)), 15000);
          })]);
        } finally { if (requestTimeout) clearTimeout(requestTimeout); }
        expect(redirectedRequests).toBe(0);
        if (bedrockOverride) {
          expect(providerRequest?.url).toContain("/model/");
          expect(providerRequest?.authorization).toBe("Bearer synthetic");
        }
        expect(await readFile(helperMarker, "utf8").then(() => true, () => false)).toBe(false);
        expect(init.skills).toContain("paperclip-probe");
        expect(init.skills?.includes("repo-probe")).toBe(hookExpected);
        const hookRan = await readFile(marker, "utf8").then(() => true, () => false);
        expect(hookRan).toBe(hookExpected);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 5000);
            child.once("close", () => { clearTimeout(timeout); resolve(); });
            child.kill();
          });
        }
      }
    } finally {
      redirect.closeAllConnections();
      await new Promise<void>((resolve) => redirect.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
    }
  }, 45000);
});
