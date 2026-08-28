import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  getPostgresDataDirectory,
  postmasterLockFilePath,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  EMBEDDED_POSTGRES_PORT_SCAN_WINDOW,
  decideEmbeddedCluster,
} from "../embedded-postgres-ownership.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Starting a real cluster does not fit vitest's default timeout; see the
// embedded-Postgres suites in packages/db for the same allowance.
const CLUSTER_TEST_TIMEOUT_MS = 120_000;

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/** A port whose immediate successor is free too, so the scan window is ours. */
async function findFreePortWithFreeSuccessor(): Promise<number> {
  for (let port = 55_600; port < 55_900; port += 2) {
    if ((await isPortFree(port)) && (await isPortFree(port + 1))) return port;
  }
  throw new Error("No free port pair available for the ownership scan test.");
}

async function findFreePortBelow(ceiling: number, window: number): Promise<number> {
  for (let port = ceiling - 1; port >= ceiling - window && port > 1024; port -= 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port within ${window} below ${ceiling}.`);
}

/**
 * Accepts connections and then says nothing, like a non-PostgreSQL service.
 *
 * The returned `close` drops live sockets first. A probe that gave up on this
 * server still holds its connection open, and `server.close()` alone waits for
 * exactly those.
 */
async function listenSilently(port: number): Promise<{ close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("decideEmbeddedCluster port scan", () => {
  it("still starts when a neighbouring port is held by something that will not identify itself", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ownership-neighbour-"));
    const preferredPort = await findFreePortWithFreeSuccessor();
    const holder = await listenSilently(preferredPort + 1);
    try {
      // A silent neighbour is evidence about that port, not about this
      // directory. Refusing here would block every seed that runs near an
      // unrelated service.
      await expect(decideEmbeddedCluster(dataDir, preferredPort)).resolves.toEqual({
        action: "start",
      });
    } finally {
      await holder.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describeEmbeddedPostgres("decideEmbeddedCluster against a live cluster", () => {
  it(
    "adopts a live cluster listening above the preferred port when its lock file is gone",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-ownership-scan-");
      cleanups.push(database.cleanup);

      const actualPort = Number(/:(\d+)\//.exec(database.connectionString)?.[1]);
      expect(Number.isInteger(actualPort)).toBe(true);
      const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${actualPort}/postgres`;
      const dataDir = await getPostgresDataDirectory(adminConnectionString);
      expect(typeof dataDir).toBe("string");

      const preferredPort = await findFreePortBelow(actualPort, EMBEDDED_POSTGRES_PORT_SCAN_WINDOW);

      // Without postmaster.pid the lock reads "absent", and the preferred port is
      // idle. Before the port scan that combination answered "start", and the
      // worktree seed path went on to reset this live database.
      const lockPath = postmasterLockFilePath(dataDir as string);
      const setAside = `${lockPath}.set-aside`;
      fs.renameSync(lockPath, setAside);
      try {
        await expect(decideEmbeddedCluster(dataDir as string, preferredPort)).resolves.toEqual({
          action: "adopt",
          port: actualPort,
        });
      } finally {
        fs.renameSync(setAside, lockPath);
      }
    },
    CLUSTER_TEST_TIMEOUT_MS,
  );
});
