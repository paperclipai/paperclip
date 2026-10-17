import { spawn, type ChildProcess } from "node:child_process";
import { chownSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  ensureLinuxSharedLibraryAliases,
  resolveEmbeddedPostgresNativeDirs,
} from "@paperclipai/db/embedded-postgres-native";

/** OS identity for a child process; null keeps the current user (tests only). */
export type ProcessIdentity = { uid: number; gid: number } | null;

export type EngineBinaries = {
  binDir: string;
  libDir: string;
  version: string;
  major: number;
};

export const SUPERVISOR_ROLE = "paperclip_supervisor";

function identityOptions(identity: ProcessIdentity) {
  return identity ? { uid: identity.uid, gid: identity.gid } : {};
}

function chownIfNeeded(target: string, identity: ProcessIdentity): void {
  if (identity) chownSync(target, identity.uid, identity.gid);
}

async function runToCompletion(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; identity: ProcessIdentity; cwd?: string },
): Promise<string> {
  const child = spawn(command, args, {
    env: options.env,
    cwd: options.cwd ?? "/",
    stdio: ["ignore", "pipe", "pipe"],
    ...identityOptions(options.identity),
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output = (output + String(chunk)).slice(-16_384); });
  child.stderr?.on("data", (chunk) => { output = (output + String(chunk)).slice(-16_384); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  if (code !== 0) {
    throw new Error(`${path.basename(command)} failed with exit code ${code}: ${output.trim()}`);
  }
  return output;
}

export function engineEnv(binaries: Pick<EngineBinaries, "libDir">): NodeJS.ProcessEnv {
  const ld = [binaries.libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LD_LIBRARY_PATH: ld,
    LANG: "C",
    LC_ALL: "C",
  };
}

/** Locate the bundled engine and read its actual version. */
export async function resolveEngineBinaries(override?: { binDir: string; libDir: string }): Promise<EngineBinaries> {
  const dirs = override ?? (await resolveEmbeddedPostgresNativeDirs());
  if (!dirs) throw new Error("This image has no bundled PostgreSQL engine for this platform");
  if (existsSync(dirs.libDir)) await ensureLinuxSharedLibraryAliases(dirs.libDir);
  const output = await runToCompletion(path.join(dirs.binDir, "postgres"), ["--version"], {
    env: engineEnv(dirs),
    identity: null,
  });
  const match = output.match(/\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/);
  if (!match) throw new Error(`Cannot parse bundled PostgreSQL version from: ${output.trim()}`);
  const major = Number(match[1]);
  return { ...dirs, version: match[2] ? `${match[1]}.${match[2]}` : match[1]!, major };
}

/** PG_VERSION of an existing data directory, or null when absent. */
export function readDataDirectoryMajor(dataDir: string): number | null {
  const file = path.join(dataDir, "PG_VERSION");
  if (!existsSync(file)) return null;
  const value = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Unreadable PG_VERSION in ${dataDir}`);
  return value;
}

export async function initializeCluster(opts: {
  binaries: EngineBinaries;
  dataDir: string;
  superuserPassword: string;
  identity: ProcessIdentity;
}): Promise<void> {
  const pwfile = path.join(path.dirname(opts.dataDir), `.initdb-pw-${process.pid}`);
  writeFileSync(pwfile, `${opts.superuserPassword}\n`, { mode: 0o600 });
  chownIfNeeded(pwfile, opts.identity);
  try {
    await runToCompletion(path.join(opts.binaries.binDir, "initdb"), [
      `--pgdata=${opts.dataDir}`,
      `--username=${SUPERVISOR_ROLE}`,
      `--pwfile=${pwfile}`,
      "--auth-local=scram-sha-256",
      "--auth-host=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
      "--lc-messages=C",
    ], { env: engineEnv(opts.binaries), identity: opts.identity });
  } finally {
    rmSync(pwfile, { force: true });
  }
}

/**
 * Host-based access: privileged roles only over the supervisor's Unix socket
 * directory (0700, owned by the database OS user); tenant roles only over
 * loopback TCP to the tenant database; everything else is rejected.
 */
export function renderHbaConfig(database: string): string {
  return [
    "# Managed by the Paperclip managed database supervisor. Rewritten at every start.",
    `local   all        ${SUPERVISOR_ROLE},paperclip_owner   scram-sha-256`,
    `host    ${database} paperclip_app,paperclip_plugin   127.0.0.1/32   scram-sha-256`,
    "local   all        all                               reject",
    "host    all        all   0.0.0.0/0                   reject",
    "host    all        all   ::/0                        reject",
    "",
  ].join("\n");
}

export type RunningEngine = {
  process: ChildProcess;
  start(): Promise<void>;
  stop(): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export type EngineStartOptions = {
  binaries: EngineBinaries;
  dataDir: string;
  socketDir: string;
  port: number;
  database: string;
  superuserPassword: string;
  identity: ProcessIdentity;
  onLog?: (line: string) => void;
  startTimeoutMs?: number;
};

/** Superuser client over the Unix socket. */
export function supervisorSql(opts: Pick<EngineStartOptions, "socketDir" | "port" | "superuserPassword">, database: string) {
  return postgres({
    host: opts.socketDir,
    port: opts.port,
    user: SUPERVISOR_ROLE,
    password: opts.superuserPassword,
    database,
    max: 1,
    onnotice: () => {},
    connect_timeout: 5,
    idle_timeout: 5,
  });
}

/**
 * Creates (but does not start) a postgres child bound to the given settings.
 * Shaped for `createEmbeddedPostgresSupervisor`, which restarts on crashes.
 */
export function createEngine(opts: EngineStartOptions): RunningEngine {
  let child: ChildProcess | null = null;
  let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExit = resolve; });

  const engine: RunningEngine = {
    get process() {
      if (!child) throw new Error("engine not started");
      return child;
    },
    exited,
    async start() {
      writeFileSync(path.join(opts.dataDir, "pg_hba.conf"), renderHbaConfig(opts.database), { mode: 0o600 });
      chownIfNeeded(path.join(opts.dataDir, "pg_hba.conf"), opts.identity);
      child = spawn(path.join(opts.binaries.binDir, "postgres"), [
        "-D", opts.dataDir,
        "-c", "listen_addresses=127.0.0.1",
        "-c", `port=${opts.port}`,
        "-c", `unix_socket_directories=${opts.socketDir}`,
        "-c", "unix_socket_permissions=0700",
        "-c", "password_encryption=scram-sha-256",
        "-c", "logging_collector=off",
      ], {
        env: engineEnv(opts.binaries),
        cwd: opts.dataDir,
        stdio: ["ignore", "pipe", "pipe"],
        ...identityOptions(opts.identity),
      });
      const started = child;
      const forward = (chunk: Buffer) => {
        for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) opts.onLog?.(line);
      };
      started.stdout?.on("data", forward);
      started.stderr?.on("data", forward);
      started.once("exit", (code, signal) => resolveExit({ code, signal }));

      const deadline = Date.now() + (opts.startTimeoutMs ?? 60_000);
      let exitedEarly = false;
      void exited.then(() => { exitedEarly = true; });
      let lastError: unknown = null;
      while (Date.now() < deadline) {
        if (exitedEarly) throw new Error("PostgreSQL exited during startup");
        const sql = supervisorSql(opts, "postgres");
        try {
          await sql`select 1`;
          return;
        } catch (error) {
          lastError = error;
        } finally {
          await sql.end({ timeout: 1 }).catch(() => {});
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      started.kill("SIGQUIT");
      throw new Error(`PostgreSQL did not accept connections in time: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    },
    async stop() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGINT"); // fast shutdown: abort transactions, checkpoint, exit
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30_000)),
      ]);
      if (timedOut) {
        child.kill("SIGQUIT");
        await exited;
      }
    },
  };
  return engine;
}
