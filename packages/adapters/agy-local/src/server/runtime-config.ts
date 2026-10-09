import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

type PreparedAgyRuntimeConfig = {
  serverNames: string[];
  cleanup: () => Promise<void>;
};

type AgyWorkspaceSkill = { name: string; source: string };

const LOCK_WAIT_MS = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error("Antigravity MCP config must be a JSON object.");
  return parsed;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Antigravity MCP config path resolves outside the workspace.");
  }
}

async function validateConfigPaths(input: {
  root: string;
  agentsDir: string;
  configPath: string;
  lockPath: string;
  skillsDir?: string;
}): Promise<void> {
  const agents = await fs.lstat(input.agentsDir);
  if (!agents.isDirectory() || agents.isSymbolicLink()) {
    throw new Error("Antigravity workspace `.agents` must be a real directory, not a symlink.");
  }
  assertContained(input.root, await fs.realpath(input.agentsDir));

  if (input.skillsDir) {
    try {
      const skills = await fs.lstat(input.skillsDir);
      if (!skills.isDirectory() || skills.isSymbolicLink()) {
        throw new Error("Antigravity workspace `.agents/skills` must be a real directory, not a symlink.");
      }
      assertContained(input.root, await fs.realpath(input.skillsDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  for (const filePath of [input.configPath, input.lockPath]) {
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Antigravity MCP config and lock paths must be regular files, not symlinks.");
      }
      assertContained(input.root, await fs.realpath(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function atomicWriteFile(
  agentsDir: string,
  filePath: string,
  content: string | Buffer,
  mode: number,
  validate: () => Promise<void>,
): Promise<void> {
  const temporaryPath = path.join(agentsDir, `.paperclip-mcp-${randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  try {
    await validate();
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function acquireLock(
  lockPath: string,
  validate: () => Promise<void>,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const owner = JSON.stringify({ pid: process.pid, nonce: `${Date.now()}-${Math.random()}` });
  while (true) {
    signal?.throwIfAborted();
    await validate();
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(owner, "utf8");
      await handle.close();
      return async () => {
        try {
          await validate();
          if ((await fs.readFile(lockPath, "utf8")) === owner) await fs.unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        await validate();
        const current = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown };
        if (typeof current.pid === "number" && !processIsAlive(current.pid)) {
          const stalePath = `${lockPath}.${process.pid}.${Date.now()}.stale`;
          try {
            await fs.rename(lockPath, stalePath);
            await fs.unlink(stalePath);
            continue;
          } catch (staleError) {
            const staleCode = (staleError as NodeJS.ErrnoException).code;
            if (staleCode === "ENOENT" || staleCode === "EEXIST") continue;
            throw staleError;
          }
        }
      } catch (readError) {
        const readCode = (readError as NodeJS.ErrnoException).code;
        if (readCode !== "ENOENT" && !(readError instanceof SyntaxError)) throw readError;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}

function uniqueServerName(name: string, connectionId: string, used: Set<string>): string {
  const base = name.trim().replace(/[^A-Za-z0-9_.-]+/g, "-") || "paperclip-mcp";
  if (!used.has(base)) return base;
  const suffix = connectionId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 24) || "connection";
  let candidate = `${base}-${suffix}`;
  let index = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix}-${index++}`;
  return candidate;
}

/** Add run-scoped Paperclip MCP servers to AGY's workspace config and restore it after the run. */
export async function prepareAgyRuntimeMcpConfig(
  cwd: string,
  servers: readonly AdapterRuntimeMcpServer[],
  signal?: AbortSignal,
  skills: readonly AgyWorkspaceSkill[] = [],
): Promise<PreparedAgyRuntimeConfig> {
  if (servers.length === 0 && skills.length === 0) return { serverNames: [], cleanup: async () => {} };

  const agentsDir = path.join(cwd, ".agents");
  const configPath = path.join(agentsDir, "mcp_config.json");
  const lockPath = path.join(agentsDir, ".paperclip-mcp-config.lock");
  const skillsDir = path.join(agentsDir, "skills");
  const root = await fs.realpath(cwd);
  await fs.mkdir(agentsDir, { recursive: true });
  const validate = () => validateConfigPaths({ root, agentsDir, configPath, lockPath, skillsDir });
  await validate();
  const releaseLock = await acquireLock(lockPath, validate, signal);
  let original: Buffer | null = null;
  let originalMode = 0o600;
  let injectedContent: string | null = null;
  let configInjected = false;
  const serverNames: string[] = [];
  const createdSkillLinks: Array<{ target: string; source: string }> = [];
  const cleanupSkillLinks = async () => {
    await validate();
    for (const link of [...createdSkillLinks].reverse()) {
      const current = await fs.lstat(link.target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!current?.isSymbolicLink()) continue;
      const linked = await fs.readlink(link.target);
      if (path.resolve(path.dirname(link.target), linked) === link.source) {
        await fs.unlink(link.target);
      }
    }
  };
  const cleanupConfig = async () => {
    if (!configInjected || injectedContent === null) return;
    try {
      await validate();
      const current = await fs.readFile(configPath, "utf8");
      const active = parseConfig(current);
      const activeServers = isObject(active.mcpServers) ? active.mcpServers : {};
      if (original && current === injectedContent) {
        await atomicWriteFile(agentsDir, configPath, original, originalMode, validate);
      } else if (current === injectedContent) {
        await fs.unlink(configPath);
      } else {
        for (const name of serverNames) delete activeServers[name];
        const restoredServers = { ...activeServers };
        if (original) {
          const baseline = parseConfig(original.toString("utf8"));
          const baselineServers = isObject(baseline.mcpServers) ? baseline.mcpServers : {};
          active.mcpServers = { ...baselineServers, ...restoredServers };
          await atomicWriteFile(agentsDir, configPath, `${JSON.stringify(active, null, 2)}\n`, originalMode, validate);
        } else if (Object.keys(restoredServers).length > 0 || Object.keys(active).length > 1) {
          active.mcpServers = restoredServers;
          await atomicWriteFile(agentsDir, configPath, `${JSON.stringify(active, null, 2)}\n`, 0o600, validate);
        } else {
          await fs.unlink(configPath);
        }
      }
      configInjected = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        configInjected = false;
        return;
      }
      throw error;
    }
  };
  try {
    if (servers.length > 0) {
      try {
        const stat = await fs.lstat(configPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error("Antigravity MCP config must be a regular file, not a symlink.");
        }
        original = await fs.readFile(configPath);
        originalMode = stat.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const existing = original ? parseConfig(original.toString("utf8")) : {};
      if (existing.mcpServers !== undefined && !isObject(existing.mcpServers)) {
        throw new Error("Antigravity MCP config property `mcpServers` must be a JSON object.");
      }
      const existingServers = isObject(existing.mcpServers) ? existing.mcpServers : {};
      const mcpServers: Record<string, unknown> = { ...existingServers };
      for (const server of servers) {
        const name = uniqueServerName(server.name, server.connectionId, new Set(Object.keys(mcpServers)));
        serverNames.push(name);
        mcpServers[name] = {
          serverUrl: server.url,
          headers: { Authorization: `Bearer ${server.token}` },
        };
      }
      injectedContent = `${JSON.stringify({ ...existing, mcpServers }, null, 2)}\n`;
      // The config includes run-scoped bearer tokens. Always restrict it while
      // tokens are present, then restore the user's original mode on cleanup.
      await atomicWriteFile(agentsDir, configPath, injectedContent, 0o600, validate);
      configInjected = true;
    }

    if (skills.length > 0) {
      await fs.mkdir(skillsDir, { recursive: true });
      await validate();
      for (const skill of skills) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill.name)) {
          throw new Error(`Invalid Antigravity workspace skill name: ${skill.name}`);
        }
        const source = await fs.realpath(skill.source);
        if (!(await fs.stat(source)).isDirectory()) {
          throw new Error(`Antigravity skill source is not a directory: ${skill.name}`);
        }
        const target = path.join(skillsDir, skill.name);
        const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (existing) {
          if (existing.isSymbolicLink()) {
            const linked = await fs.readlink(target);
            if (path.resolve(path.dirname(target), linked) === source) continue;
          }
          // Preserve user-owned skill directories and links on name collisions.
          continue;
        }
        await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
        createdSkillLinks.push({ target, source });
      }
    }

    return {
      serverNames,
      cleanup: async () => {
        try {
          await cleanupConfig();
        } finally {
          try {
            await cleanupSkillLinks();
          } finally {
            await releaseLock();
          }
        }
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await cleanupConfig();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    } finally {
      try {
        await cleanupSkillLinks();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      } finally {
        try {
          await releaseLock();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "AGY runtime setup failed and cleanup was incomplete.");
    }
    throw error;
  }
}
