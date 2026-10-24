import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

export interface AgyMcpServerConfig {
  url: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface AgyMcpConfigFile {
  mcpServers?: Record<string, AgyMcpServerConfig>;
  [key: string]: unknown;
}

export interface WriteAgyMcpConfigInput {
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  servers: AdapterRuntimeMcpServer[];
  runId?: string;
}

export interface WriteAgyMcpConfigResult {
  configPath: string;
  injectedServerNames: string[];
  sweptStaleServerNames: string[];
  cleanup: () => Promise<void>;
}

/**
 * Resolves the path to the Antigravity mcp_config.json file.
 * Defaults to $HOME/.gemini/config/mcp_config.json.
 */
export function resolveAgyMcpConfigPath(
  homedir?: string,
  env?: NodeJS.ProcessEnv,
): string {
  const baseHome = env?.HOME || homedir || process.env.HOME || os.homedir();
  return path.join(baseHome, ".gemini", "config", "mcp_config.json");
}

/**
 * Normalizes an MCP server name to prevent naming collisions while preserving readability.
 */
export function resolveUniqueMcpServerName(
  server: AdapterRuntimeMcpServer,
  existingNames: Set<string>,
): string {
  let name = server.name.trim() || "paperclip-tool";
  if (existingNames.has(name)) {
    const connSuffix = server.connectionId ? `-${server.connectionId.slice(0, 8)}` : "";
    name = `${name}${connSuffix}`;
  }
  let suffix = 2;
  const baseName = name;
  while (existingNames.has(name)) {
    name = `${baseName}-${suffix}`;
    suffix += 1;
  }
  return name;
}

const MCP_CONFIG_LOCK_TIMEOUT_MS = 10_000;
const MCP_CONFIG_LOCK_STALE_MS = 60_000;
const MCP_CONFIG_LOCK_POLL_MS = 50;

/**
 * Serializes read-modify-write cycles on the single global mcp_config.json
 * shared by every agy run on the host. Uses an atomic mkdir lock with a
 * staleness break so a hard-killed holder cannot wedge later runs.
 */
async function withAgyMcpConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${configPath}.paperclip-lock`;
  const deadline = Date.now() + MCP_CONFIG_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const stat = await fs.stat(lockDir);
        if (Date.now() - stat.mtimeMs > MCP_CONFIG_LOCK_STALE_MS) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock vanished between mkdir and stat; retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the Antigravity MCP config lock at ${lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, MCP_CONFIG_LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Writes the config via a same-directory temp file + rename so readers never see a partial file. */
async function writeAgyMcpConfigFileAtomic(configPath: string, config: AgyMcpConfigFile): Promise<void> {
  const tmpPath = `${configPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmpPath, configPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Ownership record for the entries Paperclip injected into the shared host
 * config, kept next to the config file. A user's own HTTP server can have
 * exactly the shape Paperclip injects ({ url, headers? }), so shape alone
 * must never mark an entry as Paperclip-owned: only entries recorded here
 * (and still byte-identical to what was written) may be swept or excluded
 * as Paperclip-managed.
 */
export interface AgyMcpOwnershipRecord {
  url: string;
  headers?: Record<string, string>;
}

export type AgyMcpOwnership = Record<string, AgyMcpOwnershipRecord>;

export function resolveAgyMcpOwnershipPath(configPath: string): string {
  return `${configPath}.paperclip-ownership.json`;
}

async function readAgyMcpOwnership(configPath: string): Promise<AgyMcpOwnership> {
  try {
    const raw = await fs.readFile(resolveAgyMcpOwnershipPath(configPath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const ownership: AgyMcpOwnership = {};
    for (const [name, record] of Object.entries(parsed as Record<string, unknown>)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const { url, headers } = record as { url?: unknown; headers?: unknown };
      if (typeof url !== "string") continue;
      ownership[name] = {
        url,
        ...(headers && typeof headers === "object" && !Array.isArray(headers)
          ? { headers: headers as Record<string, string> }
          : {}),
      };
    }
    return ownership;
  } catch {
    return {};
  }
}

async function writeAgyMcpOwnership(configPath: string, ownership: AgyMcpOwnership): Promise<void> {
  const ownershipPath = resolveAgyMcpOwnershipPath(configPath);
  if (Object.keys(ownership).length === 0) {
    await fs.rm(ownershipPath, { force: true }).catch(() => undefined);
    return;
  }
  const tmpPath = `${ownershipPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(ownership, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmpPath, ownershipPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

function ownershipRecordFor(entry: AgyMcpServerConfig): AgyMcpOwnershipRecord {
  return {
    url: entry.url,
    ...(entry.headers ? { headers: entry.headers } : {}),
  };
}

function ownedEntryMatches(entry: AgyMcpServerConfig, record: AgyMcpOwnershipRecord): boolean {
  return (
    entry.url === record.url &&
    JSON.stringify(entry.headers ?? null) === JSON.stringify(record.headers ?? null)
  );
}

/**
 * True when an existing entry has exactly the shape this writer injects
 * (a URL, optionally with headers) — used to tell Paperclip-managed entries
 * apart from the user's own servers, which may use command/args/env.
 */
function isPaperclipInjectedEntry(value: unknown): value is AgyMcpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => key === "url" || key === "headers");
}

function sameInjectedEntry(a: AgyMcpServerConfig, b: AgyMcpServerConfig): boolean {
  if (!isPaperclipInjectedEntry(a)) return false;
  return a.url === b.url && JSON.stringify(a.headers ?? null) === JSON.stringify(b.headers ?? null);
}

async function readAgyMcpConfig(configPath: string): Promise<{ fileExisted: boolean; config: AgyMcpConfigFile }> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { fileExisted: false, config: {} };
    }
    throw err;
  }
  if (raw.trim().length === 0) {
    // An empty file has no contents to preserve; treat it as an empty config.
    return { fileExisted: true, config: {} };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `Refusing to modify the Antigravity MCP config at ${configPath}: it exists but is not valid JSON, so its contents cannot be preserved.`,
    );
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(
      `Refusing to modify the Antigravity MCP config at ${configPath}: it exists but is not a JSON object, so its contents cannot be preserved.`,
    );
  }
  return { fileExisted: true, config: json as AgyMcpConfigFile };
}

function extractServers(config: AgyMcpConfigFile): Record<string, AgyMcpServerConfig> {
  return config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? { ...config.mcpServers }
    : {};
}

/**
 * Writes Paperclip-managed MCP servers to Antigravity's mcp_config.json,
 * preserving existing user-configured servers, and returns a cleanup function
 * that safely removes only the injected servers after the run.
 *
 * The file is global to the host, so the whole read-modify-write runs under a
 * lock and lands via an atomic rename. Before injecting, entries left behind
 * by earlier Paperclip runs (e.g. a run that was hard-killed before its
 * cleanup could run) are swept when Paperclip's ownership record names them
 * and they are still exactly what was written; the user's own servers are
 * never swept, even on a name collision. If the existing file cannot be
 * parsed, the write refuses to proceed instead of discarding the user's
 * configuration.
 */
export async function writePaperclipAgyMcpConfig(
  input: WriteAgyMcpConfigInput,
): Promise<WriteAgyMcpConfigResult> {
  const configPath = resolveAgyMcpConfigPath(input.homedir, input.env);
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

  return withAgyMcpConfigLock(configPath, async () => {
    const { config: parsedConfig } = await readAgyMcpConfig(configPath);
    const existingServers = extractServers(parsedConfig);
    const ownership = await readAgyMcpOwnership(configPath);

    // Sweep leftovers from earlier Paperclip runs before injecting, so a
    // hard-killed run's token-bearing entries do not linger indefinitely or
    // force this run's servers onto suffixed names. An entry counts as a
    // leftover only when BOTH hold: its name belongs to one of the servers
    // being injected now (exact name or the suffixed variants the
    // unique-name resolver produces — entries outside this namespace may
    // belong to a run that is still alive), and Paperclip recorded
    // ownership of it with the entry still exactly as written. A user's
    // own server that merely shares a name (or the injected
    // { url, headers } shape) is preserved; the incoming server then takes
    // a suffixed name instead.
    const sweptStaleServerNames: string[] = [];
    const incomingBaseNames = input.servers
      .map((server) => server.name.trim() || "paperclip-tool")
      .filter((name, index, all) => all.indexOf(name) === index);
    for (const existingName of Object.keys(existingServers)) {
      const inIncomingNamespace = incomingBaseNames.some(
        (base) => existingName === base || existingName.startsWith(`${base}-`),
      );
      const record = ownership[existingName];
      if (
        inIncomingNamespace &&
        record &&
        isPaperclipInjectedEntry(existingServers[existingName]) &&
        ownedEntryMatches(existingServers[existingName], record)
      ) {
        delete existingServers[existingName];
        delete ownership[existingName];
        sweptStaleServerNames.push(existingName);
      }
    }

    const existingNames = new Set(Object.keys(existingServers));
    const injectedServerNames: string[] = [];
    const injectedServers: Record<string, AgyMcpServerConfig> = {};

    for (const server of input.servers) {
      const uniqueName = resolveUniqueMcpServerName(server, existingNames);
      existingNames.add(uniqueName);
      injectedServerNames.push(uniqueName);

      const serverConfig: AgyMcpServerConfig = {
        url: server.url,
        ...(server.token ? { headers: { Authorization: `Bearer ${server.token}` } } : {}),
      };
      existingServers[uniqueName] = serverConfig;
      injectedServers[uniqueName] = serverConfig;
      ownership[uniqueName] = ownershipRecordFor(serverConfig);
    }

    const updatedConfig: AgyMcpConfigFile = {
      ...parsedConfig,
      mcpServers: existingServers,
    };

    await writeAgyMcpConfigFileAtomic(configPath, updatedConfig);
    // Keep only records for entries that still exist, so the record cannot
    // later claim ownership of a same-named server the user created.
    const remainingOwnership: AgyMcpOwnership = {};
    for (const name of Object.keys(existingServers)) {
      if (ownership[name]) remainingOwnership[name] = ownership[name];
    }
    await writeAgyMcpOwnership(configPath, remainingOwnership);

    const cleanup = async (): Promise<void> => {
      try {
        await withAgyMcpConfigLock(configPath, async () => {
          let current: { fileExisted: boolean; config: AgyMcpConfigFile };
          try {
            current = await readAgyMcpConfig(configPath);
          } catch {
            // Missing or no longer parseable: nothing safe to remove.
            return;
          }
          if (!current.fileExisted) return;

          const currentServers = extractServers(current.config);
          let removedAny = false;
          for (const injectedName of injectedServerNames) {
            const currentEntry = currentServers[injectedName];
            // Only remove the entry if it is still exactly what this run
            // wrote. A later run may have swept and re-injected the same
            // name with a fresher token; that entry belongs to that run.
            if (currentEntry && sameInjectedEntry(currentEntry, injectedServers[injectedName])) {
              delete currentServers[injectedName];
              removedAny = true;
            }
          }
          if (!removedAny) return;

          const remainingServerKeys = Object.keys(currentServers);
          const onlyMcpServersKey = Object.keys(current.config).every((key) => key === "mcpServers");
          const configDeleted = remainingServerKeys.length === 0 && onlyMcpServersKey;
          if (configDeleted) {
            // Nothing left worth keeping: no servers, and no other settings
            // in the file. This also covers the file having been created by
            // an overlapping Paperclip run rather than this one.
            await fs.rm(configPath, { force: true }).catch(() => undefined);
          } else {
            const cleanedConfig = {
              ...current.config,
              mcpServers: currentServers,
            };
            await writeAgyMcpConfigFileAtomic(configPath, cleanedConfig);
          }
          // Ownership records live and die with the entries they describe.
          const currentOwnership = await readAgyMcpOwnership(configPath);
          const remainingOwnership: AgyMcpOwnership = {};
          if (!configDeleted) {
            for (const name of remainingServerKeys) {
              if (currentOwnership[name]) remainingOwnership[name] = currentOwnership[name];
            }
          }
          await writeAgyMcpOwnership(configPath, remainingOwnership);
        });
      } catch {
        // Ignore cleanup errors on missing or inaccessible files
      }
    };

    return {
      configPath,
      injectedServerNames,
      sweptStaleServerNames,
      cleanup,
    };
  });
}
export interface StageAgyMcpConfigInput {
  servers: AdapterRuntimeMcpServer[];
  runId?: string;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Stages Paperclip-managed MCP configuration into a private temporary directory
 * suitable for syncing into a sandbox execution target.
 */
export async function stageAgyMcpConfigForSync(
  input: StageAgyMcpConfigInput,
): Promise<string> {
  const prefix = input.runId
    ? `paperclip-agy-mcp-sync-${input.runId}-`
    : "paperclip-agy-mcp-sync-";
  const stagedDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.chmod(stagedDir, 0o700).catch(() => {});

  const hostConfigPath = resolveAgyMcpConfigPath(input.homedir, input.env);
  let parsedConfig: AgyMcpConfigFile = {};

  try {
    const raw = await fs.readFile(hostConfigPath, "utf8");
    if (raw.trim().length > 0) {
      const json = JSON.parse(raw);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsedConfig = json;
      }
    }
  } catch {
    // Missing or invalid config on host; start fresh
  }

  // Stage only servers authorized for this run: the user's own servers plus
  // this run's managed servers. Entries other Paperclip runs injected into
  // the shared host config carry those runs' credentials and must not leak
  // into this target; the ownership record identifies them.
  const ownership = await readAgyMcpOwnership(hostConfigPath);
  const existingServers: Record<string, AgyMcpServerConfig> =
    parsedConfig.mcpServers && typeof parsedConfig.mcpServers === "object" && !Array.isArray(parsedConfig.mcpServers)
      ? (Object.fromEntries(
          Object.entries(parsedConfig.mcpServers).filter(([name]) => !ownership[name]),
        ) as Record<string, AgyMcpServerConfig>)
      : {};

  const existingNames = new Set(Object.keys(existingServers));

  for (const server of input.servers) {
    const uniqueName = resolveUniqueMcpServerName(server, existingNames);
    existingNames.add(uniqueName);

    const serverConfig: AgyMcpServerConfig = {
      url: server.url,
      ...(server.token ? { headers: { Authorization: `Bearer ${server.token}` } } : {}),
    };
    existingServers[uniqueName] = serverConfig;
  }

  const updatedConfig: AgyMcpConfigFile = {
    ...parsedConfig,
    mcpServers: existingServers,
  };

  await fs.writeFile(
    path.join(stagedDir, "mcp_config.json"),
    JSON.stringify(updatedConfig, null, 2) + "\n",
    { mode: 0o600 },
  );

  return stagedDir;
}

export interface PrepareAgyLocalRunMcpHomeInput {
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  servers: AdapterRuntimeMcpServer[];
  runId?: string;
}

export interface PrepareAgyLocalRunMcpHomeResult {
  /** Private per-run HOME the agy process should be spawned with. */
  homeDir: string;
  configPath: string;
  injectedServerNames: string[];
  cleanup: () => Promise<void>;
}

/**
 * Builds a private per-run HOME for a local agy run so its MCP config is
 * never the shared host file: concurrent runs from different companies
 * must not be able to swap each other's tool credentials by rewriting
 * $HOME/.gemini/config/mcp_config.json between write and process start.
 *
 * The per-run config starts from the user's own servers (entries other
 * Paperclip runs injected into the host config are excluded via the
 * ownership record) plus exactly this run's managed servers. The real
 * Antigravity CLI home is linked in, so OAuth credentials, settings and
 * conversation state stay shared with the host login; the rest of the
 * user's .gemini/config entries are linked through untouched.
 */
export async function prepareAgyLocalRunMcpHome(
  input: PrepareAgyLocalRunMcpHomeInput,
): Promise<PrepareAgyLocalRunMcpHomeResult> {
  const realHome = input.env?.HOME || input.homedir || process.env.HOME || os.homedir();
  const hostConfigPath = resolveAgyMcpConfigPath(realHome, input.env);
  // Strict read: an unparseable host config must not be silently dropped.
  const { config: hostConfig } = await readAgyMcpConfig(hostConfigPath);
  const ownership = await readAgyMcpOwnership(hostConfigPath);
  const userServers = Object.fromEntries(
    Object.entries(extractServers(hostConfig)).filter(([name]) => !ownership[name]),
  ) as Record<string, AgyMcpServerConfig>;

  const prefix = input.runId
    ? `paperclip-agy-run-home-${input.runId}-`
    : "paperclip-agy-run-home-";
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.chmod(homeDir, 0o700).catch(() => {});

  try {
    const geminiDir = path.join(homeDir, ".gemini");
    const configDir = path.join(geminiDir, "config");
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

    // Share auth, settings and conversation state with the real CLI home.
    // Two locations are supported (see resolveAgyOAuthTokenPath): the
    // current ~/.gemini/antigravity-cli and the alternate
    // ~/.gemini/antigravity, which also holds brain/ session transcripts.
    // Link whichever exist so a login made through either stays usable
    // under the per-run HOME.
    for (const cliHomeName of ["antigravity-cli", "antigravity"]) {
      const realCliHome = path.join(realHome, ".gemini", cliHomeName);
      const realCliHomeIsDir = await fs
        .stat(realCliHome)
        .then((stat) => stat.isDirectory())
        .catch(() => false);
      if (realCliHomeIsDir) {
        await fs
          .symlink(
            realCliHome,
            path.join(geminiDir, cliHomeName),
            process.platform === "win32" ? "junction" : "dir",
          )
          .catch(() => undefined);
      }
    }

    // Link the user's other .gemini/config entries through untouched; only
    // mcp_config.json itself is per-run.
    const realConfigDir = path.dirname(hostConfigPath);
    const realConfigEntries = await fs.readdir(realConfigDir).catch(() => [] as string[]);
    for (const entryName of realConfigEntries) {
      if (entryName === "mcp_config.json" || entryName.startsWith("mcp_config.json.")) continue;
      await fs
        .symlink(
          path.join(realConfigDir, entryName),
          path.join(configDir, entryName),
          process.platform === "win32" ? "junction" : undefined,
        )
        .catch(() => undefined);
    }

    const servers: Record<string, AgyMcpServerConfig> = { ...userServers };
    const existingNames = new Set(Object.keys(servers));
    const injectedServerNames: string[] = [];
    for (const server of input.servers) {
      const uniqueName = resolveUniqueMcpServerName(server, existingNames);
      existingNames.add(uniqueName);
      injectedServerNames.push(uniqueName);
      servers[uniqueName] = {
        url: server.url,
        ...(server.token ? { headers: { Authorization: `Bearer ${server.token}` } } : {}),
      };
    }

    const configPath = path.join(configDir, "mcp_config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ ...hostConfig, mcpServers: servers }, null, 2) + "\n",
      { mode: 0o600 },
    );

    const cleanup = async (): Promise<void> => {
      await fs.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    };

    return { homeDir, configPath, injectedServerNames, cleanup };
  } catch (err) {
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
