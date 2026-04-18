import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function formatEmbeddedPostgresError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "embedded Postgres startup failed";
}

const PROBE_TIMEOUT_MS = 30_000;

function lookupSystemUser(name: string): { uid: number; gid: number } | null {
  try {
    const text = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of text.split("\n")) {
      const parts = line.split(":");
      if (parts[0] === name) {
        const uid = Number(parts[2]);
        const gid = Number(parts[3]);
        if (Number.isFinite(uid) && Number.isFinite(gid)) return { uid, gid };
      }
    }
  } catch {
    // /etc/passwd unreadable — let the library surface its own error
  }
  return null;
}

function findRepoNodeModules(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    const candidate = path.join(dir, "node_modules", "embedded-postgres");
    if (fs.existsSync(candidate)) return path.join(dir, "node_modules");
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// embedded-postgres@18 spawns initdb under an alternate uid/gid (typically the
// `postgres` system user) when the host is running as root. The library only
// listens for the spawned child's `exit` event — if `execve` fails with EACCES
// (e.g. the postgres user can't traverse to the initdb binary because of repo
// ACLs / mode bits), Node fires an unhandled `error` event, leaving the probe's
// initialise() promise pending forever and surfacing as a vitest "unhandled
// error" that fails the run. Detect this case by spawning `/usr/bin/test -r`
// against a known file under the workspace's node_modules with the postgres
// uid/gid: if postgres can't read it, declare support unavailable so test
// files use `describe.skip` cleanly instead of hanging or polluting the test
// report.
function preflightProbeFailure(): Promise<string | null> {
  if (process.platform !== "linux") return Promise.resolve(null);
  const geteuid = (process as { geteuid?: () => number }).geteuid;
  if (!geteuid || geteuid() !== 0) return Promise.resolve(null);

  const postgresIds = lookupSystemUser("postgres");
  if (!postgresIds) return Promise.resolve(null);

  const nodeModules = findRepoNodeModules(process.cwd());
  if (!nodeModules) return Promise.resolve(null);
  const probeTarget = path.join(nodeModules, "embedded-postgres", "package.json");
  if (!fs.existsSync(probeTarget)) return Promise.resolve(null);
  if (!fs.existsSync("/usr/bin/test")) return Promise.resolve(null);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (reason: string | null) => {
      if (settled) return;
      settled = true;
      resolve(reason);
    };
    const watchdog = setTimeout(() => finish(null), 5_000);
    let child;
    try {
      child = spawn("/usr/bin/test", ["-r", probeTarget], {
        uid: postgresIds.uid,
        gid: postgresIds.gid,
        stdio: "ignore",
      });
    } catch {
      clearTimeout(watchdog);
      finish(null);
      return;
    }
    child.on("error", () => {
      clearTimeout(watchdog);
      finish(null); // inconclusive
    });
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      if (code === 0) {
        finish(null);
      } else {
        finish(
          `running as root, but the postgres user (uid ${postgresIds.uid}) cannot ` +
            `read ${probeTarget}; embedded-postgres drops to that uid before spawning initdb, ` +
            `which then fails with EACCES. Fix repo ACLs (e.g. \`setfacl -R -m m::r-x,u:postgres:r-x\` ` +
            `on the workspace root) or run tests as a non-root user.`,
        );
      }
    });
  });
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  const preflightReason = await preflightProbeFailure();
  if (preflightReason) {
    return { supported: false, reason: preflightReason };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-postgres-probe-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      // embedded-postgres@18 spawns initdb with an alternate uid/gid and listens
      // only for 'exit' — a spawn 'error' (e.g. EACCES when the postgres user can't
      // traverse to the binary path) leaves the promise pending forever. Bound the
      // probe so callers get a graceful `supported: false` instead of a test hang.
      reject(new Error(`embedded Postgres probe did not complete within ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      (async () => {
        await instance.initialise();
        await instance.start();
      })(),
      timeoutPromise,
    ]);
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    await instance.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  return await embeddedPostgresSupportPromise;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  try {
    await instance.initialise();
    await instance.start();

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        await instance.stop().catch(() => {});
        fs.rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await instance.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
    );
  }
}
