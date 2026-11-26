import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySkillRepositorySnapshots as snapshots, createDb, skillPackageDeletions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as storageModule from "../storage/index.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { companySkillService } from "../services/company-skills.js";
import { skillPackageStore } from "../services/skill-package-store.js";
import { skillPackageManifest } from "../services/skill-package-files.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("skill package upload recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let otherDb: ReturnType<typeof createDb>;
  let home: string;
  let storage: storageModule.StorageService;
  const previousHome = process.env.PAPERCLIP_HOME;
  const files = [{ path: "SKILL.md", kind: "skill" as const, content: "---\nname: recovery\ndescription: Test recovery\n---\nTest instructions\n" }];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("skill-package-upload-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    otherDb = createDb(database.connectionString, { maxConnections: 1 });
    home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-package-upload-"));
    process.env.PAPERCLIP_HOME = home;
    storage = createStorageService(createLocalDiskStorageProvider(path.join(home, "objects")));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await Promise.all([db?.$client.end({ timeout: 1 }), otherDb?.$client.end({ timeout: 1 })]);
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Upload recovery", issuePrefix: `P${id.slice(0, 6)}` });
    return id;
  }
  async function pendingUpload(companyId: string, expiresAt: Date) {
    const token = randomUUID();
    const [row] = await db.insert(snapshots).values({ companyId, contentHash: skillPackageManifest(files).contentHash,
      upload: { token, legacy: false, provider: storage.provider, archiveKey: `${companyId}/${token}/files.tar.gz`,
        manifestKey: `${companyId}/${token}/manifest.json`, expiresAt: expiresAt.toISOString() } }).returning();
    return row!;
  }

  it.each([false, true])("joins an upload on another database client and recovers a failed owner: %s", async failed => {
    const companyId = await company();
    let release!: () => void;
    let entered!: () => void;
    let contended!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const uploading = new Promise<void>(resolve => { entered = resolve; });
    const contention = new Promise<void>(resolve => { contended = resolve; });
    const put = storage.putFile.bind(storage);
    const puts = vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      entered();
      await blocked;
      if (failed) throw new Error("upload disconnected");
      return put(input);
    });
    const debug = otherDb.$client.options.debug;
    otherDb.$client.options.debug = (_connection, query) => {
      if (query.includes('update "company_skill_repository_snapshots" set "upload"')) contended();
    };
    const owner = skillPackageStore(db, storage).prepare(companyId, files).catch(error => error as Error);
    let joined: Promise<string | Error> | undefined;
    const cancellation = new AbortController();
    const timeout = setTimeout(() => cancellation.abort(new Error("Upload join did not settle")), 5_000);
    try {
      await uploading;
      joined = skillPackageStore(otherDb, storage).prepare(companyId, files, false, cancellation.signal).catch(error => error as Error);
      await contention;
      release();
      const [first, second] = await Promise.all([owner, joined]);
      expect(second).toEqual(expect.any(String));
      if (failed) expect(first).toEqual(new Error("upload disconnected"));
      else expect(second).toBe(first);
      expect(puts).toHaveBeenCalledTimes(failed ? 3 : 2);
      const rows = await db.select().from(snapshots).where(eq(snapshots.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(second);
      expect(rows[0]!.upload).toBeNull();
      expect(await skillPackageStore(db, storage).verifyDurable(companyId, rows[0]!.id)).toBe(true);
      const retired = await db.select().from(skillPackageDeletions).where(eq(skillPackageDeletions.companyId, companyId));
      expect(retired).toHaveLength(failed ? 1 : 0);
      if (failed) expect(retired[0]!.archiveKey).not.toBe(rows[0]!.storage!.archiveKey);
    } finally {
      clearTimeout(timeout);
      cancellation.abort();
      release();
      await Promise.allSettled([owner, joined]);
      otherDb.$client.options.debug = debug;
    }
  });

  it("retries the first agent's bundled skill initialization immediately after a storage failure", async () => {
    const companyId = await company();
    vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
    vi.spyOn(storage, "putFile").mockRejectedValueOnce(new Error("upload disconnected"));
    const skills = companySkillService(db);
    const requested = ["paperclipai/paperclip/paperclip-create-agent", "paperclipai/paperclip/first-task"];
    await expect(skills.resolveRequestedSkillEntries(companyId, requested)).rejects.toThrow("upload disconnected");
    const result = await skills.resolveRequestedSkillEntries(companyId, requested);
    expect(result.unresolved).toEqual([]);
    expect(result.resolved.map(entry => entry.key)).toEqual(requested);
  });

  it("reclaims an expired crash lease with fresh keys", async () => {
    const companyId = await company();
    const pending = await pendingUpload(companyId, new Date(0));
    const id = await skillPackageStore(db, storage).prepare(companyId, files);
    expect(id).toBe(pending.id);
    const [saved] = await db.select().from(snapshots).where(eq(snapshots.id, id));
    expect(saved!.upload).toBeNull();
    expect(saved!.storage!.archiveKey).not.toBe(pending.upload!.archiveKey);
    const [retired] = await db.select().from(skillPackageDeletions).where(eq(skillPackageDeletions.companyId, companyId));
    expect(retired!.archiveKey).toBe(pending.upload!.archiveKey);
  });

  it("cancels a waiting caller without expiring another owner's active lease", async () => {
    const companyId = await company();
    const pending = await pendingUpload(companyId, new Date("2099-01-01"));
    const puts = vi.spyOn(storage, "putFile");
    const cancellation = new AbortController();
    let contended!: () => void;
    const contention = new Promise<void>(resolve => { contended = resolve; });
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => {
      if (query.includes('update "company_skill_repository_snapshots" set "upload"')) contended();
    };
    const preparing = skillPackageStore(db, storage).prepare(companyId, files, false, cancellation.signal).catch(error => error);
    try {
      await contention;
      cancellation.abort(new Error("Caller left onboarding"));
      expect(await preparing).toEqual(new Error("Caller left onboarding"));
      const [saved] = await db.select().from(snapshots).where(eq(snapshots.id, pending.id));
      expect(saved!.upload).toEqual(pending.upload);
      expect(puts).not.toHaveBeenCalled();
    } finally { cancellation.abort(); await preparing; db.$client.options.debug = debug; }
  });

  it.each([false, true])("preserves a possibly published receipt after a lost commit reply: committed=%s", async committed => {
    const companyId = await company();
    let transactionCount = 0;
    const ambiguousDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") return async (...args: Parameters<typeof db.transaction>) => {
          const publishing = ++transactionCount === 2;
          const result = await target.transaction(async tx => {
            const value = await args[0](tx);
            if (publishing && !committed) throw new Error("Lost commit reply");
            return value;
          }, args[1]);
          if (publishing) throw new Error("Lost commit reply");
          return result;
        };
        return Reflect.get(target, property, receiver);
      },
    });
    const puts = vi.spyOn(storage, "putFile");
    await expect(skillPackageStore(ambiguousDb, storage).prepare(companyId, files)).rejects.toThrow("Lost commit reply");
    const [beforeRetry] = await db.select().from(snapshots).where(eq(snapshots.companyId, companyId));
    expect(Boolean(beforeRetry!.storage)).toBe(committed);
    const store = skillPackageStore(db, storage);
    expect(await store.prepare(companyId, files)).toBe(beforeRetry!.id);
    expect(puts).toHaveBeenCalledTimes(committed ? 2 : 4);
    expect(await store.verifyDurable(companyId, beforeRetry!.id)).toBe(true);
    const retired = await db.select().from(skillPackageDeletions).where(eq(skillPackageDeletions.companyId, companyId));
    expect(retired).toHaveLength(committed ? 0 : 1);
  });

  it("does not expire a newer owner's claim after the old upload fails", async () => {
    const companyId = await company();
    const replacement = { token: randomUUID(), legacy: false, provider: storage.provider, archiveKey: `${companyId}/replacement/files.tar.gz`,
      manifestKey: `${companyId}/replacement/manifest.json`, expiresAt: new Date("2099-01-01").toISOString() };
    vi.spyOn(storage, "putFile").mockImplementationOnce(async () => {
      await db.update(snapshots).set({ upload: replacement }).where(eq(snapshots.companyId, companyId));
      throw new Error("Old owner disconnected");
    });
    await expect(skillPackageStore(db, storage).prepare(companyId, files)).rejects.toThrow("Old owner disconnected");
    const [saved] = await db.select().from(snapshots).where(eq(snapshots.companyId, companyId));
    expect(saved!.upload).toEqual(replacement);
  });

  it.each([false, true])("bounds failed-upload cleanup behind a busy pool and rejects late writes: cancellation=%s", async cancelled => {
    const companyId = await company();
    const failure = new Error(cancelled ? "Upload cancelled" : "Upload failed");
    const cancellation = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const occupied = new Promise<void>(resolve => { entered = resolve; });
    let holding: Promise<void> | undefined;
    vi.spyOn(storage, "putFile").mockImplementationOnce(async () => {
      holding = db.transaction(async tx => {
        await tx.execute(sql`select 1`);
        entered();
        await blocked;
      });
      await occupied;
      if (cancelled) cancellation.abort(failure);
      throw failure;
    });
    const preparing = skillPackageStore(db, storage).prepare(companyId, files, false, cancellation.signal).catch(error => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: typeof snapshots.$inferSelect | undefined;
    try {
      await occupied;
      [pending] = await otherDb.select().from(snapshots).where(eq(snapshots.companyId, companyId));
      const result = await Promise.race([preparing, new Promise<Error>(resolve => {
        timer = setTimeout(() => resolve(new Error("Cleanup held the caller behind the pool")), 3_000);
      })]);
      expect(result).toBe(failure);
    } finally {
      clearTimeout(timer);
      release();
      await holding;
      await preparing;
    }
    await db.execute(sql`select 1`);
    const [saved] = await db.select().from(snapshots).where(eq(snapshots.companyId, companyId));
    expect(saved!.upload).toEqual(pending!.upload);
  });

  it("cancels blocked cleanup SQL so the pool remains usable while the row is locked", async () => {
    const companyId = await company();
    const failure = new Error("Upload failed before locked cleanup");
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let holding: Promise<void> | undefined;
    let pending: typeof snapshots.$inferSelect | undefined;
    vi.spyOn(storage, "putFile").mockImplementationOnce(async () => {
      let entered!: () => void;
      const locked = new Promise<void>(resolve => { entered = resolve; });
      holding = otherDb.transaction(async tx => {
        [pending] = await tx.select().from(snapshots).where(eq(snapshots.companyId, companyId)).for("update");
        entered();
        await blocked;
      });
      await locked;
      throw failure;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const preparing = skillPackageStore(db, storage).prepare(companyId, files).catch(error => error);
    try {
      const checked = (async () => {
        expect(await preparing).toBe(failure);
        await db.execute(sql`select 1`);
        const [saved] = await db.select().from(snapshots).where(eq(snapshots.companyId, companyId));
        expect(saved!.upload).toEqual(pending!.upload);
        return true;
      })();
      expect(await Promise.race([checked, new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 3_000);
      })])).toBe(true);
    } finally {
      clearTimeout(timer);
      release();
      await holding;
      await preparing;
    }
  });
});
