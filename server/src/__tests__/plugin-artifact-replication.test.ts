import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, pluginArtifactGenerations, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import type { StorageProvider } from "../storage/types.js";
import { createPluginArtifactReplication } from "../services/plugin-artifact-replication.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

const MARKER = ".paperclip-snapshot-generation";

async function collectObject(provider: StorageProvider, objectKey: string): Promise<Buffer> {
  const result = await provider.getObject({ objectKey });
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

describeEmbedded("plugin artifact replication", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let dbA: Db;
  let dbB: Db;
  // Fresh per test: a REAL local_disk provider over a tmp base dir, plus two
  // tmp plugin trees (A publishes, B reconciles).
  let provider: StorageProvider;
  let dirA: string;
  let dirB: string;
  const tmpDirs: string[] = [];

  async function mkTmpDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  function makeService(
    db: Db,
    pluginsDir: string,
    replicaId: string,
    onApplySnapshot: () => Promise<void> = async () => {},
  ) {
    return createPluginArtifactReplication({
      db,
      provider,
      pluginsDir,
      replicaId,
      onApplySnapshot,
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-artifact-replication-");
    dbA = createDb(tempDb.connectionString);
    dbB = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  beforeEach(async () => {
    await dbA.delete(pluginArtifactGenerations);
    provider = createLocalDiskStorageProvider(await mkTmpDir("paperclip-snap-store-"));
    dirA = await mkTmpDir("paperclip-plugins-a-");
    dirB = await mkTmpDir("paperclip-plugins-b-");
  });

  it("publishSnapshot writes row gen 1 with sha + createdBy, a retrievable object, and the marker", async () => {
    await fs.writeFile(path.join(dirA, "plugin.txt"), "hello");
    const service = makeService(dbA, dirA, "replica-a");

    const result = await service.publishSnapshot();
    expect(result).toEqual({ generation: 1 });

    const rows = await dbA.select().from(pluginArtifactGenerations);
    expect(rows).toHaveLength(1);
    expect(rows[0].generation).toBe(1);
    expect(rows[0].createdBy).toBe("replica-a");
    expect(rows[0].storageKey).toBe("plugin-snapshots/gen-1.tgz");

    const body = await collectObject(provider, rows[0].storageKey);
    expect(body.length).toBeGreaterThan(0);
    expect(sha256Hex(body)).toBe(rows[0].contentHash);

    expect(await fs.readFile(path.join(dirA, MARKER), "utf8")).toBe("1");
  });

  it("concurrent publishes from two instances yield generations {1,2} with both objects stored (CAS retry)", async () => {
    await fs.writeFile(path.join(dirA, "a.txt"), "from-a");
    await fs.writeFile(path.join(dirB, "b.txt"), "from-b");
    const serviceA = makeService(dbA, dirA, "replica-a");
    const serviceB = makeService(dbB, dirB, "replica-b");

    const [resultA, resultB] = await Promise.all([
      serviceA.publishSnapshot(),
      serviceB.publishSnapshot(),
    ]);

    const generations = [resultA?.generation, resultB?.generation].sort();
    expect(generations).toEqual([1, 2]);

    const rows = await dbA.select().from(pluginArtifactGenerations);
    expect(rows.map((row) => row.generation).sort()).toEqual([1, 2]);
    for (const row of rows) {
      const body = await collectObject(provider, row.storageKey);
      expect(sha256Hex(body)).toBe(row.contentHash);
    }
  });

  it("reconcile converges a fresh replica onto the published tree byte-identically", async () => {
    await fs.writeFile(path.join(dirA, "plugin.txt"), "test\n");
    const publisher = makeService(dbA, dirA, "replica-a");
    await publisher.publishSnapshot();

    let applyCount = 0;
    const reconciler = makeService(dbB, dirB, "replica-b", async () => {
      applyCount += 1;
    });

    const result = await reconciler.reconcile();
    expect(result).toEqual({ applied: true, generation: 1 });
    expect(await fs.readFile(path.join(dirB, "plugin.txt"))).toEqual(Buffer.from("test\n"));
    expect(await fs.readFile(path.join(dirB, MARKER), "utf8")).toBe("1");
    expect(applyCount).toBe(1);
    expect(reconciler.isSynced()).toBe(true);
  });

  it("reconcile is idempotent: a second pass at max generation is a no-op", async () => {
    await fs.writeFile(path.join(dirA, "plugin.txt"), "test\n");
    const publisher = makeService(dbA, dirA, "replica-a");
    await publisher.publishSnapshot();

    let applyCount = 0;
    const reconciler = makeService(dbB, dirB, "replica-b", async () => {
      applyCount += 1;
    });

    await reconciler.reconcile();
    const again = await reconciler.reconcile();
    expect(again).toEqual({ applied: false, generation: 1 });
    expect(applyCount).toBe(1);
  });

  it("reconcile rejects a tampered snapshot and leaves the local tree untouched", async () => {
    await fs.writeFile(path.join(dirA, "plugin.txt"), "legit");
    const publisher = makeService(dbA, dirA, "replica-a");
    await publisher.publishSnapshot();

    const garbage = Buffer.from("not a tarball at all");
    await provider.putObject({
      objectKey: "plugin-snapshots/gen-1.tgz",
      body: garbage,
      contentType: "application/gzip",
      contentLength: garbage.length,
    });

    const dirB2 = await mkTmpDir("paperclip-plugins-b2-");
    await fs.writeFile(path.join(dirB2, "canary.txt"), "still here");
    const reconciler = makeService(dbB, dirB2, "replica-b2");

    await expect(reconciler.reconcile()).rejects.toThrow();
    expect(await fs.readFile(path.join(dirB2, "canary.txt"), "utf8")).toBe("still here");
    await expect(fs.access(path.join(dirB2, MARKER))).rejects.toThrow();
    expect(reconciler.isSynced()).toBe(false);
  });

  it("GC after 4 publishes removes generation 1 (row + object) and keeps 2-4", async () => {
    const service = makeService(dbA, dirA, "replica-a");
    for (let i = 1; i <= 4; i += 1) {
      await fs.writeFile(path.join(dirA, "plugin.txt"), `content-${i}`);
      const result = await service.publishSnapshot();
      expect(result).toEqual({ generation: i });
    }

    const rows = await dbA.select().from(pluginArtifactGenerations);
    expect(rows.map((row) => row.generation).sort()).toEqual([2, 3, 4]);

    await expect(provider.getObject({ objectKey: "plugin-snapshots/gen-1.tgz" })).rejects.toThrow();
    for (const generation of [2, 3, 4]) {
      const body = await collectObject(provider, `plugin-snapshots/gen-${generation}.tgz`);
      expect(body.length).toBeGreaterThan(0);
    }
  });

  it("runExclusive converge-before-mutate: a stale replica's wrapped mutation keeps the peer's plugin", async () => {
    // Replica A publishes generation 1 containing plugin file P1.
    await fs.writeFile(path.join(dirA, "p1.txt"), "from-a");
    const serviceA = makeService(dbA, dirA, "replica-a");
    await serviceA.publishSnapshot();

    // Replica B is stale (empty tree, marker 0). Its wrapped mutation must
    // FIRST converge onto generation 1, THEN apply its own change (P2),
    // THEN publish generation 2 — otherwise A's install (P1) is lost.
    const serviceB = makeService(dbB, dirB, "replica-b");
    await serviceB.runExclusive(async () => {
      await serviceB.reconcile();
      await fs.writeFile(path.join(dirB, "p2.txt"), "from-b");
      await serviceB.publishSnapshot();
    });

    // Converge a fresh replica C on generation 2: BOTH plugins present.
    const dirC = await mkTmpDir("paperclip-plugins-c-");
    const serviceC = makeService(dbA, dirC, "replica-c");
    const result = await serviceC.reconcile();
    expect(result).toEqual({ applied: true, generation: 2 });
    expect(await fs.readFile(path.join(dirC, "p1.txt"), "utf8")).toBe("from-a");
    expect(await fs.readFile(path.join(dirC, "p2.txt"), "utf8")).toBe("from-b");
  });

  it("reconcile calls queue behind an in-flight runExclusive section (no swap mid-mutation)", async () => {
    await fs.writeFile(path.join(dirA, "p1.txt"), "from-a");
    const serviceA = makeService(dbA, dirA, "replica-a");
    await serviceA.publishSnapshot();

    const serviceB = makeService(dbB, dirB, "replica-b");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let mutationDone = false;
    const exclusive = serviceB.runExclusive(async () => {
      await gate;
      mutationDone = true;
    });
    const queued = serviceB.reconcile().then((result) => {
      // The externally-queued reconcile must not run until the exclusive
      // section finished — a swap mid-npm-install would tear the tree.
      expect(mutationDone).toBe(true);
      return result;
    });
    release();
    await exclusive;
    await expect(queued).resolves.toEqual({ applied: true, generation: 1 });
  });

  it("reconcile coalesces: calls made while a follow-up pass is queued share that pass", async () => {
    await fs.writeFile(path.join(dirA, "p1.txt"), "from-a");
    const serviceA = makeService(dbA, dirA, "replica-a");
    await serviceA.publishSnapshot();

    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    const slowProvider: StorageProvider = {
      ...provider,
      getObject: async (input) => {
        await downloadGate;
        return provider.getObject(input);
      },
    };
    const service = createPluginArtifactReplication({
      db: dbB,
      provider: slowProvider,
      pluginsDir: dirB,
      replicaId: "replica-b",
      onApplySnapshot: async () => {},
    });

    const first = service.reconcile();
    // Let the first pass start (it blocks inside the download).
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = service.reconcile();
    const third = service.reconcile();
    // Coalesced: both calls share the single queued follow-up pass instead
    // of appending unboundedly to the chain.
    expect(third).toBe(second);
    expect(second).not.toBe(first);

    releaseDownload();
    await expect(first).resolves.toEqual({ applied: true, generation: 1 });
    await expect(second).resolves.toEqual({ applied: false, generation: 1 });
  });

  it("reconcile times out a snapshot download that never completes", async () => {
    await fs.writeFile(path.join(dirA, "p1.txt"), "from-a");
    const serviceA = makeService(dbA, dirA, "replica-a");
    await serviceA.publishSnapshot();

    const stuckProvider: StorageProvider = {
      ...provider,
      getObject: async () => ({ stream: new Readable({ read() {} }) }),
    };
    const service = createPluginArtifactReplication({
      db: dbB,
      provider: stuckProvider,
      pluginsDir: dirB,
      replicaId: "replica-b",
      downloadTimeoutMs: 100,
      onApplySnapshot: async () => {},
    });

    await expect(service.reconcile()).rejects.toThrow(/timed out/i);
    expect(service.isSynced()).toBe(false);
  });

  it("disabled (provider null): every method no-ops", async () => {
    const service = createPluginArtifactReplication({
      db: dbA,
      provider: null,
      pluginsDir: dirA,
      replicaId: "replica-disabled",
      onApplySnapshot: async () => {},
    });

    expect(await service.publishSnapshot()).toBeNull();
    expect(await service.reconcile()).toEqual({ applied: false, generation: null });
    expect(await service.runExclusive(async () => 42)).toBe(42);
    expect(service.isSynced()).toBe(true);
    service.start();
    await service.stop();
  });
});
