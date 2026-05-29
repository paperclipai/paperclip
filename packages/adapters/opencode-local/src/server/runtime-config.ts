import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import {
  loadMcpRegistry,
  type McpRegistry,
  renderOpencodeMcp,
  resolveMcpAllowlist,
  resolveMcpRegistryRootFromEnv,
  resolveRunMcpScriptFromEnv,
} from "@paperclipai/adapter-utils/mcp-allowlist";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Applies the per-agent `MCP_LIST` allowlist to the in-memory opencode
 * config. Filters whatever was inherited from the shared `opencode.json#mcp`
 * tree, keeping only ids in the allowlist; for ids in the allowlist that
 * aren't already in `mcp`, adds the rendered entry from the registry.
 *
 * Fail-closed: any resolution error (invalid token / unknown id / blocked
 * status) is thrown so the caller never spawns the CLI with a partial /
 * silently-broken MCP set.
 *
 * Returns `null` when MCP_LIST is empty/unset, signaling that the existing
 * `opencode.json#mcp` block should remain untouched.
 */
async function applyMcpListToOpencodeConfig(input: {
  config: Record<string, unknown>;
  env: Record<string, string>;
  registry?: McpRegistry;
}): Promise<{ config: Record<string, unknown>; notes: string[] } | null> {
  const raw = input.env.MCP_LIST;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const registry = input.registry ?? (await loadMcpRegistry(resolveMcpRegistryRootFromEnv(input.env)));
  const result = resolveMcpAllowlist({
    rawAllowlist: raw,
    registry,
    runMcpScript: resolveRunMcpScriptFromEnv(input.env),
  });
  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => `[${e.kind}] ${e.message}`).join("; ");
    throw new Error(`opencode_local: MCP_LIST validation failed — ${messages}`);
  }
  const allowedIds = new Set(result.resolved.map((entry) => entry.id));
  const inheritedMcp = isPlainObject(input.config.mcp) ? input.config.mcp : {};
  const filteredInherited: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(inheritedMcp)) {
    if (allowedIds.has(id)) filteredInherited[id] = value;
  }
  const rendered = renderOpencodeMcp(result.resolved);
  // Inherited entry (if present and shape-compatible) wins; for missing ids
  // we add the rendered fallback that points at run-mcp.sh.
  const finalMcp: Record<string, unknown> = { ...rendered, ...filteredInherited };
  const nextConfig = { ...input.config, mcp: finalMcp };
  const notes = [
    `Applied MCP_LIST allowlist: kept ${Object.keys(filteredInherited).length} inherited entries; injected ${
      Object.keys(rendered).length - Object.keys(filteredInherited).length
    } rendered entries; total ${Object.keys(finalMcp).length}.`,
  ];
  return { config: nextConfig, notes };
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
  registry?: McpRegistry;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  const hasMcpList =
    typeof input.env.MCP_LIST === "string" && input.env.MCP_LIST.trim().length > 0;

  if (!skipPermissions && !hasMcpList) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  let nextConfig: Record<string, unknown> = existingConfig;
  const notes: string[] = [];

  if (skipPermissions) {
    const existingPermission = isPlainObject(nextConfig.permission)
      ? nextConfig.permission
      : {};
    nextConfig = {
      ...nextConfig,
      permission: {
        ...existingPermission,
        external_directory: "allow",
      },
    };
    notes.push(
      "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
    );
  }

  try {
    const mcpResult = await applyMcpListToOpencodeConfig({
      config: nextConfig,
      env: input.env,
      registry: input.registry,
    });
    if (mcpResult) {
      nextConfig = mcpResult.config;
      notes.push(...mcpResult.notes);
    }
  } catch (err) {
    // Cleanup the tmp dir before propagating, otherwise the spawn fails
    // and we leak the directory.
    await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    throw err;
  }

  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}
