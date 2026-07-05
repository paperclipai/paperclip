import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, withFileLock } from "./fs-atomic.js";

/**
 * Per-run external MCP server injection for Gemini CLI.
 *
 * The heartbeat layer resolves the agent's `adapterConfig.mcpServers` (secret
 * refs -> plaintext) before invoking the adapter; this module translates that
 * resolved record into Gemini's `settings.json` `mcpServers` shape and merges
 * it into the per-agent workspace settings file (`<cwd>/.gemini/settings.json`,
 * local runs) or a synced asset copied into the managed remote home (remote
 * runs). Injected entries are tracked via a sentinel key so re-runs stay
 * idempotent and servers removed from the agent config disappear.
 *
 * The written files contain resolved secrets — they are 0600, scoped to the
 * per-agent workspace / per-run home, and must never be logged.
 */

/** Sentinel settings key tracking which mcpServers entries Paperclip manages. */
export const GEMINI_MANAGED_MCP_SENTINEL_KEY = "_paperclipManagedMcpServers";

export interface ResolvedMcpServerEntry {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  allowedTools?: string[];
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Defensively parse `config.mcpServers` as handed to the adapter. Only
 * fully-resolved entries (plain string values) are accepted; unresolved
 * binding objects are ignored so a mis-wired call can't leak refs into args.
 */
export function parseResolvedMcpServers(value: unknown): Record<string, ResolvedMcpServerEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const servers: Record<string, ResolvedMcpServerEntry> = {};
  for (const [name, rawServer] of Object.entries(value as Record<string, unknown>)) {
    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
    const server = rawServer as Record<string, unknown>;
    const transport = server.transport;
    if (transport === "stdio") {
      const command = typeof server.command === "string" ? server.command.trim() : "";
      if (!command) continue;
      const cwd = typeof server.cwd === "string" && server.cwd.trim().length > 0 ? server.cwd : undefined;
      servers[name] = {
        transport,
        command,
        args: Array.isArray(server.args)
          ? server.args.filter((arg): arg is string => typeof arg === "string")
          : [],
        env: asStringRecord(server.env),
        ...(cwd ? { cwd } : {}),
        timeoutMs: asPositiveNumber(server.timeoutMs),
        allowedTools: Array.isArray(server.allowedTools)
          ? server.allowedTools.filter((tool): tool is string => typeof tool === "string")
          : undefined,
      };
      continue;
    }
    if (transport !== "http" && transport !== "sse") continue;
    const url = typeof server.url === "string" ? server.url.trim() : "";
    if (!url) continue;
    servers[name] = {
      transport,
      url,
      headers: asStringRecord(server.headers),
      timeoutMs: asPositiveNumber(server.timeoutMs),
      allowedTools: Array.isArray(server.allowedTools)
        ? server.allowedTools.filter((tool): tool is string => typeof tool === "string")
        : undefined,
    };
  }
  return servers;
}

/**
 * Translate resolved servers into Gemini's `settings.json` `mcpServers` shape.
 * Canonical `http` maps to `httpUrl` (streamable HTTP), `sse` maps to `url`,
 * `allowedTools` maps to `includeTools`, and every injected server gets
 * `trust: true` so unattended runs never block on per-tool confirmation.
 */
export function buildGeminiMcpServersSettings(
  servers: Record<string, ResolvedMcpServerEntry>,
): Record<string, Record<string, unknown>> {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    const shared = {
      ...(server.timeoutMs !== undefined ? { timeout: server.timeoutMs } : {}),
      trust: true,
      ...(server.allowedTools && server.allowedTools.length > 0
        ? { includeTools: server.allowedTools }
        : {}),
    };
    if (server.transport === "stdio") {
      mcpServers[name] = {
        command: server.command,
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        ...shared,
      };
      continue;
    }
    mcpServers[name] = {
      ...(server.transport === "http" ? { httpUrl: server.url } : { url: server.url }),
      ...(server.headers && Object.keys(server.headers).length > 0
        ? { headers: server.headers }
        : {}),
      ...shared,
    };
  }
  return mcpServers;
}

export interface GeminiWorkspaceMcpSyncResult {
  settingsPath: string;
  injectedNames: string[];
  removedStaleNames: string[];
}

/**
 * Merge the resolved servers into `<cwd>/.gemini/settings.json` (read-modify-
 * write, preserving unrelated keys). Previously injected entries are tracked
 * under the sentinel key and removed before applying the current set, so the
 * merge is idempotent and servers deleted from the agent config disappear.
 * Returns null when there is nothing to inject and nothing stale to clean up.
 */
export async function syncGeminiWorkspaceMcpSettings(input: {
  cwd: string;
  servers: Record<string, ResolvedMcpServerEntry>;
}): Promise<GeminiWorkspaceMcpSyncResult | null> {
  const settingsDir = path.join(input.cwd, ".gemini");
  const settingsPath = path.join(settingsDir, "settings.json");
  const injectedNames = Object.keys(input.servers);

  // Serialize the read-modify-write against concurrent same-agent runs sharing
  // this workspace settings file, and rewrite atomically (temp + rename) so a
  // launching CLI never reads a torn/empty settings.json.
  return withFileLock(settingsPath, async () => {
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await fs.readFile(settingsPath, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or unparseable settings file — start from an empty document.
    }

    const previouslyManaged = Array.isArray(existing[GEMINI_MANAGED_MCP_SENTINEL_KEY])
      ? (existing[GEMINI_MANAGED_MCP_SENTINEL_KEY] as unknown[]).filter(
          (name): name is string => typeof name === "string",
        )
      : [];
    if (injectedNames.length === 0 && previouslyManaged.length === 0) return null;

    const existingMcpRaw = existing.mcpServers;
    const existingMcp =
      existingMcpRaw && typeof existingMcpRaw === "object" && !Array.isArray(existingMcpRaw)
        ? { ...(existingMcpRaw as Record<string, unknown>) }
        : {};
    const removedStaleNames = previouslyManaged.filter(
      (name) => name in existingMcp && !(name in input.servers),
    );
    for (const name of previouslyManaged) delete existingMcp[name];
    const merged = { ...existingMcp, ...buildGeminiMcpServersSettings(input.servers) };

    const next: Record<string, unknown> = { ...existing };
    if (Object.keys(merged).length > 0) {
      next.mcpServers = merged;
    } else {
      delete next.mcpServers;
    }
    if (injectedNames.length > 0) {
      next[GEMINI_MANAGED_MCP_SENTINEL_KEY] = injectedNames;
    } else {
      delete next[GEMINI_MANAGED_MCP_SENTINEL_KEY];
    }

    await fs.mkdir(settingsDir, { recursive: true });
    await atomicWriteFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    // mode is asserted on create by atomicWriteFile — re-assert after rename.
    await fs.chmod(settingsPath, 0o600).catch(() => undefined);
    return { settingsPath, injectedNames, removedStaleNames };
  });
}

/**
 * Strip every sentinel-tracked mcpServers entry (and the sentinel key) from
 * `<cwd>/.gemini/settings.json` after a run, so resolved plaintext secrets live
 * on disk only while the run is active. If the file has no sentinel key it is
 * left byte-identical (a user-owned settings.json is never touched). If the
 * document becomes empty after stripping it is deleted (the file was solely
 * paperclip-created). Returns the outcome, or null when there was nothing to do.
 */
export async function stripGeminiWorkspaceMcpSettings(input: {
  cwd: string;
}): Promise<{ settingsPath: string; removedNames: string[]; deletedFile: boolean } | null> {
  const settingsPath = path.join(input.cwd, ".gemini", "settings.json");
  return withFileLock(settingsPath, async () => {
    let existing: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await fs.readFile(settingsPath, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      existing = parsed as Record<string, unknown>;
    } catch {
      // Missing or unparseable — nothing to strip.
      return null;
    }

    // No sentinel key => this file was not written/managed by us; leave it as-is.
    if (!Array.isArray(existing[GEMINI_MANAGED_MCP_SENTINEL_KEY])) return null;
    const managed = (existing[GEMINI_MANAGED_MCP_SENTINEL_KEY] as unknown[]).filter(
      (name): name is string => typeof name === "string",
    );

    const mcpRaw = existing.mcpServers;
    const mcp =
      mcpRaw && typeof mcpRaw === "object" && !Array.isArray(mcpRaw)
        ? { ...(mcpRaw as Record<string, unknown>) }
        : {};
    const removedNames = managed.filter((name) => name in mcp);
    for (const name of managed) delete mcp[name];

    const next: Record<string, unknown> = { ...existing };
    delete next[GEMINI_MANAGED_MCP_SENTINEL_KEY];
    if (Object.keys(mcp).length > 0) {
      next.mcpServers = mcp;
    } else {
      delete next.mcpServers;
    }

    if (Object.keys(next).length === 0) {
      // The file was solely paperclip-created — remove it entirely.
      await fs.rm(settingsPath, { force: true }).catch(() => undefined);
      return { settingsPath, removedNames, deletedFile: true };
    }

    await atomicWriteFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    await fs.chmod(settingsPath, 0o600).catch(() => undefined);
    return { settingsPath, removedNames, deletedFile: false };
  });
}

/**
 * Resolve the git directory for `<cwd>`. For a normal checkout `<cwd>/.git` is
 * a directory; for a git worktree (this codebase's `git_worktree` strategy) it
 * is a file containing a `gitdir: <path>` pointer to the real per-worktree git
 * dir. Returns null when there is no git repo at `<cwd>`.
 */
async function resolveWorkspaceGitDir(cwd: string): Promise<string | null> {
  const dotGit = path.join(cwd, ".git");
  const stat = await fs.stat(dotGit).catch(() => null);
  if (!stat) return null;
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  const contents = await fs.readFile(dotGit, "utf-8").catch(() => "");
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!match) return null;
  const pointer = match[1];
  return path.isAbsolute(pointer) ? pointer : path.resolve(cwd, pointer);
}

/**
 * When `<cwd>` is a git repo (normal checkout OR worktree), idempotently append
 * `.gemini/settings.json` to the git dir's `info/exclude` so the secret-bearing
 * settings file can never be staged by `git add -A` during the run. No-op when
 * there is no `.git`. Returns whether the entry was newly added.
 */
export async function ensureGeminiWorkspaceGitExclude(input: { cwd: string }): Promise<boolean> {
  const gitDir = await resolveWorkspaceGitDir(input.cwd);
  if (!gitDir) return false;
  const excludePath = path.join(gitDir, "info", "exclude");
  const entry = ".gemini/settings.json";
  let contents = "";
  try {
    contents = await fs.readFile(excludePath, "utf-8");
  } catch {
    // Missing exclude file — create it below.
  }
  const alreadyPresent = contents
    .split(/\r?\n/)
    .some((line) => line.trim() === entry);
  if (alreadyPresent) return false;
  const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.appendFile(excludePath, `${prefix}${entry}\n`, "utf-8");
  return true;
}

export interface PreparedGeminiMcpSettingsAsset {
  /** Local directory to sync as a runtime asset for remote execution. */
  localDir: string;
  /** Absolute local path of the written settings file. */
  localFilePath: string;
  /** File name inside the asset dir (stable for remote path joins). */
  fileName: string;
  cleanup: () => Promise<void>;
}

/**
 * Write a standalone Gemini settings.json asset (0600 inside a 0700 temp dir)
 * for remote runs, where it is copied into the managed per-run remote HOME as
 * `~/.gemini/settings.json`. Contains resolved secrets — always call
 * `cleanup()` after the run.
 */
export async function prepareGeminiMcpSettingsAsset(input: {
  servers: Record<string, ResolvedMcpServerEntry>;
}): Promise<PreparedGeminiMcpSettingsAsset> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-mcp-"));
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const fileName = "settings.json";
  const filePath = path.join(dir, fileName);
  const document = {
    mcpServers: buildGeminiMcpServersSettings(input.servers),
    [GEMINI_MANAGED_MCP_SENTINEL_KEY]: Object.keys(input.servers),
  };
  await fs.writeFile(filePath, JSON.stringify(document, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return {
    localDir: dir,
    localFilePath: filePath,
    fileName,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
