import { constants, createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { StorageProvider, GetObjectResult, HeadObjectResult } from "./types.js";
import { notFound, badRequest } from "../errors.js";

function normalizeObjectKey(objectKey: string): string {
  const normalized = objectKey.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/")) {
    throw badRequest("Invalid object key");
  }

  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw badRequest("Invalid object key");
  }

  return parts.join("/");
}

function resolveWithin(baseDir: string, objectKey: string): string {
  const normalizedKey = normalizeObjectKey(objectKey);
  const resolved = path.resolve(baseDir, normalizedKey);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw badRequest("Invalid object key path");
  }
  return resolved;
}

async function statOrNull(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

export function createLocalDiskStorageProvider(baseDir: string): StorageProvider {
  const root = path.resolve(baseDir);

  return {
    id: "local_disk",

    async putObject(input) {
      const targetPath = resolveWithin(root, input.objectKey);
      const dir = path.dirname(targetPath);
      const firstCreated = await fs.mkdir(dir, { recursive: true, mode: 0o700 });

      const tempPath = `${targetPath}.tmp-${randomUUID()}`;
      const file = await fs.open(tempPath, "wx", 0o600);
      try {
        const hash = createHash("sha256");
        let length = 0;
        const chunks = Buffer.isBuffer(input.body) ? [input.body] : input.body;
        for await (const value of chunks) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          length += chunk.length;
          if (length > input.contentLength) throw new Error("storage_object_length_mismatch");
          hash.update(chunk);
          await file.writeFile(chunk);
        }
        if (length !== input.contentLength || (input.sha256 && input.sha256 !== hash.digest("hex"))) throw new Error("storage_object_integrity_mismatch");
        await file.sync();
        await file.close();
        await fs.rename(tempPath, targetPath);
        if (process.platform !== "win32") {
          // A leaf fsync alone does not make newly created ancestor directory
          // entries durable. Flush through the first pre-existing parent before
          // allowing a database reference to these bytes to commit.
          const stop = firstCreated ? path.dirname(firstCreated) : dir;
          let current = dir;
          for (;;) {
            const directory = await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try { await directory.sync(); } finally { await directory.close(); }
            if (current === stop) break;
            current = path.dirname(current);
          }
        }
      } finally {
        await file.close();
        await fs.rm(tempPath, { force: true });
      }
    },

    async getObject(input): Promise<GetObjectResult> {
      const filePath = resolveWithin(root, input.objectKey);
      const stat = await statOrNull(filePath);
      if (!stat || !stat.isFile()) {
        throw notFound("Object not found");
      }
      const streamOptions = input.range
        ? { start: input.range.start, end: input.range.end }
        : undefined;
      const contentLength = input.range
        ? input.range.end - input.range.start + 1
        : stat.size;
      return {
        stream: createReadStream(filePath, streamOptions),
        contentLength,
        lastModified: stat.mtime,
      };
    },

    async headObject(input): Promise<HeadObjectResult> {
      const filePath = resolveWithin(root, input.objectKey);
      const stat = await statOrNull(filePath);
      if (!stat || !stat.isFile()) {
        return { exists: false };
      }
      return {
        exists: true,
        contentLength: stat.size,
        lastModified: stat.mtime,
      };
    },

    async deleteObject(input): Promise<void> {
      const filePath = resolveWithin(root, input.objectKey);
      try {
        await fs.unlink(filePath);
      } catch {
        // idempotent delete
      }
    },
  };
}
