import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { waitForPostgresReady } from "./client.js";
import {
  inspectPostmasterLock,
  postmasterLockFilePath,
  probeProcessLiveness,
} from "./embedded-postgres-lock.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Starting a real cluster does not fit vitest's default timeout; see the sibling
// embedded-Postgres migration suites for the same allowance.
const CLUSTER_TEST_TIMEOUT_MS = 120_000;

type LiveCluster = {
  dataDir: string;
  port: number;
  adminConnectionString: string;
};

async function describeLiveCluster(connectionString: string): Promise<LiveCluster> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ dd: string; p: string }[]>`
      select current_setting('data_directory') as dd, current_setting('port') as p
    `;
    const dataDir = rows[0]?.dd ?? "";
    const port = Number(rows[0]?.p);
    return {
      dataDir,
      port,
      adminConnectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`,
    };
  } finally {
    await sql.end();
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describeEmbeddedPostgres("embedded PostgreSQL lifecycle against a live cluster", () => {
  it(
    "never clears the lock file of a running postmaster, and reports the port it actually listens on",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-pg-lifecycle-");
      cleanups.push(database.cleanup);
      const cluster = await describeLiveCluster(database.connectionString);

      const lockPath = postmasterLockFilePath(cluster.dataDir);
      expect(fs.existsSync(lockPath)).toBe(true);

      // The data directory must be reported as occupied, so callers adopt the
      // cluster instead of picking a free port and starting a second postmaster
      // over the same files.
      const inspected = inspectPostmasterLock(cluster.dataDir);
      expect(inspected.status).toBe("running");
      if (inspected.status !== "running") throw new Error("expected a running cluster");

      // Adoption has to target the port the postmaster really bound, not the
      // port we would have preferred.
      expect(inspected.lock.port).toBe(cluster.port);
      expect(path.resolve(inspected.lock.dataDir ?? "")).toBe(path.resolve(cluster.dataDir));
      expect(probeProcessLiveness(inspected.lock.pid)).toBe("alive");

      // The destructive step behind the original failure was deleting a live
      // cluster's postmaster.pid, which orphans it from its own lock. No code
      // path may remove this file any more: PostgreSQL clears a stale lock
      // itself, atomically, as it takes ownership. A live lock therefore stays.
      expect(inspectPostmasterLock(cluster.dataDir).status).toBe("running");
      expect(fs.existsSync(lockPath)).toBe(true);
    },
    CLUSTER_TEST_TIMEOUT_MS,
  );

  it(
    "resolves the readiness wait against a cluster that is already accepting connections",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-pg-readiness-");
      cleanups.push(database.cleanup);
      const cluster = await describeLiveCluster(database.connectionString);

      await expect(
        waitForPostgresReady(cluster.adminConnectionString, { timeoutMs: 30_000 }),
      ).resolves.toBeUndefined();
    },
    CLUSTER_TEST_TIMEOUT_MS,
  );

  it(
    "treats a data directory with no postmaster as free to start",
    async () => {
      const emptyDataDir = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "paperclip-pg-empty-"));
      cleanups.push(async () => fs.rmSync(emptyDataDir, { recursive: true, force: true }));

      expect(inspectPostmasterLock(emptyDataDir).status).toBe("absent");
    },
    CLUSTER_TEST_TIMEOUT_MS,
  );
});
