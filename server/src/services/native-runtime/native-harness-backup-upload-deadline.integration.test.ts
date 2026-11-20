import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { nativeHarnessBackups, nativeRunFinalizations } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { recordStorageRequest } from "../../storage/request-stats.js";
import type { StorageService } from "../../storage/types.js";
import { nativeHarnessBackupOwner, persistNativeHarnessBackup, restoreDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";

/** A store that takes one upload chunk every `delayMs`, optionally no more after `stallAfter` chunks. */
function throttledUploads(storage: StorageService, delayMs: number, stallAfter?: number) {
  let taken = 0;
  const writes: string[] = [];
  const throttled = new Proxy(storage, { get(target, property) {
    if (property !== "putFile") {
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
    return async (input: Parameters<StorageService["putFile"]>[0]) => {
      writes.push(input.objectKey ?? "");
      if (!(input.body instanceof Readable)) return target.putFile(input);
      const body = input.body, signal = input.signal;
      async function* slow() {
        for await (const part of body as AsyncIterable<Buffer>) {
          if (stallAfter !== undefined && taken >= stallAfter) {
            await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
            signal?.throwIfAborted();
          }
          await new Promise(resolve => setTimeout(resolve, delayMs));
          signal?.throwIfAborted();
          taken++;
          yield part;
        }
      }
      return target.putFile({ ...input, body: Readable.from(slow()) } as typeof input);
    };
  } });
  return { storage: throttled, writes };
}

/**
 * A store that, like S3 with a file source, never reads the stream body: it
 * sends `requests` requests of `delayMs` each, recording each answer as the S3
 * provider does, then stores the file. With `stallAfter`, a request never ends.
 */
function fileSourceUploads(storage: StorageService, requests: number, delayMs: number, stallAfter?: number) {
  return new Proxy(storage, { get(target, property) {
    if (property !== "putFile") {
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
    return async (input: Parameters<StorageService["putFile"]>[0]) => {
      if (!("sourceFile" in input) || !input.sourceFile) throw new Error("expected a file source");
      if (input.body instanceof Readable) input.body.destroy();
      for (let sent = 0; sent < requests; sent++) {
        if (stallAfter !== undefined && sent >= stallAfter) {
          await new Promise<void>(resolve => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
        input.signal?.throwIfAborted();
        recordStorageRequest({ $metadata: { attempts: 1 } }, false);
      }
      const { body: _stream, byteSize: _size, sha256: _sha, sourceFile, ...rest } = input;
      return target.putFile({ ...rest, body: await readFile(sourceFile) });
    };
  } });
}

describeEmbeddedPostgres("durable native backup upload deadlines", () => {
  const environment = nativeRestartFixture();
  const ownedHomes: string[] = [];
  afterEach(async () => {
    for (const home of ownedHomes.splice(0)) await removeNativeHarnessBackup(home);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  /** A backup large enough that its upload is many store-sized chunks. */
  async function fixture() {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "52".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, runtimeRoot, successor } = environment.current;
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
      leaseOwner: "backup-writer", leaseExpiresAt: new Date(Date.now() + 120_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const owner = await nativeHarnessBackupOwner(f.db, { companyId, issueId: f.issueId, runId: f.runId, bootId: successor.bootId });
    const home = join(runtimeRoot, randomUUID()), root = join(home, "pending");
    ownedHomes.push(home);
    await mkdir(join(root, "acpx", "sessions"), { recursive: true });
    const identity = { normalizedSessionId: randomUUID(), providerSessionId: randomUUID(), provider: "acpx" };
    // Incompressible bytes, so the encrypted object spans many file-stream chunks.
    await writeFile(join(root, "acpx", "sessions", "history.json"),
      JSON.stringify({ ...identity, turns: randomBytes(768 * 1024).toString("base64") }));
    await writeFile(join(root, "manifest.json"),
      JSON.stringify({ schema: "paperclip.native-harness-backup.v1", ...identity, directories: ["acpx"] }), { mode: 0o600 });
    const scopeDigest = createHash("sha256").update(randomUUID()).digest("hex");
    const storage = createStorageService(createLocalDiskStorageProvider(join(runtimeRoot, "durable-objects")));
    const current = async () => f.db.select().from(nativeHarnessBackups).where(and(
      eq(nativeHarnessBackups.scopeDigest, scopeDigest), eq(nativeHarnessBackups.status, "current")));
    return { db: f.db, companyId, owner, root, scopeDigest, storage, identity, current };
  }
  function replacementRoot() {
    const root = join(environment.current.runtimeRoot, randomUUID(), "failover-backups");
    ownedHomes.push(root);
    return root;
  }

  it("keeps saving a backup whose upload outlasts the idle window while the store keeps taking bytes", async () => {
    const f = await fixture(), idle = 200, slow = throttledUploads(f.storage, 40);
    // The former fixed total deadline aborted this same progressing upload with
    // the generic "The operation was aborted" seen after accepted staging turns.
    await expect(persistNativeHarnessBackup({ ...f, storage: slow.storage, signal: AbortSignal.timeout(idle) }))
      .rejects.toThrow("The operation was aborted");
    expect(await f.current()).toHaveLength(0);
    const startedAt = Date.now();
    slow.writes.splice(0);
    await persistNativeHarnessBackup({ ...f, storage: slow.storage, transferIdleTimeoutMs: idle });
    expect(Date.now() - startedAt).toBeGreaterThan(idle * 2);
    expect(slow.writes.some(key => key.includes("/native-harness-backups/"))).toBe(true);
    expect(await f.current()).toHaveLength(1);
    const restored = replacementRoot();
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: restored })).toBe(true);
    expect(JSON.parse(await readFile(join(restored, "current/acpx/sessions/history.json"), "utf8"))).toMatchObject(f.identity);
  });

  it("names an upload that stops taking bytes and publishes no backup", { timeout: 10_000 }, async () => {
    const f = await fixture();
    await expect(persistNativeHarnessBackup({ ...f, storage: throttledUploads(f.storage, 5, 2).storage,
      transferIdleTimeoutMs: 250 })).rejects.toThrow("native_harness_storage_upload_stalled");
    expect(await f.current()).toHaveLength(0);
    // The local source is untouched and saves once the store responds again.
    await persistNativeHarnessBackup({ ...f, transferIdleTimeoutMs: 250 });
    expect(await f.current()).toHaveLength(1);
  });

  it("keeps a file-source upload going while the store answers its requests, and names one that stops", { timeout: 10_000 }, async () => {
    const f = await fixture(), idle = 200;
    // Ten requests of 60 ms each: longer than the idle window in total, but each answer renews it.
    const startedAt = Date.now();
    await persistNativeHarnessBackup({ ...f, storage: fileSourceUploads(f.storage, 10, 60), transferIdleTimeoutMs: idle });
    expect(Date.now() - startedAt).toBeGreaterThan(idle * 2);
    expect(await f.current()).toHaveLength(1);
    await expect(persistNativeHarnessBackup({ ...f, storage: fileSourceUploads(f.storage, 10, 20, 3),
      transferIdleTimeoutMs: idle })).rejects.toThrow("native_harness_storage_upload_stalled");
  });

  it("names a read-back that stops sending bytes and publishes no backup", { timeout: 10_000 }, async () => {
    const f = await fixture();
    const stalledReads = new Proxy(f.storage, { get(target, property) {
      if (property === "getObject") return async (companyId: string, objectKey: string, options?: { signal?: AbortSignal }) => {
        const object = await target.getObject(companyId, objectKey, options);
        object.stream.destroy();
        return { ...object, stream: Readable.from((async function* () {
          await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
          options?.signal?.throwIfAborted();
        })()) };
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    await expect(persistNativeHarnessBackup({ ...f, storage: stalledReads, transferIdleTimeoutMs: 250 }))
      .rejects.toThrow("native_harness_storage_download_stalled");
    expect(await f.current()).toHaveLength(0);
  });

  it("stops at the outer bound while an upload still progresses", async () => {
    const f = await fixture();
    await expect(persistNativeHarnessBackup({ ...f, storage: throttledUploads(f.storage, 40).storage,
      transferIdleTimeoutMs: 5_000, persistMaxMs: 150 })).rejects.toThrow("native_harness_storage_persist_deadline_exceeded");
    expect(await f.current()).toHaveLength(0);
  });

  it("lets Stop end a progressing upload with its own reason", async () => {
    const f = await fixture(), stop = new AbortController();
    setTimeout(() => stop.abort(new Error("caller_stopped")), 80);
    const failure = await persistNativeHarnessBackup({ ...f, storage: throttledUploads(f.storage, 40).storage,
      signal: stop.signal, transferIdleTimeoutMs: 5_000 }).then(() => null, (error: unknown) => error);
    const reason = failure as Error & { cause?: unknown };
    expect(failure).toBeInstanceOf(Error);
    expect([reason.message, (reason.cause as Error | undefined)?.message]).toContain("caller_stopped");
    expect(await f.current()).toHaveLength(0);
    await expect(stat(f.root)).resolves.toBeTruthy();
  });
});
