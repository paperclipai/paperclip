import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import type { StorageProvider } from "../storage/types.js";
import { ObjectJournalBusyError } from "./object-byte-journal.js";
import { createProviderTraceObjectStore } from "./provider-trace-object-store.js";
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";

const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
afterEach(() => vi.unstubAllEnvs());
describe.skipIf(!endpoint)("encrypted object provider traces (S3 integration)", () => {
  it.each(["environment", "existing key file"])(
    "restores both sidecars on a new host, preserves exact downloads, and removes ciphertext (%s)",
    async (source) => {
      const bucket = `paperclip-trace-test-${randomUUID()}`;
      const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true });
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const directory = await fs.mkdtemp(path.join(tmpdir(), "object-trace-"));
      const keyFile = path.join(directory, "existing-vault.key");
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", source === "environment" ? "a".repeat(64) : "");
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", keyFile);
      if (source === "existing key file")
        await fs.writeFile(keyFile, "a".repeat(64), { mode: 0o600 });
      const filename = `${randomUUID()}.ndjson`,
        ref = `s3-segments-v1:company/run/${filename}`;
      const bytes = Buffer.from('{"kind":"frame","rawBase64":"cHJpdmF0ZQ=="}\n');
      const interpretation = Buffer.from('{"kind":"interpretation","frameId":1}\n');
      const provider = createS3StorageProvider({
        endpoint,
        bucket,
        region: "us-east-1",
        forcePathStyle: true,
      });
      try {
        const a = createProviderTraceObjectStore(provider),
          fileA = path.join(directory, "a.ndjson");
        await a.open(ref, fileA, async () => undefined);
        await fs.appendFile(fileA, bytes);
        await fs.appendFile(`${fileA}.rehydration`, interpretation);
        await a.finish(ref);
        const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        for (const object of objects.Contents ?? []) {
          if (object.Key?.endsWith("head.json")) continue;
          const stored = await client.send(
            new GetObjectCommand({ Bucket: bucket, Key: object.Key }),
          );
          const payload = await stored.Body!.transformToByteArray();
          expect(Buffer.from(payload).includes(Buffer.from("rawBase64"))).toBe(false);
          expect(Buffer.from(payload).includes(Buffer.from("interpretation"))).toBe(false);
        }
        await fs.rm(fileA);
        await fs.rm(`${fileA}.rehydration`);
        const b = createProviderTraceObjectStore(provider),
          fileB = path.join(directory, "b.ndjson");
        expect(await b.read(ref)).toEqual(Buffer.concat([bytes, interpretation]));
        await fs.mkdir(`${fileB}.rehydration`);
        await expect(b.open(ref, fileB, async () => undefined)).rejects.toThrow();
        expect(await b.settled(ref)).toBe(true);
        await expect(fs.stat(fileB)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await b.read(ref)).toEqual(Buffer.concat([bytes, interpretation]));
        await fs.rmdir(`${fileB}.rehydration`);
        await b.open(ref, fileB, async () => undefined);
        expect(await fs.readFile(fileB)).toEqual(bytes);
        expect(await fs.readFile(`${fileB}.rehydration`)).toEqual(interpretation);
        await fs.appendFile(fileB, Buffer.from('{"kind":"trace_status","status":"complete"}\n'));
        await b.finish(ref);
        await b.remove(ref);
        await expect(b.read(ref)).rejects.toThrow("unavailable");
        const left = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        expect(left.Contents?.every((o) => o.Key!.endsWith("head.json"))).toBe(true);
      } finally {
        const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (objects.Contents?.length)
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects.Contents.map((o) => ({ Key: o.Key! })) },
            }),
          );
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        await fs.rm(directory, { recursive: true, force: true });
        client.destroy();
      }
    },
    30_000,
  );
});

describe("encrypted object provider trace reads under load", () => {
  function memory() {
    const objects = new Map<string, Buffer>();
    const etag = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const provider: StorageProvider = {
      id: "s3",
      async putObject() {
        throw Error("unconditional");
      },
      async putObjectConditional(i) {
        const old = objects.get(i.objectKey);
        if (i.ifNoneMatch ? old : !old || etag(old) !== i.ifMatch)
          throw Object.assign(Error("conflict"), { name: "PreconditionFailed" });
        const chunks: Buffer[] = [];
        if (Buffer.isBuffer(i.body)) chunks.push(i.body);
        else for await (const bytes of i.body) chunks.push(Buffer.from(bytes));
        const b = Buffer.concat(chunks);
        objects.set(i.objectKey, b);
        return { etag: etag(b) };
      },
      async getObject(i) {
        const b = objects.get(i.objectKey);
        if (!b) throw Object.assign(Error("missing"), { name: "NoSuchKey" });
        return { stream: Readable.from([b]), etag: etag(b) };
      },
      async headObject(i) {
        return { exists: objects.has(i.objectKey) };
      },
      async deleteObject(i) {
        objects.delete(i.objectKey);
      },
      async listObjects(i) {
        return { keys: [...objects.keys()].filter((k) => k.startsWith(i.prefix)) };
      },
    };
    return provider;
  }

  it("never sheds a finalization read while client reads are shed", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "object-trace-load-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(directory, "unused.key"));
    try {
      const provider = memory(),
        store = createProviderTraceObjectStore(provider),
        file = path.join(directory, "trace.ndjson"),
        ref = `s3-segments-v1:company/run/${randomUUID()}.ndjson`,
        bytes = Buffer.from('{"kind":"frame","frameId":1}\n');
      await store.open(ref, file, async () => undefined);
      await fs.appendFile(file, bytes);
      await store.finish(ref);
      const get = provider.getObject;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      provider.getObject = async (i) => {
        await gate;
        return get(i);
      };
      const clients = Array.from({ length: 40 }, () => store.read(ref, undefined, "interactive"));
      await expect(store.read(ref, undefined, "interactive")).rejects.toBeInstanceOf(
        ObjectJournalBusyError,
      );
      const finalization = store.read(ref);
      open();
      for (const read of await Promise.allSettled(clients))
        if (read.status === "rejected") expect(read.reason).toBeInstanceOf(ObjectJournalBusyError);
        else expect(read.value).toEqual(bytes);
      expect(await finalization).toEqual(bytes);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
