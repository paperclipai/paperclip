import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { nativeHarnessBackups, nativeRunFinalizations } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import type { StorageService } from "../../storage/types.js";
import { nativeHarnessBackupOwner, persistNativeHarnessBackup, restoreDurableNativeHarnessBackup,
  verifyDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";

/** Durable reads that deliver `chunkBytes` every `delayMs`, optionally stopping after `stallAfter` chunks. */
function throttledStorage(storage: StorageService, delayMs: number, chunkBytes: number, stallAfter?: number): StorageService {
  let sent = 0;
  return new Proxy(storage, { get(target, property) {
    if (property !== "getObject") {
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
    return async (companyId: string, objectKey: string, options?: { signal?: AbortSignal }) => {
      const object = await target.getObject(companyId, objectKey, options);
      async function* slow() {
        for await (const part of object.stream as AsyncIterable<Buffer>) {
          for (let offset = 0; offset < part.length; offset += chunkBytes) {
            if (stallAfter !== undefined && sent >= stallAfter) {
              await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
              options?.signal?.throwIfAborted();
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
            options?.signal?.throwIfAborted();
            sent++;
            yield part.subarray(offset, offset + chunkBytes);
          }
        }
      }
      return { ...object, stream: Readable.from(slow()) };
    };
  } });
}

describeEmbeddedPostgres("durable native backup download deadlines", () => {
  const environment = nativeRestartFixture();
  const ownedHomes: string[] = [];
  afterEach(async () => {
    for (const home of ownedHomes.splice(0)) await removeNativeHarnessBackup(home);
    vi.unstubAllEnvs();
  });
  async function fixture() {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, runtimeRoot, successor } = environment.current;
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
      leaseOwner: "backup-writer", leaseExpiresAt: new Date(Date.now() + 120_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const owner = await nativeHarnessBackupOwner(f.db, { companyId, issueId: f.issueId, runId: f.runId, bootId: successor.bootId });
    const home = join(runtimeRoot, randomUUID()), root = join(home, "failover-backups", "current");
    ownedHomes.push(home);
    await mkdir(join(root, "opencode", "sessions"), { recursive: true });
    const identity = { normalizedSessionId: randomUUID(), providerSessionId: randomUUID(), provider: "opencode" };
    // Enough bytes for many throttled chunks, so a restore outlasts the idle window.
    await writeFile(join(root, "opencode", "sessions", "history.json"), JSON.stringify({ ...identity, turns: "x".repeat(4096) }));
    const manifest = JSON.stringify({ schema: "paperclip.native-harness-backup.v1", ...identity, directories: ["opencode"] });
    await writeFile(join(root, "manifest.json"), manifest, { mode: 0o600 });
    const scopeDigest = createHash("sha256").update(randomUUID()).digest("hex");
    const storage = createStorageService(createLocalDiskStorageProvider(join(runtimeRoot, "durable-objects")));
    await persistNativeHarnessBackup({ db: f.db, root, owner, scopeDigest, storage });
    const [row] = await f.db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.scopeDigest, scopeDigest),
      eq(nativeHarnessBackups.status, "current")));
    return { db: f.db, companyId, scopeDigest, storage, identity, manifestSha256: row.manifestSha256 };
  }
  function replacementRoot() {
    const root = join(environment.current.runtimeRoot, randomUUID(), "failover-backups");
    ownedHomes.push(root);
    return root;
  }

  it("keeps restoring a backup whose download outlasts the idle window while bytes keep arriving", async () => {
    const f = await fixture(), idle = 250, slow = throttledStorage(f.storage, 15, 64);
    // The former total deadline aborted this same progressing transfer with
    // the generic "The operation was aborted" seen on resumed sessions.
    const aborted = replacementRoot();
    await expect(restoreDurableNativeHarnessBackup({ ...f, storage: slow, backupRoot: aborted, signal: AbortSignal.timeout(idle) }))
      .rejects.toThrow("The operation was aborted");
    await expect(stat(join(aborted, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    const replacement = replacementRoot(), startedAt = Date.now();
    expect(await restoreDurableNativeHarnessBackup({ ...f, storage: slow, backupRoot: replacement, downloadIdleTimeoutMs: idle })).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThan(idle * 2);
    expect(JSON.parse(await readFile(join(replacement, "current/opencode/sessions/history.json"), "utf8")))
      .toMatchObject(f.identity);
    expect(await verifyDurableNativeHarnessBackup({ ...f, storage: slow, downloadIdleTimeoutMs: idle })).toBe(true);
  });

  it("names a download that stops sending bytes and publishes no partial backup", { timeout: 10_000 }, async () => {
    const f = await fixture(), replacement = replacementRoot();
    await expect(restoreDurableNativeHarnessBackup({ ...f, storage: throttledStorage(f.storage, 5, 64, 3), backupRoot: replacement,
      downloadIdleTimeoutMs: 250 })).rejects.toThrow("native_harness_storage_download_stalled");
    await expect(stat(join(replacement, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(verifyDurableNativeHarnessBackup({ ...f, storage: throttledStorage(f.storage, 5, 64, 3), downloadIdleTimeoutMs: 250 }))
      .rejects.toThrow("native_harness_storage_download_stalled");
    // The saved backup is untouched and restores once the store responds again.
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement, downloadIdleTimeoutMs: 250 })).toBe(true);
  });

  it("lets Stop end a progressing download with its own reason", async () => {
    const f = await fixture(), replacement = replacementRoot(), stop = new AbortController();
    setTimeout(() => stop.abort(new Error("caller_stopped")), 50);
    const failure = await restoreDurableNativeHarnessBackup({ ...f, storage: throttledStorage(f.storage, 15, 64), backupRoot: replacement,
      signal: stop.signal, downloadIdleTimeoutMs: 5_000 }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const reason = failure as Error & { cause?: unknown };
    expect([reason.message, (reason.cause as Error | undefined)?.message]).toContain("caller_stopped");
    await expect(stat(join(replacement, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
