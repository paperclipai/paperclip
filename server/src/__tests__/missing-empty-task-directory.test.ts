import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { sealRestorePoint, type RestorePointIdentity } from "../services/git-restore-point.js";
import { captureTaskDirectorySnapshot, materializeTaskDirectorySnapshot } from "../services/isolated-task-directory-snapshot.js";
import { loadTaskDirectoryRestorePoint, TASK_DIRECTORY_RESTORE_POINT_SCHEMA, type TaskDirectoryRestorePointRef } from "../services/isolated-task-directory-retention.js";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-empty-retention-")));
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "empty-retention-test");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
});

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(kind = "empty", scope?: keyof RestorePointIdentity) {
  const directory = path.join(root, "source"); await fs.mkdir(directory);
  const empty = await captureTaskDirectorySnapshot(directory);
  if (kind === "file") await fs.writeFile(path.join(directory, "saved.txt"), "must never disappear\n");
  if (kind === "directory") await fs.mkdir(path.join(directory, "saved-directory"));
  const snapshot = await captureTaskDirectorySnapshot(directory);
  const identity = { companyId: randomUUID(), workspaceId: randomUUID(), restorePointId: randomUUID(), generation: 1 };
  const foreign = { ...identity };
  if (scope === "generation") foreign.generation = 2;
  else if (scope) foreign[scope] = randomUUID();
  const sealed = await sealRestorePoint(snapshot.payload, foreign);
  const storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects")));
  const objectKey = `${identity.companyId}/git-restore-points/${identity.workspaceId}/1/task-directory/${identity.restorePointId}.pcrp`;
  const put = (body: Buffer) => storage.putFile({ companyId: identity.companyId, namespace: "git-restore-points", objectKey,
    originalFilename: null, contentType: "application/octet-stream", body });
  await put(sealed.ciphertext);
  const ref: TaskDirectoryRestorePointRef = { schema: TASK_DIRECTORY_RESTORE_POINT_SCHEMA, id: identity.restorePointId, objectKey, generation: 1,
    sha256: sealed.sha256, byteSize: sealed.ciphertext.length, key: sealed.key, digest: snapshot.digest, files: snapshot.files, excluded: snapshot.excluded };
  const load = (recoverMissingEmpty = true) => loadTaskDirectoryRestorePoint({ storage, workspace: { companyId: identity.companyId, id: identity.workspaceId }, ref, recoverMissingEmpty });
  return { ref, storage, put, load, empty, snapshot, directory, remove: () => storage.deleteObject(identity.companyId, objectKey) };
}

it("recovers only the exact empty payload authenticated by the original scoped key envelope", async () => {
  const f = await fixture(); await f.remove(); await fs.rm(f.directory, { recursive: true });
  await expect(f.load(false)).rejects.toMatchObject({ reason: "restore_point_unavailable" });
  const payload = await f.load(); expect(payload).toEqual(f.snapshot.payload);
  const restored = await materializeTaskDirectorySnapshot({ payload, target: path.join(root, "restored"), expectedDigest: f.ref.digest });
  expect(await fs.readdir(restored)).toEqual([]);
  expect(await f.storage.headObject(f.ref.objectKey.split("/")[0]!, f.ref.objectKey)).toMatchObject({ exists: false });
});

it.each(["file", "directory"])("refuses forged empty counters and digest for authenticated %s contents", async kind => {
  const f = await fixture(kind); await f.remove();
  f.ref.files = 0; f.ref.excluded = 0; f.ref.digest = f.empty.digest;
  await expect(f.load()).rejects.toMatchObject({ reason: "plaintext_hash_mismatch" });
});

it.each(["companyId", "workspaceId", "restorePointId", "generation"] as const)("rejects a candidate from another %s", async scope => {
  const f = await fixture("empty", scope); await f.remove();
  await expect(f.load()).rejects.toMatchObject({ reason: "key_identity_mismatch" });
});

it("does not replace a present corrupt encrypted object with a reconstructed payload", async () => {
  const f = await fixture(); await f.put(Buffer.from("corrupted"));
  await expect(f.load()).rejects.toThrow();
});

it("retains a missing nonempty checkpoint as an unresolved obligation", async () => {
  const f = await fixture("file"); await f.remove();
  await expect(f.load()).rejects.toMatchObject({ reason: "restore_point_unavailable" });
  expect(await fs.readFile(path.join(f.directory, "saved.txt"), "utf8")).toBe("must never disappear\n");
});

it("does not treat an unreadable present object as missing", async () => {
  const f = await fixture();
  vi.spyOn(f.storage, "getObject").mockRejectedValue(new Error("read unavailable"));
  await expect(f.load()).rejects.toMatchObject({ reason: "restore_point_unavailable" });
});

it("does not reconstruct when object absence cannot be established", async () => {
  const f = await fixture(); await f.remove();
  vi.spyOn(f.storage, "headObject").mockRejectedValue(new Error("head unavailable"));
  await expect(f.load()).rejects.toThrow();
});

it("refuses an expired checkpoint even when its exact contents are reconstructible", async () => {
  const f = await fixture(); await f.remove();
  await expect(loadTaskDirectoryRestorePoint({ storage: f.storage, workspace: { companyId: f.ref.objectKey.split("/")[0]!, id: f.ref.objectKey.split("/")[2]! },
    ref: { ...f.ref, expiredAt: new Date().toISOString() }, recoverMissingEmpty: true })).rejects.toMatchObject({ reason: "restore_point_expired" });
});
