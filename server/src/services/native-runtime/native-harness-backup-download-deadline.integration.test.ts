import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeHarnessBackups, nativeRunFinalizations } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import type { StorageService } from "../../storage/types.js";
import { nativeHarnessBackupOwner, persistNativeHarnessBackup, restoreDurableNativeHarnessBackup,
  verifyDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const files = { ...original };
  return { ...original, default: files, cp: (...args: Parameters<typeof original.cp>) => files.cp(...args) };
});

/** Durable reads that deliver `chunkBytes` every `delayMs`, optionally stopping after `stallAfter` chunks. */
function throttledStorage(storage: StorageService, delayMs: number, chunkBytes: number, stallAfter?: number) {
  let sent = 0;
  const reads: string[] = [];
  const throttled = new Proxy(storage, { get(target, property) {
    if (property !== "getObject") {
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
    return async (companyId: string, objectKey: string, options?: { signal?: AbortSignal }) => {
      reads.push(objectKey);
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
  return { storage: throttled, reads };
}

describeEmbeddedPostgres("durable native backup download deadlines", () => {
  const environment = nativeRestartFixture();
  const ownedHomes: string[] = [];
  afterEach(async () => {
    for (const home of ownedHomes.splice(0)) await removeNativeHarnessBackup(home);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  /** An OpenCode backup with provider artifacts, so restores make two separate durable reads. */
  async function fixture() {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, runtimeRoot, successor, agentId } = environment.current;
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
    const sourceRoot = join(home, "qualified-provider-pack");
    await mkdir(sourceRoot);
    const original = { nodeCommand: "qualified Node executable", opencodeExecutable: "qualified OpenCode executable",
      opencodeProxy: `qualified proxy bytes ${randomUUID()}` };
    const artifacts = Object.fromEntries(await Promise.all(Object.entries(original).map(async ([name, bytes]) => {
      await writeFile(join(sourceRoot, name), bytes, { mode: 0o500 });
      return [name, { path: name, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }];
    })));
    const payload = { runnerSourceRevision: "a".repeat(40), target: { platform: "linux", architecture: "x64" },
      pins: { opencode: "1.18.34" }, artifacts: { ...artifacts, opencodeCommand: artifacts.opencodeExecutable } };
    const packManifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload,
      digest: `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}` };
    const launchRoot = `/home/daytona/.paperclip-runtime/paperclip-runner/provider-artifacts/${packManifest.digest.slice(7)}`;
    await f.db.update(heartbeatRuns).set({ nativeSessionId: identity.normalizedSessionId, driverKind: "opencode_server",
      runnerProfileJson: { ...f.preparedProfile, nativeProviderPackAdmissionState: {
        schema: "paperclip.native-provider-pack-admission-state.v1", state: "verified", admissionEpoch: randomUUID() },
      nativeProviderPackAdmission: { schema: "paperclip.native-provider-pack-admission.v1", stage: "session_admitted",
        authority: "core_verified_selection", companyId, agentId, runId: f.runId, sessionId: identity.normalizedSessionId,
        runnerInstanceId: "deadline-fixture-runner", runnerEnvironmentLeaseId: "deadline-fixture-lease",
        providerPackDigest: packManifest.digest, opencodeProxySha256: artifacts.opencodeProxy.sha256,
        sourceRevision: payload.runnerSourceRevision } },
    }).where(eq(heartbeatRuns.id, f.runId));
    const scopeDigest = createHash("sha256").update(randomUUID()).digest("hex");
    const storage = createStorageService(createLocalDiskStorageProvider(join(runtimeRoot, "durable-objects")));
    await persistNativeHarnessBackup({ db: f.db, root, owner, scopeDigest, storage,
      providerArtifacts: { sourceRoot, manifest: packManifest, launchRoot, accountUid: 1000 } });
    const [row] = await f.db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.scopeDigest, scopeDigest),
      eq(nativeHarnessBackups.status, "current")));
    return { db: f.db, companyId, scopeDigest, storage, identity, original, manifestSha256: row.manifestSha256 };
  }
  function replacementRoot() {
    const root = join(environment.current.runtimeRoot, randomUUID(), "failover-backups");
    ownedHomes.push(root);
    return root;
  }

  it("keeps restoring a backup whose downloads outlast the idle window while bytes keep arriving", async () => {
    const f = await fixture(), idle = 250, slow = throttledStorage(f.storage, 15, 64);
    // The former total deadline aborted this same progressing transfer with
    // the generic "The operation was aborted" seen on resumed sessions.
    const aborted = replacementRoot();
    await expect(restoreDurableNativeHarnessBackup({ ...f, storage: slow.storage, backupRoot: aborted, signal: AbortSignal.timeout(idle) }))
      .rejects.toThrow("The operation was aborted");
    await expect(stat(join(aborted, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    const replacement = replacementRoot(), startedAt = Date.now();
    slow.reads.splice(0);
    expect(await restoreDurableNativeHarnessBackup({ ...f, storage: slow.storage, backupRoot: replacement,
      downloadIdleTimeoutMs: idle })).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThan(idle * 2);
    // Both the backup object and the provider artifacts were read through the deadline.
    expect(slow.reads.some(key => key.includes("/native-harness-backups/"))).toBe(true);
    expect(slow.reads.some(key => !key.includes("/native-harness-backups/"))).toBe(true);
    expect(JSON.parse(await readFile(join(replacement, "current/opencode/sessions/history.json"), "utf8")))
      .toMatchObject(f.identity);
    expect(await readFile(join(replacement, "current/provider-artifacts/opencodeProxy"), "utf8")).toBe(f.original.opencodeProxy);
    expect(await verifyDurableNativeHarnessBackup({ ...f, storage: slow.storage, downloadIdleTimeoutMs: idle })).toBe(true);
  });

  it("names a download that stops sending bytes and publishes no partial backup", { timeout: 10_000 }, async () => {
    const f = await fixture(), replacement = replacementRoot();
    await expect(restoreDurableNativeHarnessBackup({ ...f, storage: throttledStorage(f.storage, 5, 64, 3).storage,
      backupRoot: replacement, downloadIdleTimeoutMs: 250 })).rejects.toThrow("native_harness_storage_download_stalled");
    await expect(stat(join(replacement, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(verifyDurableNativeHarnessBackup({ ...f, storage: throttledStorage(f.storage, 5, 64, 3).storage,
      downloadIdleTimeoutMs: 250 })).rejects.toThrow("native_harness_storage_download_stalled");
    // The saved backup is untouched and restores once the store responds again.
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement, downloadIdleTimeoutMs: 250 })).toBe(true);
  });

  it("stops at the outer bound during local copy and publishes nothing", async () => {
    const f = await fixture(), replacement = replacementRoot(), copy = fs.cp.bind(fs);
    vi.spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
      if (String(destination).includes(".durable-")) await new Promise(resolve => setTimeout(resolve, 400));
      return copy(source, destination, options);
    });
    await expect(restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement, downloadIdleTimeoutMs: 5_000,
      restoreMaxMs: 200 })).rejects.toThrow("native_harness_storage_restore_deadline_exceeded");
    await expect(stat(join(replacement, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets Stop end a progressing download with its own reason, including a Stop before it starts", async () => {
    const f = await fixture(), replacement = replacementRoot(), stop = new AbortController();
    setTimeout(() => stop.abort(new Error("caller_stopped")), 50);
    const failure = await restoreDurableNativeHarnessBackup({ ...f, storage: throttledStorage(f.storage, 15, 64).storage,
      backupRoot: replacement, signal: stop.signal, downloadIdleTimeoutMs: 5_000 }).then(() => null, (error: unknown) => error);
    const reason = failure as Error & { cause?: unknown };
    expect(failure).toBeInstanceOf(Error);
    expect([reason.message, (reason.cause as Error | undefined)?.message]).toContain("caller_stopped");
    await expect(stat(join(replacement, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement, signal: stop.signal,
      downloadIdleTimeoutMs: 5_000 })).rejects.toThrow();
    await expect(stat(join(replacement, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
