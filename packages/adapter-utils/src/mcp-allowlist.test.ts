import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadMcpRegistry,
  McpRegistryNotFoundError,
  parseMcpAllowlist,
  renderBobMcpSettings,
  renderCodexMcpToml,
  renderGeminiMcpSettings,
  renderOpencodeMcp,
  resolveMcpAllowlist,
  resolveMcpAllowlistFromEnv,
  resolveMcpRegistryRootFromEnv,
  resolveRunMcpScriptFromEnv,
} from "./mcp-allowlist.js";

async function makeRegistryRoot(servers: Array<{ id: string; status: string; required?: string[] }>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-test-"));
  await fs.mkdir(path.join(root, "manifests"), { recursive: true });
  const registry = {
    schemaVersion: "paperclip.mcp.registry.v1",
    servers: servers.map((s) => ({
      id: s.id,
      status: s.status,
      manifest: `manifests/${s.id}.json`,
    })),
  };
  await fs.writeFile(path.join(root, "registry.json"), JSON.stringify(registry));
  for (const s of servers) {
    const manifest = {
      schemaVersion: "paperclip.mcp.manifest.v1",
      id: s.id,
      status: s.status,
      environment: {
        requiredNames: s.required ?? [],
      },
    };
    await fs.writeFile(path.join(root, "manifests", `${s.id}.json`), JSON.stringify(manifest));
  }
  return root;
}

describe("parseMcpAllowlist", () => {
  it("returns no ids and no errors when raw is empty / unset", () => {
    expect(parseMcpAllowlist(undefined)).toEqual({ ids: [], errors: [] });
    expect(parseMcpAllowlist(null)).toEqual({ ids: [], errors: [] });
    expect(parseMcpAllowlist("")).toEqual({ ids: [], errors: [] });
    expect(parseMcpAllowlist("   ")).toEqual({ ids: [], errors: [] });
  });

  it("splits CSV with whitespace tolerated and dedupes", () => {
    expect(parseMcpAllowlist("jira-ibm, box, jira-ibm")).toEqual({
      ids: ["jira-ibm", "box"],
      errors: [],
    });
    expect(parseMcpAllowlist("jira-ibm  box\n  cognos-ibm")).toEqual({
      ids: ["jira-ibm", "box", "cognos-ibm"],
      errors: [],
    });
  });

  it("rejects tokens that fail the shape regex", () => {
    const result = parseMcpAllowlist("Jira-IBM, valid-id, -leading, bad/slash, ok2");
    expect(result.ids).toEqual(["valid-id", "ok2"]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("Jira-IBM");
    expect(result.errors[1]).toContain("-leading");
    expect(result.errors[2]).toContain("bad/slash");
  });
});

describe("loadMcpRegistry", () => {
  let root: string;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("loads a registry with manifests", async () => {
    root = await makeRegistryRoot([
      { id: "jira-ibm", status: "validated", required: ["ATLASSIAN_API_TOKEN"] },
      { id: "box", status: "blocked-authorized-owner-validation" },
    ]);
    const registry = await loadMcpRegistry(root);
    expect(registry.servers.size).toBe(2);
    const jira = registry.servers.get("jira-ibm")!;
    expect(jira.status).toBe("validated");
    expect(jira.manifest?.environment?.requiredNames).toEqual(["ATLASSIAN_API_TOKEN"]);
  });

  it("throws McpRegistryNotFoundError when registry.json is missing", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-empty-"));
    try {
      await expect(loadMcpRegistry(empty)).rejects.toBeInstanceOf(McpRegistryNotFoundError);
      // The error message must mention the override env var so operators can
      // self-diagnose without reading the source.
      await expect(loadMcpRegistry(empty)).rejects.toThrow(/PAPERCLIP_MCP_REGISTRY_ROOT/);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe("resolveMcpRegistryRootFromEnv / resolveRunMcpScriptFromEnv", () => {
  it("falls back to the canonical default when env is unset", () => {
    expect(resolveMcpRegistryRootFromEnv({})).toBe("/Users/cassio/mcp-server/_paperclip");
    expect(resolveRunMcpScriptFromEnv({})).toBeUndefined();
  });

  it("honors PAPERCLIP_MCP_REGISTRY_ROOT and PAPERCLIP_MCP_RUN_SCRIPT", () => {
    expect(
      resolveMcpRegistryRootFromEnv({ PAPERCLIP_MCP_REGISTRY_ROOT: "/srv/mcp" }),
    ).toBe("/srv/mcp");
    expect(
      resolveRunMcpScriptFromEnv({ PAPERCLIP_MCP_RUN_SCRIPT: "/srv/run.sh" }),
    ).toBe("/srv/run.sh");
  });

  it("treats whitespace-only overrides as unset", () => {
    expect(
      resolveMcpRegistryRootFromEnv({ PAPERCLIP_MCP_REGISTRY_ROOT: "   " }),
    ).toBe("/Users/cassio/mcp-server/_paperclip");
    expect(
      resolveRunMcpScriptFromEnv({ PAPERCLIP_MCP_RUN_SCRIPT: "" }),
    ).toBeUndefined();
  });
});

describe("resolveMcpAllowlist", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRegistryRoot([
      { id: "jira-ibm", status: "validated", required: ["ATLASSIAN_API_TOKEN", "ATLASSIAN_SITE_NAME"] },
      { id: "box", status: "blocked-authorized-owner-validation" },
      {
        id: "wikipedia",
        status: "validated-local-contract-no-live-call",
      },
    ]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resolves a valid allowlist and surfaces required env names", async () => {
    const registry = await loadMcpRegistry(root);
    const result = resolveMcpAllowlist({
      rawAllowlist: "jira-ibm, wikipedia",
      registry,
      runMcpScript: "/run-mcp.sh",
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved).toHaveLength(2);
    const jira = result.resolved[0];
    expect(jira.id).toBe("jira-ibm");
    expect(jira.requiredEnvNames).toEqual(["ATLASSIAN_API_TOKEN", "ATLASSIAN_SITE_NAME"]);
    expect(jira.runMcpScript).toBe("/run-mcp.sh");
    expect(result.resolved[1].id).toBe("wikipedia");
  });

  it("fails closed on unknown id", async () => {
    const registry = await loadMcpRegistry(root);
    const result = resolveMcpAllowlist({
      rawAllowlist: "jira-ibm, ghost",
      registry,
    });
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].id).toBe("jira-ibm");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe("unknown_id");
    expect(result.errors[0].token).toBe("ghost");
  });

  it("fails closed on blocked status", async () => {
    const registry = await loadMcpRegistry(root);
    const result = resolveMcpAllowlist({
      rawAllowlist: "box",
      registry,
    });
    expect(result.resolved).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe("blocked_status");
    expect(result.errors[0].token).toBe("box");
  });

  it("forwards invalid_token errors from parsing", async () => {
    const registry = await loadMcpRegistry(root);
    const result = resolveMcpAllowlist({
      rawAllowlist: "Jira-IBM, jira-ibm",
      registry,
    });
    expect(result.resolved).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe("invalid_token");
    expect(result.errors[0].token).toBe("Jira-IBM");
  });
});

describe("renderers", () => {
  const resolved = [
    {
      id: "jira-ibm",
      status: "validated",
      requiredEnvNames: ["ATLASSIAN_API_TOKEN"],
      optionalEnvNames: [],
      runMcpScript: "/usr/local/run-mcp.sh",
    },
    {
      id: "wikipedia",
      status: "validated-local-contract-no-live-call",
      requiredEnvNames: [],
      optionalEnvNames: [],
      runMcpScript: "/usr/local/run-mcp.sh",
    },
  ];

  it("renders opencode mcp config", () => {
    expect(renderOpencodeMcp(resolved)).toEqual({
      "jira-ibm": {
        type: "local",
        command: ["bash", "/usr/local/run-mcp.sh", "jira-ibm"],
        enabled: true,
      },
      wikipedia: {
        type: "local",
        command: ["bash", "/usr/local/run-mcp.sh", "wikipedia"],
        enabled: true,
      },
    });
  });

  it("renders codex mcp toml fragments", () => {
    const toml = renderCodexMcpToml(resolved);
    expect(toml).toContain('[mcp_servers.jira-ibm]');
    expect(toml).toContain('command = "bash"');
    expect(toml).toContain('args = ["/usr/local/run-mcp.sh", "jira-ibm"]');
    expect(toml).toContain('[mcp_servers.wikipedia]');
  });

  it("renders gemini settings", () => {
    expect(renderGeminiMcpSettings(resolved)).toEqual({
      mcpServers: {
        "jira-ibm": { command: "bash", args: ["/usr/local/run-mcp.sh", "jira-ibm"] },
        wikipedia: { command: "bash", args: ["/usr/local/run-mcp.sh", "wikipedia"] },
      },
    });
  });

  it("renders bob settings", () => {
    expect(renderBobMcpSettings(resolved)).toEqual({
      mcpServers: {
        "jira-ibm": { command: "bash", args: ["/usr/local/run-mcp.sh", "jira-ibm"] },
        wikipedia: { command: "bash", args: ["/usr/local/run-mcp.sh", "wikipedia"] },
      },
    });
  });

  it("renders empty structures when nothing resolved", () => {
    expect(renderOpencodeMcp([])).toEqual({});
    expect(renderCodexMcpToml([])).toBe("");
    expect(renderGeminiMcpSettings([])).toEqual({ mcpServers: {} });
    expect(renderBobMcpSettings([])).toEqual({ mcpServers: {} });
  });
});

describe("resolveMcpAllowlistFromEnv", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRegistryRoot([
      { id: "jira-ibm", status: "validated" },
    ]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns null when MCP_LIST is empty/unset", async () => {
    const registry = await loadMcpRegistry(root);
    expect(resolveMcpAllowlistFromEnv({ env: {}, registry })).toBeNull();
    expect(resolveMcpAllowlistFromEnv({ env: { MCP_LIST: "" }, registry })).toBeNull();
    expect(resolveMcpAllowlistFromEnv({ env: { MCP_LIST: "   " }, registry })).toBeNull();
  });

  it("resolves when MCP_LIST is set", async () => {
    const registry = await loadMcpRegistry(root);
    const result = resolveMcpAllowlistFromEnv({
      env: { MCP_LIST: "jira-ibm" },
      registry,
    });
    expect(result).not.toBeNull();
    expect(result!.resolved).toHaveLength(1);
    expect(result!.errors).toEqual([]);
  });
});
