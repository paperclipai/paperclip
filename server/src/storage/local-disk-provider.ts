import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
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
      await fs.mkdir(dir, { recursive: true });

      const tempPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (Buffer.isBuffer(input.body)) {
        await fs.writeFile(tempPath, input.body);
      } else {
        await pipeline(input.body, createWriteStream(tempPath));
      }
      await fs.rename(tempPath, targetPath);
    },

    async getObject(input): Promise<GetObjectResult> {
      const filePath = resolveWithin(root, input.objectKey);
      const stat = await statOrNull(filePath);
      if (!stat || !stat.isFile()) {
        throw notFound("Object not found");
      }
      return {
        stream: createReadStream(filePath),
        contentLength: stat.size,
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
