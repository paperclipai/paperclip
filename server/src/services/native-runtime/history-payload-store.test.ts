import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { HistoryPayloadStore } from "./history-payload-store.js";

it("publishes exact immutable bytes, reopens them, and fails closed on scope, path, size and corruption", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paperclip-history-payload-"));
  try {
    const provider = createLocalDiskStorageProvider(root), store = new HistoryPayloadStore(provider);
    const scope = { companyId: randomUUID(), runId: randomUUID() }, bytes = Buffer.from("binary\0é".repeat(8192));
    const ref = await store.put(scope, bytes, "application/json");
    expect(await store.put(scope, bytes, "application/json")).toEqual(ref);
    expect(await new HistoryPayloadStore(provider).read(scope, ref, bytes.length)).toEqual(bytes);
    const get = vi.spyOn(provider, "getObject");
    for (const changed of [
      { ...ref, companyId: randomUUID() }, { ...ref, runId: randomUUID() },
      { ...ref, objectKey: `${scope.companyId}/../some-file` }, { ...ref, provider: "s3" },
      { ...ref, byteLength: bytes.length + 1 }, { ...ref, sha256: "0".repeat(64) },
    ]) await expect(store.read(scope, changed, bytes.length)).rejects.toThrow("history_payload_reference_invalid");
    expect(get).not.toHaveBeenCalled();
    await writeFile(resolve(root, ref.objectKey), Buffer.alloc(bytes.length, 0x78));
    await expect(store.read(scope, ref, bytes.length)).rejects.toThrow("history_payload_integrity_mismatch");
    await rm(resolve(root, ref.objectKey));
    await expect(store.read(scope, ref, bytes.length)).rejects.toThrow("not found");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("never publishes an upload which the backend lost or changed, and caps a lying stream", async () => {
  const scope = { companyId: randomUUID(), runId: randomUUID() }, bytes = Buffer.from("original");
  const put = vi.fn(async () => {});
  const stream = Readable.from([Buffer.alloc(100)]);
  const provider = { id: "s3" as const, putObject: put,
    getObject: vi.fn(async () => ({ stream })), headObject: vi.fn(), deleteObject: vi.fn() };
  await expect(new HistoryPayloadStore(provider).put(scope, bytes, "application/json")).rejects.toThrow("history_payload_length_mismatch");
  expect(stream.destroyed).toBe(true);
  provider.getObject.mockRejectedValueOnce(new Error("lost upload"));
  await expect(new HistoryPayloadStore(provider).put(scope, bytes, "application/json")).rejects.toThrow("lost upload");
  expect(put).toHaveBeenCalledTimes(2);
});
