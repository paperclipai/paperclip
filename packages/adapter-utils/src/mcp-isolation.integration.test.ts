import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  type AcpRuntimeOptions,
} from "acpx/runtime";
import {
  commandVersion,
  createMcpIsolationRoot,
  runCommand,
  writeClaudeMcpConfig,
  writeCodexMcpConfig,
} from "./test-support/mcp-isolation-harness.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const stdioFixturePath = path.join(repoRoot, "scripts/mcp-fixtures/servers/stdio-fixture.mjs");
const acpFixturePath = path.join(repoRoot, "scripts/mcp-fixtures/servers/acp-isolation-agent.mjs");
const cleanupRoots: string[] = [];

interface McpObservation {
  name: string;
  tools: string[];
}

type McpServer = NonNullable<AcpRuntimeOptions["mcpServers"]>[number];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function fixtureServer(name: string): McpServer {
  return {
    name,
    command: process.execPath,
    args: [stdioFixturePath],
    env: [],
  };
}

async function runAcpxFixtureSession(
  root: string,
  sessionName: string,
  mcpServers: McpServer[],
): Promise<McpObservation[]> {
  const runtime = createAcpRuntime({
    cwd: repoRoot,
    sessionStore: createRuntimeStore({ stateDir: path.join(root, `acpx-${sessionName}`) }),
    agentRegistry: createAgentRegistry({
      overrides: {
        isolation_fixture: `${process.execPath} ${acpFixturePath}`,
      },
    }),
    mcpServers,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    timeoutMs: 10_000,
  });
  const handle = await runtime.ensureSession({
    sessionKey: `isolation-${sessionName}`,
    agent: "isolation_fixture",
    mode: "oneshot",
    cwd: repoRoot,
  });

  let output = "";
  for await (const event of runtime.runTurn({
    handle,
    text: "List the MCP tools visible to this session.",
    mode: "prompt",
    requestId: `request-${sessionName}`,
  })) {
    if (event.type === "text_delta" && event.stream !== "thought") output += event.text;
  }

  await runtime.close({
    handle,
    reason: "isolation test complete",
    discardPersistentState: true,
  });
  return JSON.parse(output) as McpObservation[];
}

async function startUnauthorizedAnthropicFixture(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "authentication_error" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind Claude API fixture");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe("same-machine MCP isolation", () => {
  it("passes disjoint MCP server sets through acpx session/new and tools/list", async () => {
    const root = await createMcpIsolationRoot("paperclip-acpx-mcp-isolation-");
    cleanupRoots.push(root);

    const [alpha, beta, zero] = await Promise.all([
      runAcpxFixtureSession(root, "alpha", [fixtureServer("agent_alpha")]),
      runAcpxFixtureSession(root, "beta", [fixtureServer("agent_beta")]),
      runAcpxFixtureSession(root, "zero", []),
    ]);

    expect(alpha.map((entry) => entry.name)).toEqual(["agent_alpha"]);
    expect(beta.map((entry) => entry.name)).toEqual(["agent_beta"]);
    expect(alpha[0]?.tools).toContain("echo.echo");
    expect(beta[0]?.tools).toContain("echo.echo");
    expect(JSON.stringify(alpha)).not.toContain("agent_beta");
    expect(JSON.stringify(beta)).not.toContain("agent_alpha");
    expect(zero).toEqual([]);
  }, 20_000);

  it("keeps concurrent Claude CLI MCP configs strict and disjoint", async () => {
    const version = await commandVersion("claude");
    if (!version) return;
    const claudeVersionMatch = version.match(/^2\.1\.(\d+) \(Claude Code\)$/);
    expect(claudeVersionMatch).not.toBeNull();
    expect(Number(claudeVersionMatch?.[1])).toBeGreaterThanOrEqual(207);

    const root = await createMcpIsolationRoot("paperclip-claude-mcp-isolation-");
    cleanupRoots.push(root);
    const home = path.join(root, "home");
    const alphaConfig = path.join(root, "alpha.json");
    const betaConfig = path.join(root, "beta.json");
    await fs.mkdir(home, { recursive: true });
    await writeClaudeMcpConfig(path.join(home, ".claude.json"), {
      user_pollution: { command: process.execPath, args: [stdioFixturePath] },
    });
    await writeClaudeMcpConfig(alphaConfig, {
      agent_alpha: { command: process.execPath, args: [stdioFixturePath] },
    });
    await writeClaudeMcpConfig(betaConfig, {
      agent_beta: { command: process.execPath, args: [stdioFixturePath] },
    });
    const apiFixture = await startUnauthorizedAnthropicFixture();

    const runClaude = async (name: string, configPath?: string) => {
      const debugPath = path.join(root, `${name}.debug.log`);
      const args = ["-p"];
      if (configPath) args.push("--mcp-config", configPath);
      args.push(
        "--strict-mcp-config",
        "--debug-file",
        debugPath,
        "Reply with OK.",
      );
      const result = await runCommand("claude", args, {
        cwd: repoRoot,
        timeoutMs: 4_000,
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_CONFIG_DIR: undefined,
          ANTHROPIC_API_KEY: "paperclip-invalid-test-key",
          ANTHROPIC_BASE_URL: apiFixture.baseUrl,
        },
      });
      expect(result.exitCode === 0 || result.timedOut || result.exitCode === 1).toBe(true);
      return fs.readFile(debugPath, "utf8");
    };

    try {
      const [alphaLog, betaLog, zeroLog] = await Promise.all([
        runClaude("alpha", alphaConfig),
        runClaude("beta", betaConfig),
        runClaude("zero"),
      ]);

      expect(alphaLog).toContain('MCP server "agent_alpha": Successfully connected');
      expect(betaLog).toContain('MCP server "agent_beta": Successfully connected');
      expect(alphaLog).not.toContain('MCP server "agent_beta"');
      expect(betaLog).not.toContain('MCP server "agent_alpha"');
      for (const log of [alphaLog, betaLog, zeroLog]) {
        expect(log).not.toContain('MCP server "user_pollution"');
      }
      expect(zeroLog).not.toMatch(/MCP server "[^"]+": Successfully connected/);
    } finally {
      await apiFixture.close();
    }
  }, 20_000);

  it("keeps concurrent Codex homes disjoint and supports CLI MCP overrides", async () => {
    const version = await commandVersion("codex");
    if (!version) return;
    expect(version).toMatch(/^codex-cli \d+\.\d+\.\d+$/);

    const root = await createMcpIsolationRoot("paperclip-codex-mcp-isolation-");
    cleanupRoots.push(root);
    const home = path.join(root, "home");
    const alphaHome = path.join(root, "codex-alpha");
    const betaHome = path.join(root, "codex-beta");
    const zeroHome = path.join(root, "codex-zero");
    await writeCodexMcpConfig(path.join(home, ".codex"), {
      user_pollution: { command: process.execPath, args: [stdioFixturePath] },
    });
    await writeCodexMcpConfig(alphaHome, {
      agent_alpha: { command: process.execPath, args: [stdioFixturePath] },
    });
    await writeCodexMcpConfig(betaHome, {
      agent_beta: { command: process.execPath, args: [stdioFixturePath] },
    });
    await fs.mkdir(zeroHome, { recursive: true });

    const runList = (codexHome: string, args: string[] = []) =>
      runCommand("codex", [...args, "mcp", "list"], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
      });
    const [alpha, beta, zero, override] = await Promise.all([
      runList(alphaHome),
      runList(betaHome),
      runList(zeroHome),
      runList(zeroHome, [
        "-c",
        `mcp_servers.override_agent.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.override_agent.args=${JSON.stringify([stdioFixturePath])}`,
      ]),
    ]);

    for (const result of [alpha, beta, zero, override]) {
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain("user_pollution");
    }
    expect(alpha.stdout).toContain("agent_alpha");
    expect(alpha.stdout).not.toContain("agent_beta");
    expect(beta.stdout).toContain("agent_beta");
    expect(beta.stdout).not.toContain("agent_alpha");
    expect(zero.stdout).toContain("No MCP servers configured yet");
    expect(override.stdout).toContain("override_agent");
  }, 20_000);
});
