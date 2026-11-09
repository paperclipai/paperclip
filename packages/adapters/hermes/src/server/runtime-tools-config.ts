import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

export interface HermesRuntimeTools {
  mcpEndpoint?: string;
  bearerToken?: string;
  tools?: readonly string[];
}

export interface HermesRuntimeToolsConfig {
  homeDir: string;
  toolset: string;
  cleanup: () => Promise<void>;
}

/**
 * Hermes discovers remote MCP servers from config.yaml, not from Paperclip's
 * PAPERCLIP_RUNTIME_TOOLS_* environment variables. Use an isolated HOME overlay
 * so the per-run connection never mutates the agent's persistent profile.
 */
export async function configureHermesRuntimeTools(
  sourceHome: string | undefined,
  runtimeTools: HermesRuntimeTools | undefined,
): Promise<HermesRuntimeToolsConfig | undefined> {
  const endpoint = runtimeTools?.mcpEndpoint;
  const tools = runtimeTools?.tools?.filter((tool) => typeof tool === "string" && tool.length > 0);
  if (!endpoint || !runtimeTools?.bearerToken || !tools?.length) return undefined;

  const profileHome = sourceHome || path.join(os.homedir(), ".hermes", "profiles", process.env.HERMES_PROFILE || "default");
  const sourceConfig = path.join(profileHome, "config.yaml");
  const rawConfig = await fs.readFile(sourceConfig, "utf8");
  const parsed = parse(rawConfig);
  const config = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const mcpServers = config.mcp_servers && typeof config.mcp_servers === "object" && !Array.isArray(config.mcp_servers)
    ? config.mcp_servers as Record<string, unknown>
    : {};

  const serverName = `paperclip-runtime-${process.pid}-${Date.now()}`;
  const toolset = `mcp-${serverName}`;
  mcpServers[serverName] = {
    url: endpoint,
    headers: { Authorization: "Bearer ${PAPERCLIP_RUNTIME_TOOLS_TOKEN}" },
    enabled: true,
    trust: "untrusted",
    tools: { include: tools },
  };
  config.mcp_servers = mcpServers;

  // Preserve explicit profile/adapter toolsets while making the scoped runtime
  // MCP server selectable. When Hermes is using its defaults, leave that
  // selection untouched and rely on its normal dynamic-toolset discovery.
  if (Array.isArray(config.toolsets)) {
    config.toolsets = [...new Set([...config.toolsets.filter((item): item is string => typeof item === "string"), toolset])];
  }

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-runtime-"));
  try {
    await fs.chmod(homeDir, 0o700);
    for (const entry of await fs.readdir(profileHome)) {
      if (entry === "config.yaml") continue;
      await fs.symlink(path.join(profileHome, entry), path.join(homeDir, entry));
    }
    await fs.writeFile(path.join(homeDir, "config.yaml"), stringify(config), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await fs.rm(homeDir, { recursive: true, force: true });
    throw error;
  }

  return {
    homeDir,
    toolset,
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  };
}
