import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const MOCK_STDOUT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet" }),
  JSON.stringify({ type: "result", session_id: "s1", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
].join("\n");

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: MOCK_STDOUT,
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, runChildProcess, ensureCommandResolvable, resolveCommandForLogs };
});

import { execute } from "./execute.js";

function baseAgent(name: string) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name,
    adapterType: "claude_local" as const,
    adapterConfig: {},
  };
}

const baseRuntime = {
  sessionId: null,
  sessionParams: null,
  sessionDisplayId: null,
  taskKey: null,
};

describe("MCP flags in buildClaudeArgs", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runWithConfig(agentName: string, config: Record<string, unknown>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pclip-mcp-flags-"));
    cleanupDirs.push(dir);
    await mkdir(dir, { recursive: true });
    await execute({
      runId: "run-mcp-test",
      agent: baseAgent(agentName),
      runtime: baseRuntime,
      config: { command: "claude", cwd: dir, ...config },
      context: {},
      onLog: async () => {},
    });
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[], unknown] | undefined;
    return call?.[2] ?? [];
  }

  it("appends --mcp-config when claudeMcpConfigPath is set", async () => {
    const args = await runWithConfig("generic-agent", {
      claudeMcpConfigPath: "/tmp/mcp.json",
      claudeStrictMcpConfig: false,
    });
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/mcp.json");
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("appends --strict-mcp-config when claudeStrictMcpConfig is true", async () => {
    const args = await runWithConfig("generic-agent", {
      claudeStrictMcpConfig: true,
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  it("appends both flags together when both are set", async () => {
    const args = await runWithConfig("generic-agent", {
      claudeMcpConfigPath: "/tmp/empty-mcp.json",
      claudeStrictMcpConfig: true,
    });
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/empty-mcp.json");
    expect(args).toContain("--strict-mcp-config");
  });

  it("omits both flags when not configured for non-engineering agent", async () => {
    const args = await runWithConfig("Marketing Agent", {});
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("defaults --strict-mcp-config ON for Coder agents without explicit config", async () => {
    const args = await runWithConfig("Coder (Claude)", {});
    expect(args).toContain("--strict-mcp-config");
  });

  it("defaults --strict-mcp-config ON for CTO agents without explicit config", async () => {
    const args = await runWithConfig("CTO", {});
    expect(args).toContain("--strict-mcp-config");
  });

  it("defaults --strict-mcp-config ON for QA agents without explicit config", async () => {
    const args = await runWithConfig("QA Integration", {});
    expect(args).toContain("--strict-mcp-config");
  });

  it("defaults --strict-mcp-config ON for Director of Engineering without explicit config", async () => {
    const args = await runWithConfig("Director of Engineering", {});
    expect(args).toContain("--strict-mcp-config");
  });

  it("respects explicit claudeStrictMcpConfig: false for engineering agents (opt-out)", async () => {
    const args = await runWithConfig("CTO", { claudeStrictMcpConfig: false });
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("omits --mcp-config when claudeMcpConfigPath is empty string", async () => {
    const args = await runWithConfig("generic-agent", { claudeMcpConfigPath: "" });
    expect(args).not.toContain("--mcp-config");
  });
});
