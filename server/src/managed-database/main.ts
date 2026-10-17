import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  MANAGED_DATABASE_ENV,
  MANAGED_DATABASE_SNAPSHOT_FORMAT,
  MANAGED_DATABASE_SUPPORTED_CONTRACT_VERSIONS,
  MANAGED_DATABASE_SUPPORTED_ENGINE_MAJORS,
  managedDatabaseReleaseSchema,
  parseManagedDatabaseConfig,
  type ManagedDatabaseCapability,
  type ManagedDatabaseRelease,
} from "@paperclipai/shared/managed-database";
import { parseManagedDatabaseControlKey } from "@paperclipai/shared/managed-database-server";
import { readBundledMigrationRelease } from "@paperclipai/db/migration-release";
import { closeServer, createControlServer, listenTcp, listenUnix } from "./control-server.js";
import { resolveEngineBinaries, type ProcessIdentity } from "./engine.js";
import { resolvePgClientTools } from "./snapshots.js";
import { ManagedDatabaseSupervisor, type SupervisorLogger } from "./supervisor.js";

export const DEFAULT_DB_OS_USER = "paperclip-db";
export const DEFAULT_APP_OS_USER = "node";
export const DEFAULT_PG_PORT = 54329;

/**
 * In the image, the supervisor runs from a root-owned bundle
 * (scripts/build-managed-database-supervisor.mjs) because it starts as root
 * and the app user owns /app. The bundle carries its own engine, migrations,
 * and pinned release identity beside main.mjs; a source checkout has none.
 */
function bundleAsset(name: string): string | null {
  const target = fileURLToPath(new URL(`./${name}`, import.meta.url));
  return existsSync(target) ? target : null;
}

function bundledEngineDirs(): { binDir: string; libDir: string } | undefined {
  const engine = bundleAsset("engine");
  if (!engine || !existsSync(path.join(engine, "bin", "postgres"))) return undefined;
  return { binDir: path.join(engine, "bin"), libDir: path.join(engine, "lib") };
}

export async function readRelease(): Promise<ManagedDatabaseRelease> {
  const bundled = await readBundledMigrationRelease();
  const pinnedFile = bundleAsset("release.json");
  if (pinnedFile) {
    // Written at image build from the app's own tree; the bundle's migration
    // copy must be the same set, or the image is inconsistent.
    const pinned = managedDatabaseReleaseSchema.parse(JSON.parse(readFileSync(pinnedFile, "utf8")));
    const { migrationsDigest, latestMigration, migrationCount } = pinned;
    if (canonicalJson({ migrationsDigest, latestMigration, migrationCount }) !== canonicalJson(bundled)) {
      throw new Error(`${pinnedFile} does not describe the bundled migrations`);
    }
    return pinned;
  }
  // Loaded lazily: these resolve files relative to the server package, which
  // a bundle does not have.
  const [{ serverVersion }, { readBuildCommit }] = await Promise.all([import("../version.js"), import("../build-commit.js")]);
  return { ...bundled, version: serverVersion, commit: readBuildCommit() };
}

export async function readCapability(env: NodeJS.ProcessEnv = process.env): Promise<ManagedDatabaseCapability> {
  const engine = await resolveEngineBinaries(bundledEngineDirs());
  const tools = await resolvePgClientTools(engine.major, env);
  return {
    contractVersions: [...MANAGED_DATABASE_SUPPORTED_CONTRACT_VERSIONS],
    engineMajors: (MANAGED_DATABASE_SUPPORTED_ENGINE_MAJORS as readonly number[]).filter((major) => major === engine.major),
    engineVersion: engine.version,
    snapshotFormats: tools ? [MANAGED_DATABASE_SNAPSHOT_FORMAT] : [],
    release: await readRelease(),
  };
}

/** uid/gid of a local account from /etc/passwd (Node has no getpwnam). */
export function lookupOsUser(name: string, passwd = readFileSync("/etc/passwd", "utf8")): { uid: number; gid: number } {
  for (const line of passwd.split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === name) return { uid: Number(uid), gid: Number(gid) };
  }
  throw new Error(`OS user ${name} does not exist`);
}

/**
 * Production identity rules: the supervisor runs as root, PostgreSQL as a
 * dedicated account, and the tenant app as a different unprivileged account.
 */
export function resolveProductionIdentities(env: NodeJS.ProcessEnv, getuid: () => number = process.getuid!): {
  db: NonNullable<ProcessIdentity>;
  app: NonNullable<ProcessIdentity>;
} {
  if (getuid() !== 0) {
    throw new Error("the managed database supervisor must start as root to separate the database and app identities");
  }
  const db = lookupOsUser(env.PAPERCLIP_MANAGED_DATABASE_DB_USER || DEFAULT_DB_OS_USER);
  const app = lookupOsUser(env.PAPERCLIP_MANAGED_DATABASE_APP_USER || DEFAULT_APP_OS_USER);
  if (db.uid === 0 || app.uid === 0) throw new Error("database and app OS users must not be root");
  if (db.uid === app.uid) throw new Error("database and app OS users must differ");
  return { db, app };
}

function jsonLogger(): SupervisorLogger {
  const write = (level: string) => (fields: Record<string, unknown>, message: string) => {
    process.stderr.write(`${JSON.stringify({ level, time: new Date().toISOString(), component: "managed-database", msg: message, ...fields })}\n`);
  };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

async function run(argv: string[]): Promise<void> {
  const logger = jsonLogger();
  const env = { ...process.env };
  const parsed = parseManagedDatabaseConfig(env[MANAGED_DATABASE_ENV.config]);
  if (parsed.status !== "valid") {
    throw new Error(parsed.status === "absent" ? `${MANAGED_DATABASE_ENV.config} is not set` : parsed.error);
  }
  const controlKey = parseManagedDatabaseControlKey(env[MANAGED_DATABASE_ENV.controlKey]);
  // Keep the key out of anything this process spawns.
  delete process.env[MANAGED_DATABASE_ENV.controlKey];

  const identities = resolveProductionIdentities(env);
  const engine = await resolveEngineBinaries(bundledEngineDirs());
  const pgTools = await resolvePgClientTools(engine.major, env);
  const separator = argv.indexOf("--");
  const appCommand = separator >= 0 ? argv.slice(separator + 1) : [];
  const httpPort = Number(env.PORT || 3100);
  const pgPort = Number(env.PAPERCLIP_MANAGED_DATABASE_PG_PORT || DEFAULT_PG_PORT);

  let tcpServer: Server | null = null;
  let unixServer: Server | null = null;
  let shuttingDown = false;
  const supervisor = new ManagedDatabaseSupervisor({
    config: parsed.config,
    controlKey,
    env,
    engine,
    pgTools,
    release: await readRelease(),
    dbIdentity: identities.db,
    appIdentity: identities.app,
    pgPort,
    appCommand,
    logger,
    onFatal: (code, reason) => {
      logger.error({ code, reason }, "managed database supervisor stopping");
      void shutdown(code === 0 ? 1 : code);
    },
  });

  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeServer(tcpServer);
    await supervisor.stop().catch((error) => logger.error({ err: String(error) }, "supervisor stop failed"));
    await closeServer(unixServer);
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));

  await supervisor.start();
  const maintenanceSurface = () => !supervisor.appRunning;
  unixServer = createControlServer(supervisor, maintenanceSurface);
  await listenUnix(unixServer, supervisor.layout.controlSocket);
  if (!supervisor.appRunning) {
    tcpServer = createControlServer(supervisor, maintenanceSurface);
    await listenTcp(tcpServer, httpPort, env.HOST || "0.0.0.0");
    logger.info({ port: httpPort, readiness: supervisor.readiness().status }, "maintenance surface listening");
  }
}

async function main(): Promise<void> {
  const [command = "run", ...rest] = process.argv.slice(2);
  if (command === "capability") {
    process.stdout.write(`${JSON.stringify(await readCapability(), null, 2)}\n`);
    return;
  }
  if (command === "release") {
    process.stdout.write(`${JSON.stringify(await readRelease(), null, 2)}\n`);
    return;
  }
  if (command === "run") {
    await run(rest);
    return;
  }
  throw new Error(`unknown command ${command}; expected "run", "capability", or "release"`);
}

/** Process entry: the image bundle calls this; a source checkout runs main.ts. */
export function runCli(): void {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ level: "fatal", component: "managed-database", msg: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  });
}

const invokedDirectly = process.argv[1] && /managed-database[\\/]main\.(?:js|ts)$/.test(process.argv[1]);
if (invokedDirectly) runCli();
