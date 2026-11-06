import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { StorageProvider } from "../../../storage/types.js";
import { createObjectRunLogStore } from "../../object-run-log-store.js";

export function objectLogFixture(beforeConditionalPut?: (input: Parameters<NonNullable<StorageProvider["putObjectConditional"]>>[0]) => Promise<void>) {
  const objects = new Map<string, Buffer>();
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const provider: StorageProvider = {
    id: "s3",
    async putObject() { throw new Error("unexpected unconditional write"); },
    async putObjectConditional(input) {
      await beforeConditionalPut?.(input);
      const old = objects.get(input.objectKey);
      if (input.ifNoneMatch ? old : !old || digest(old) !== input.ifMatch)
        throw Object.assign(new Error("conflict"), { name: "PreconditionFailed" });
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(input.body)) chunks.push(input.body);
      else for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); objects.set(input.objectKey, bytes);
      return { etag: digest(bytes) };
    },
    async getObject(input) {
      const bytes = objects.get(input.objectKey);
      if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { stream: Readable.from([bytes]), etag: digest(bytes) };
    },
    async headObject(input) { return { exists: objects.has(input.objectKey) }; },
    async deleteObject(input) { objects.delete(input.objectKey); },
    async listObjects(input) { return { keys: [...objects.keys()].filter(key => key.startsWith(input.prefix)) }; },
  };
  const store = createObjectRunLogStore({ provider, keyPrefix: "fixture", assertWriterAuthority: async () => undefined });
  return store;
}
