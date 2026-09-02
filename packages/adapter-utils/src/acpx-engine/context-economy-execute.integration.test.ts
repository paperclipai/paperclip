// Real-call-site integration test for KOMAA-184 runtime wiring.
//
// Exercises `execute` (the adapter-utils ACPX engine entry point) with a managed
// MCP set that mimics the historical bad Engineer case (Cloudflare + Playwright
// + Storybook injected alongside Git) and asserts the run-start MCP narrowing,
// tool-schema telemetry, and first-model token telemetry are applied at the real
// call site and surfaced on the execution result.

import { describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeMcpAccess, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { createAcpxEngineExecutor } from "./execute.js";

function mcp(name: string): AdapterRuntimeMcpServer {
  return { name, url: `https://mcp/${name}`, token: "tok", connectionId: `c-${name}` };
}

function buildRuntime() {
  return {
    ensureSession: async () => ({
      backendSessionId: "backend-session",
      agentSessionId: "agent-session",
      runtimeSessionName: "runtime-session",
    }),
    startTurn: () => ({
      events: (async function* () {
        yield { type: "done", stopReason: "end_turn" };
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    }),
    setConfigOption: async () => {},
    close: async () => {},
  };
}

async function runWithMcp(servers: AdapterRuntimeMcpServer[], context: Record<string, unknown>) {
  const runtimeOptions: Array<{ mcpServers?: Array<{ name: string }> }> = [];
  const execute = createAcpxEngineExecutor({
    createRuntime: (options) => {
      runtimeOptions.push(options as unknown as { mcpServers?: Array<{ name: string }> });
      return buildRuntime() as never;
    },
  });
  const result = await execute({
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1" },
    runtime: {},
    config: {},
    context,
    runtimeMcp: { getServers: () => servers } as AdapterRuntimeMcpAccess,
    onLog: async () => {},
    onMeta: async () => {},
    onEvent: async () => {},
  } as never);
  return { result, runtimeOptions };
}

describe("context-economy execute wiring", () => {
  it("narrows the managed MCP set at run start for a non-UI Engineer run", async () => {
    const servers = [mcp("github"), mcp("cloudflare"), mcp("playwright"), mcp("storybook")];
    const { result, runtimeOptions } = await runWithMcp(servers, {
      role: "engineer",
      taskCategory: "technical",
    });

    expect(result.exitCode).toBe(0);
    const diagnostics = result.runContextDiagnostics;
    expect(diagnostics).toBeTruthy();

    // The runtime actually received only the Git MCP.
    const injected = runtimeOptions.flatMap((o) => o.mcpServers?.map((s) => s.name) ?? []);
    expect(injected).toEqual(["github"]);

    // And the diagnostics report the dropped, unauthorized servers.
    expect(diagnostics?.mcpNarrowing?.droppedUnauthorized?.slice().sort()).toEqual([
      "cloudflare",
      "playwright",
      "storybook",
    ]);

    expect(diagnostics?.tools?.registeredToolCount).toBe(1);
    expect(diagnostics?.tools?.toolsBySource).toEqual({ managed: 1 });
  });

  it("does not narrow when no role is classified (legacy behavior)", async () => {
    const servers = [mcp("github"), mcp("cloudflare"), mcp("playwright")];
    const { result, runtimeOptions } = await runWithMcp(servers, {});
    expect(result.exitCode).toBe(0);
    const injected = runtimeOptions.flatMap((o) => o.mcpServers?.map((s) => s.name) ?? []);
    expect(injected.sort()).toEqual(["cloudflare", "github", "playwright"]);
    expect(result.runContextDiagnostics?.mcpNarrowing).toBeNull();
  });

  it("reports first-model token telemetry as unsupported when usage absent", async () => {
    const servers = [mcp("github")];
    const { result } = await runWithMcp(servers, { role: "engineer", taskCategory: "technical" });
    const tokens = result.runContextDiagnostics?.firstModelTokens;
    expect(tokens?.firstModelInputTokens).toBeNull();
    expect(tokens?.measured).toBe(false);
    expect(tokens?.reason).toMatch(/did not report/i);
  });
});
