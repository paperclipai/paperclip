import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

/**
 * Minimal ustar archive builder for hostile-entry tests: system tar strips
 * `../` from member names (and refuses hostile link targets) on create, so
 * the header bytes are forged by hand. `typeflag` "0" = regular file,
 * "1" = hardlink, "2" = symlink; link members carry `linkTarget` and no body.
 */
function buildTarball(
  entries: Array<{
    name: string;
    content?: string;
    typeflag?: "0" | "1" | "2";
    linkTarget?: string;
  }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, content = "", typeflag = "0", linkTarget } of entries) {
    const body = typeflag === "0" ? Buffer.from(content) : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100); // mode
    header.write("0000000\0", 108); // uid
    header.write("0000000\0", 116); // gid
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124); // size
    header.write("00000000000\0", 136); // mtime
    header.write("        ", 148); // chksum field is spaces while summing
    header.write(typeflag, 156); // typeflag
    if (linkTarget) header.write(linkTarget, 157, 100, "utf8"); // linkname
    header.write("ustar\0", 257); // magic
    header.write("00", 263); // version
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body);
    const pad = body.length % 512;
    if (pad) blocks.push(Buffer.alloc(512 - pad));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return Buffer.concat(blocks);
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

  it("reconcile rejects a snapshot tarball containing a path-traversal entry without extracting it", async () => {
    // Attacker model: object-storage AND ledger write access — the row's
    // contentHash matches the hostile object, so the integrity check alone
    // cannot catch it; only the entry-path validation can.
    const escapeName = `../escape-canary-${Date.now()}.txt`;
    const evilTar = gzipSync(
      buildTarball([
        { name: "./legit.txt", content: "legit" },
        { name: escapeName, content: "pwned" },
      ]),
    );
    await provider.putObject({
      objectKey: "plugin-snapshots/gen-1.tgz",
      body: evilTar,
      contentType: "application/gzip",
      contentLength: evilTar.length,
    });
    await dbA.insert(pluginArtifactGenerations).values({
      generation: 1,
      storageKey: "plugin-snapshots/gen-1.tgz",
      contentHash: sha256Hex(evilTar),
      createdBy: "attacker",
    });

    await fs.writeFile(path.join(dirB, "canary.txt"), "still here");
    const reconciler = makeService(dbB, dirB, "replica-b");

    await expect(reconciler.reconcile()).rejects.toThrow(/unsafe entry path/);

    // Nothing escaped the extraction dir (its parent would have received the file).
    await expect(fs.access(path.resolve(`${dirB}.tmp-1`, escapeName))).rejects.toThrow();
    // Local tree untouched, marker absent, replica not marked synced.
    expect(await fs.readFile(path.join(dirB, "canary.txt"), "utf8")).toBe("still here");
    await expect(fs.access(path.join(dirB, MARKER))).rejects.toThrow();
    expect(reconciler.isSynced()).toBe(false);
  });

  /** Stage a forged, hash-consistent snapshot as generation 1. */
  async function stageForgedSnapshot(tarball: Buffer): Promise<void> {
    const evilTar = gzipSync(tarball);
    await provider.putObject({
      objectKey: "plugin-snapshots/gen-1.tgz",
      body: evilTar,
      contentType: "application/gzip",
      contentLength: evilTar.length,
    });
    await dbA.insert(pluginArtifactGenerations).values({
      generation: 1,
      storageKey: "plugin-snapshots/gen-1.tgz",
      contentHash: sha256Hex(evilTar),
      createdBy: "attacker",
    });
  }

  it("reconcile rejects a snapshot tarball containing a symlink whose relative target escapes the plugin tree", async () => {
    // Entry paths are all clean — only the symlink TARGET points outside the
    // extraction root, which the name-only scan cannot see.
    await stageForgedSnapshot(
      buildTarball([
        { name: "./legit.txt", content: "legit" },
        { name: "./evil-link", typeflag: "2", linkTarget: "../../outside-canary" },
      ]),
    );
    await fs.writeFile(path.join(dirB, "canary.txt"), "still here");
    const reconciler = makeService(dbB, dirB, "replica-b");

    await expect(reconciler.reconcile()).rejects.toThrow(/symlink escaping the plugin tree/);

    // Local tree untouched, marker absent, replica not marked synced.
    await expect(fs.access(path.resolve(`${dirB}.tmp-1`, "evil-link"))).rejects.toThrow();
    expect(await fs.readFile(path.join(dirB, "canary.txt"), "utf8")).toBe("still here");
    await expect(fs.access(path.join(dirB, MARKER))).rejects.toThrow();
    expect(reconciler.isSynced()).toBe(false);
  });

  it("reconcile rejects a snapshot tarball containing a symlink with an absolute target", async () => {
    await stageForgedSnapshot(
      buildTarball([
        { name: "./evil-abs-link", typeflag: "2", linkTarget: "/etc/passwd" },
      ]),
    );
    const reconciler = makeService(dbB, dirB, "replica-b");

    await expect(reconciler.reconcile()).rejects.toThrow(/symlink escaping the plugin tree/);
    expect(reconciler.isSynced()).toBe(false);
  });

  it("reconcile rejects a snapshot tarball containing a hardlink with a traversal target", async () => {
    await stageForgedSnapshot(
      buildTarball([
        { name: "./evil-hardlink", typeflag: "1", linkTarget: "../outside-file" },
      ]),
    );
    const reconciler = makeService(dbB, dirB, "replica-b");

    await expect(reconciler.reconcile()).rejects.toThrow(/hardlink with unsafe target/);
    expect(reconciler.isSynced()).toBe(false);
  });

  it("reconcile accepts and preserves a legitimate relative in-tree symlink (npm .bin style)", async () => {
    // Real npm trees link node_modules/.bin/<tool> -> ../<pkg>/bin/<tool>.js;
    // the relative `..` stays inside the tree and must survive the round trip.
    await fs.mkdir(path.join(dirA, "node_modules", ".bin"), { recursive: true });
    await fs.mkdir(path.join(dirA, "node_modules", "pkg", "bin"), { recursive: true });
    await fs.writeFile(path.join(dirA, "node_modules", "pkg", "bin", "tool.js"), "#!/usr/bin/env node\n");
    await fs.symlink("../pkg/bin/tool.js", path.join(dirA, "node_modules", ".bin", "tool"));
    const publisher = makeService(dbA, dirA, "replica-a");
    await publisher.publishSnapshot();

    const reconciler = makeService(dbB, dirB, "replica-b");
    const result = await reconciler.reconcile();

    expect(result).toEqual({ applied: true, generation: 1 });
    expect(await fs.readlink(path.join(dirB, "node_modules", ".bin", "tool"))).toBe("../pkg/bin/tool.js");
    expect(await fs.readFile(path.join(dirB, "node_modules", ".bin", "tool"), "utf8")).toBe(
      "#!/usr/bin/env node\n",
    );
    expect(reconciler.isSynced()).toBe(true);
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

  it("reports synced on an empty ledger (fresh cluster; MUST_SYNC must not deadlock)", async () => {
    const svc = makeService(dbA, dirA, "replica-fresh");
    const result = await svc.reconcile();
    expect(result).toEqual({ applied: false, generation: null });
    expect(svc.isSynced()).toBe(true);
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

  // -------------------------------------------------------------------------
  // Fix 1: GC ordering — row-first, then objects
  // -------------------------------------------------------------------------

  it("GC: deleteObject failure does not fail publish and does not leave rows behind", async () => {
    // Track deleteObject calls and make the first one throw.
    let deleteCallCount = 0;
    const faultyProvider: StorageProvider = {
      ...provider,
      deleteObject: async (input) => {
        deleteCallCount += 1;
        if (deleteCallCount === 1) {
          throw new Error("storage unavailable (stubbed)");
        }
        return provider.deleteObject(input);
      },
    };
    const service = createPluginArtifactReplication({
      db: dbA,
      provider: faultyProvider,
      pluginsDir: dirA,
      replicaId: "replica-a",
      onApplySnapshot: async () => {},
    });

    // Publish 4 generations so GC triggers (cutoff = gen 1).
    for (let i = 1; i <= 4; i += 1) {
      await fs.writeFile(path.join(dirA, "plugin.txt"), `content-${i}`);
      const result = await service.publishSnapshot();
      // publish must succeed even though deleteObject threw on the first call
      expect(result).toEqual({ generation: i });
    }

    // Row for generation 1 must be gone (row-first ordering means rows are
    // deleted before objects, so even with a failing deleteObject the row is pruned).
    const gen1Rows = await dbA
      .select()
      .from(pluginArtifactGenerations)
      .where(eq(pluginArtifactGenerations.generation, 1));
    expect(gen1Rows).toHaveLength(0);

    // Rows for generations 2-4 must still be present.
    const remaining = await dbA.select().from(pluginArtifactGenerations);
    expect(remaining.map((r) => r.generation).sort()).toEqual([2, 3, 4]);
  });

  // -------------------------------------------------------------------------
  // Fix 2: CAS-collision orphans
  // -------------------------------------------------------------------------

  it("CAS collision: lost-race object is deleted after publish succeeds, winning object exists", async () => {
    const deletedKeys: string[] = [];
    const wrappedProvider: StorageProvider = {
      ...provider,
      deleteObject: async (input) => {
        deletedKeys.push(input.objectKey);
        return provider.deleteObject(input);
      },
    };

    await fs.writeFile(path.join(dirA, "plugin.txt"), "hello");

    // We need the first CAS insert attempt (gen-1) to collide deterministically.
    // Intercept putObject: on the first call (which uploads gen-1), secretly
    // insert a gen-1 row into the DB so the subsequent db.insert hits a unique
    // violation, simulating a concurrent writer winning the race.
    let putCount = 0;
    const collidingProvider: StorageProvider = {
      ...wrappedProvider,
      putObject: async (input) => {
        putCount += 1;
        const result = await wrappedProvider.putObject(input);
        if (putCount === 1) {
          // Inject gen-1 row after the object is uploaded — this makes the
          // db.insert below hit a unique violation (lost CAS race).
          await dbA.insert(pluginArtifactGenerations).values({
            generation: 1,
            storageKey: input.objectKey,
            contentHash: "aaaa",
            createdBy: "injected-winner",
          });
        }
        return result;
      },
    };

    const service = createPluginArtifactReplication({
      db: dbA,
      provider: collidingProvider,
      pluginsDir: dirA,
      replicaId: "replica-a",
      onApplySnapshot: async () => {},
    });

    // First CAS attempt: uploads gen-1 object, then row insert collides.
    // Second attempt: reads gen-1 as maxRow, tries gen-2, succeeds.
    const result = await service.publishSnapshot();
    expect(result).toEqual({ generation: 2 });

    // Winning generation's object must exist.
    const winningBody = await collectObject(wrappedProvider, "plugin-snapshots/gen-2.tgz");
    expect(winningBody.length).toBeGreaterThan(0);

    // The orphaned gen-1 object (uploaded by the losing CAS attempt) must have
    // been deleted during the best-effort cleanup after winning gen-2.
    expect(deletedKeys).toContain("plugin-snapshots/gen-1.tgz");
  });

  it("CAS exhaustion: publishSnapshot rejects AND every orphaned object is cleaned up", async () => {
    const deletedKeys: string[] = [];
    const uploadedKeys: string[] = [];

    await fs.writeFile(path.join(dirA, "plugin.txt"), "hello");

    // Make EVERY CAS attempt lose: after each upload of gen-N, inject a gen-N
    // row so the subsequent db.insert always hits a unique violation. The
    // publisher must exhaust its attempts, throw, and still delete every
    // orphaned object — they were never inserted into the ledger, so GC has
    // no other way to reach them.
    const alwaysCollidingProvider: StorageProvider = {
      ...provider,
      putObject: async (input) => {
        const result = await provider.putObject(input);
        uploadedKeys.push(input.objectKey);
        const generation = Number(/gen-(\d+)\.tgz$/.exec(input.objectKey)![1]);
        await dbA.insert(pluginArtifactGenerations).values({
          generation,
          storageKey: input.objectKey,
          contentHash: "aaaa",
          createdBy: "injected-winner",
        });
        return result;
      },
      deleteObject: async (input) => {
        deletedKeys.push(input.objectKey);
        return provider.deleteObject(input);
      },
    };

    const service = createPluginArtifactReplication({
      db: dbA,
      provider: alwaysCollidingProvider,
      pluginsDir: dirA,
      replicaId: "replica-a",
      onApplySnapshot: async () => {},
    });

    await expect(service.publishSnapshot()).rejects.toThrow(/CAS attempts \(generation contention\)/);

    // Every uploaded object lost its race, so every one must have been deleted.
    expect(uploadedKeys.length).toBeGreaterThan(0);
    expect(deletedKeys.slice().sort()).toEqual(uploadedKeys.slice().sort());
    // And nothing remains in the store.
    for (const key of uploadedKeys) {
      await expect(collectObject(provider, key)).rejects.toThrow();
    }
  });

  // -------------------------------------------------------------------------
  // Fix 3: swap restoration on rename(2) failure
  // -------------------------------------------------------------------------

  it("swap: rename(2) failure triggers restore of old tree and rethrows original error", async () => {
    await fs.writeFile(path.join(dirA, "publisher.txt"), "source");
    const publisher = makeService(dbA, dirA, "replica-a");
    await publisher.publishSnapshot();

    // Seed dirB with a canary file so we can verify it is restored.
    await fs.writeFile(path.join(dirB, "canary.txt"), "original contents");

    const rename2Error = new Error("rename(2) injected failure");
    let renameCallCount = 0;
    // Injectable rename: first call (pluginsDir→oldDir) succeeds; second call
    // (extractDir→pluginsDir) throws.
    const faultyRename = async (src: string, dst: string): Promise<void> => {
      renameCallCount += 1;
      if (renameCallCount === 2) {
        throw rename2Error;
      }
      return fs.rename(src, dst);
    };

    const reconciler = createPluginArtifactReplication({
      db: dbB,
      provider,
      pluginsDir: dirB,
      replicaId: "replica-b",
      renameFn: faultyRename,
      onApplySnapshot: async () => {},
    });

    // reconcile must reject with the original rename(2) error.
    await expect(reconciler.reconcile()).rejects.toThrow(rename2Error.message);

    // After restoration, dirB must still contain the canary file.
    expect(await fs.readFile(path.join(dirB, "canary.txt"), "utf8")).toBe("original contents");
  });
});
