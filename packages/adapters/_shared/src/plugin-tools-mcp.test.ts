import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPluginToolsMcpServer,
  materializeClaudeMcpConfigFile,
  mergeCodexConfigMcpServers,
  mergeGeminiSettingsMcpServer,
  mergeOpencodeConfigMcpServers,
} from "./plugin-tools-mcp.js";

const baseInput = {
  runContext: {
    companyId: "co-1",
    agentId: "a-1",
    runId: "r-1",
    projectId: "p-1",
  },
  apiUrl: "http://127.0.0.1:3100",
  apiKey: "sk-test",
};

describe("buildPluginToolsMcpServer", () => {
  it("requires every runContext field", () => {
    expect(() =>
      buildPluginToolsMcpServer({ ...baseInput, runContext: { ...baseInput.runContext, companyId: "" } }),
    ).toThrow(/companyId/);
    expect(() =>
      buildPluginToolsMcpServer({ ...baseInput, runContext: { ...baseInput.runContext, agentId: "" } }),
    ).toThrow(/agentId/);
    expect(() =>
      buildPluginToolsMcpServer({ ...baseInput, runContext: { ...baseInput.runContext, runId: "" } }),
    ).toThrow(/runId/);
    expect(() =>
      buildPluginToolsMcpServer({ ...baseInput, runContext: { ...baseInput.runContext, projectId: "" } }),
    ).toThrow(/projectId/);
  });

  it("requires apiUrl", () => {
    expect(() => buildPluginToolsMcpServer({ ...baseInput, apiUrl: "" })).toThrow(/apiUrl/);
  });

  it("returns a stable spec with the API key delivered via env (not args)", () => {
    const spec = buildPluginToolsMcpServer({
      ...baseInput,
      bridgeScriptPath: "/abs/bridge.js",
    });
    expect(spec.serverName).toBe("paperclip");
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([
      "/abs/bridge.js",
      "--api-url",
      "http://127.0.0.1:3100",
      "--api-key-env",
      "PAPERCLIP_API_KEY",
      "--company-id",
      "co-1",
      "--agent-id",
      "a-1",
      "--run-id",
      "r-1",
      "--project-id",
      "p-1",
    ]);
    expect(spec.env).toEqual({ PAPERCLIP_API_KEY: "sk-test" });
    // The api key MUST NOT appear in args, even when serialized to disk later.
    expect(spec.args.some((a) => a.includes("sk-test"))).toBe(false);
  });

  it("respects custom serverName, apiKeyEnvVar, nodeExecPath", () => {
    const spec = buildPluginToolsMcpServer({
      ...baseInput,
      bridgeScriptPath: "/abs/bridge.js",
      serverName: "pclip-tools",
      apiKeyEnvVar: "CUSTOM_KEY",
      nodeExecPath: "/usr/bin/node",
    });
    expect(spec.serverName).toBe("pclip-tools");
    expect(spec.command).toBe("/usr/bin/node");
    expect(spec.args).toContain("CUSTOM_KEY");
    expect(spec.env).toEqual({ CUSTOM_KEY: "sk-test" });
  });
});

describe("materializeClaudeMcpConfigFile", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mcp-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("writes a valid Claude .mcp.json shape", async () => {
    const spec = buildPluginToolsMcpServer({ ...baseInput, bridgeScriptPath: "/abs/bridge.js" });
    const outPath = await materializeClaudeMcpConfigFile(spec, tmp);
    const json = JSON.parse(await fs.readFile(outPath, "utf-8"));
    expect(json).toEqual({
      mcpServers: {
        paperclip: {
          type: "stdio",
          command: spec.command,
          args: spec.args,
          env: { PAPERCLIP_API_KEY: "sk-test" },
        },
      },
    });
  });
});

describe("mergeGeminiSettingsMcpServer", () => {
  it("creates mcpServers when settings is empty", () => {
    const spec = buildPluginToolsMcpServer({ ...baseInput, bridgeScriptPath: "/b.js" });
    const next = mergeGeminiSettingsMcpServer(undefined, spec);
    expect(next.mcpServers).toBeDefined();
    const servers = next.mcpServers as Record<string, unknown>;
    expect(servers.paperclip).toMatchObject({
      command: spec.command,
      args: spec.args,
      env: spec.env,
    });
  });

  it("preserves other user entries", () => {
    const spec = buildPluginToolsMcpServer({ ...baseInput, bridgeScriptPath: "/b.js" });
    const existing = {
      theme: "dark",
      mcpServers: {
        sentry: { command: "node", args: ["sentry.js"] },
      },
    };
    const next = mergeGeminiSettingsMcpServer(existing, spec);
    expect(next.theme).toBe("dark");
    const servers = next.mcpServers as Record<string, unknown>;
    expect(servers.sentry).toBeDefined();
    expect(servers.paperclip).toBeDefined();
  });
});

describe("mergeCodexConfigMcpServers", () => {
  it("appends a new block when none exists", () => {
    const spec = buildPluginToolsMcpServer({ ...baseInput, bridgeScriptPath: "/b.js" });
    const out = mergeCodexConfigMcpServers("model = \"gpt-4\"\n", spec);
    expect(out).toMatch(/model = "gpt-4"/);
    expect(out).toMatch(/\[mcp_servers\.paperclip\]/);
    expect(out).toMatch(/\[mcp_servers\.paperclip\.env\]/);
    expect(out).toMatch(/PAPERCLIP_API_KEY = "sk-test"/);
  });

  it("replaces an existing block idempotently", () => {
    const spec = buildPluginToolsMcpServer({ ...baseInput, bridgeScriptPath: "/b.js" });
    const first = mergeCodexConfigMcpServers("model = \"gpt-4\"\n", spec);
    const second = mergeCodexConfigMcpServers(first, spec);
    expect(second).toBe(first.endsWith("\n") ? first : first + "\n");
  });

  it("preserves trailing config sections", () => {
    const spec = buildPluginToolsMcpServer({ ...baseInput, bridgeScriptPath: "/b.js" });
    const existing =
      "model = \"gpt-4\"\n\n[mcp_servers.paperclip]\ncommand = \"old\"\nargs = []\n\n[other.section]\nkey = \"value\"\n";
    const out = mergeCodexConfigMcpServers(existing, spec);
    expect(out).toMatch(/\[other\.section\]/);
    expect(out).toMatch(/key = "value"/);
    expect(out).not.toMatch(/command = "old"/);
  });
});

describe("mergeOpencodeConfigMcpServers", () => {
  it("collapses command + args into a single array", () => {
    const spec = buildPluginToolsMcpServer({ ...baseInput, bridgeScriptPath: "/abs/bridge.js" });
    const next = mergeOpencodeConfigMcpServers(null, spec);
    const mcp = next.mcp as Record<string, { type: string; command: string[]; environment: unknown; enabled: boolean }>;
    expect(mcp.paperclip.type).toBe("local");
    expect(mcp.paperclip.command[0]).toBe(spec.command);
    expect(mcp.paperclip.command).toEqual([spec.command, ...spec.args]);
    expect(mcp.paperclip.environment).toEqual(spec.env);
    expect(mcp.paperclip.enabled).toBe(true);
  });

  it("preserves other top-level opencode config keys", () => {
    const spec = buildPluginToolsMcpServer({ ...baseInput, bridgeScriptPath: "/b.js" });
    const next = mergeOpencodeConfigMcpServers({ permission: { external_directory: "ask" } }, spec);
    expect(next.permission).toEqual({ external_directory: "ask" });
    expect(next.mcp).toBeDefined();
  });
});
