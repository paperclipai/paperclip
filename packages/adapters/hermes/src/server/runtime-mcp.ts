import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

export interface HermesRuntimeMcpServer {
  name: string;
  url: string;
  token: string;
}

export interface HermesRuntimeMcpHome {
  home: string;
  env: Record<string, string>;
  serverNames: string[];
  cleanup: () => Promise<void>;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function resolveBaseHermesHome(env: Record<string, string | undefined>): Promise<string> {
  const explicitHome = env.HERMES_HOME?.trim();
  const paperclipHome = env.PAPERCLIP_HERMES_HOME?.trim();
  const userHome = env.HOME?.trim() || os.homedir();
  const fallbackHome = path.join(paperclipHome || userHome, ".hermes");
  if (explicitHome) {
    const resolvedHome = path.resolve(explicitHome);
    try {
      await fs.access(path.join(resolvedHome, "tools"));
      return resolvedHome;
    } catch {
      // A previous run can leave HERMES_HOME pointing at its now-deleted
      // temporary MCP home. Fall back to the persistent installation instead.
    }
  }
  return fallbackHome;
}

async function stabilizeHermesPythonLauncher(baseHome: string): Promise<void> {
  const launcherPath = path.join(baseHome, "hermes-agent", ".hermes", "bin", "hermes");
  let launcher: string;
  try {
    launcher = await fs.readFile(launcherPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const staleInterpreter = launcher.match(
    /^exec\s+\/tmp\/paperclip-hermes-run-[^/]+\/\.hermes\/tools\/(python-[^/]+\/bin\/python3)(?=\s)/m,
  );
  if (!staleInterpreter) return;
  const stableInterpreter = path.join(baseHome, "tools", ...staleInterpreter[1].split("/"));
  try {
    await fs.access(stableInterpreter);
  } catch {
    throw new Error("Hermes launcher points to a removed run home and the persistent Python runtime is unavailable");
  }

  const updated = launcher.replace(staleInterpreter[0], `exec ${stableInterpreter}`);
  const metadata = await fs.stat(launcherPath);
  await fs.writeFile(launcherPath, updated, { encoding: "utf8", mode: metadata.mode });
}

/**
 * Build a private Hermes home for one Paperclip run so Hermes can discover the
 * run-scoped, policy-filtered MCP gateways Paperclip supplies. Other Hermes
 * state remains shared through symlinks; the config copy contains only token
 * placeholders, while the actual short-lived gateway tokens stay in child env.
 */
export async function createHermesRuntimeMcpHome(input: {
  servers: HermesRuntimeMcpServer[];
  env: Record<string, string | undefined>;
  runId: string;
}): Promise<HermesRuntimeMcpHome | null> {
  if (input.servers.length === 0) return null;

  const baseHome = await resolveBaseHermesHome(input.env);
  await stabilizeHermesPythonLauncher(baseHome);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-run-"));
  const runHome = path.join(tempRoot, ".hermes");

  try {
    await fs.mkdir(runHome, { mode: 0o700 });

    let sourceConfig = "";
    try {
      sourceConfig = await fs.readFile(path.join(baseHome, "config.yaml"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const parsedConfig = sourceConfig ? parse(sourceConfig) : {};
    const config = parsedConfig == null ? {} : objectRecord(parsedConfig);
    if (!config) throw new Error("Hermes config.yaml must contain a YAML mapping.");

    const existingServers = objectRecord(config.mcp_servers) ?? {};
    if (config.mcp_servers != null && !objectRecord(config.mcp_servers)) {
      throw new Error("Hermes config.yaml mcp_servers must contain a YAML mapping.");
    }
    const mcpServers: Record<string, unknown> = { ...existingServers };
    const runtimeEnv: Record<string, string> = {};
    const runtimeServerNames: string[] = [];
    const runSuffix = input.runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "run";

    input.servers.forEach((server, index) => {
      const urlEnv = `PAPERCLIP_RUNTIME_MCP_URL_${index}`;
      const tokenEnv = `PAPERCLIP_RUNTIME_MCP_TOKEN_${index}`;
      const readableName = server.name.toLowerCase().replace(/^paperclip[-_]?/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "connection";
      const serverBaseName = `paperclip_${readableName}_${runSuffix}_${index}`;
      let serverName = serverBaseName;
      let collision = 1;
      while (Object.prototype.hasOwnProperty.call(mcpServers, serverName)) {
        serverName = `${serverBaseName}_${collision++}`;
      }
      runtimeEnv[urlEnv] = server.url;
      runtimeEnv[tokenEnv] = server.token;
      mcpServers[serverName] = {
        url: "${" + urlEnv + "}",
        headers: { Authorization: "Bearer ${" + tokenEnv + "}" },
        connect_timeout: 30,
        timeout: 120,
      };
      // Hermes CLI selects dynamic MCP servers by their configured server
      // names. The MCP client then registers each server's `mcp-<name>` tools.
      runtimeServerNames.push(serverName);
    });

    config.mcp_servers = mcpServers;
    await fs.writeFile(path.join(runHome, "config.yaml"), stringify(config), {
      encoding: "utf8",
      mode: 0o600,
    });

    let baseEntries: Dirent[];
    try {
      baseEntries = await fs.readdir(baseHome, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      baseEntries = [];
    }
    for (const entry of baseEntries) {
      if (entry.name === "config.yaml") continue;
      const source = path.join(baseHome, entry.name);
      const destination = path.join(runHome, entry.name);
      const isDirectory = entry.isDirectory();
      await fs.symlink(source, destination, process.platform === "win32" && isDirectory ? "junction" : isDirectory ? "dir" : "file");
    }

    return {
      home: runHome,
      env: runtimeEnv,
      serverNames: runtimeServerNames,
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
