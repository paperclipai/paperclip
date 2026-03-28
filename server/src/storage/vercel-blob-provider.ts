import { del, get, head, put } from "@vercel/blob";
import { Readable } from "node:stream";
import type { GetObjectResult, HeadObjectResult, StorageProvider } from "./types.js";
import { notFound, unprocessable } from "../errors.js";

function isBlobNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "BlobNotFoundError";
}

export function createVercelBlobStorageProvider(token: string): StorageProvider {
  const resolved = token.trim();
  if (!resolved) {
    throw unprocessable("Vercel Blob storage requires a token");
  }

  return {
    id: "vercel_blob",

    async putObject(input) {
      await put(input.objectKey, input.body, {
        access: "private",
        token: resolved,
        contentType: input.contentType,
      });
    },

    async getObject(input): Promise<GetObjectResult> {
      try {
        const result = await get(input.objectKey, {
          access: "private",
          token: resolved,
        });

        if (!result || result.statusCode !== 200 || !result.stream) {
          throw notFound("Object not found");
        }

        return {
          stream: Readable.fromWeb(result.stream as never),
          contentType: result.blob.contentType ?? undefined,
          contentLength: result.blob.size ?? undefined,
          etag: result.blob.etag,
          lastModified: result.blob.uploadedAt,
        };
      } catch (err) {
        if (isBlobNotFoundError(err)) {
          throw notFound("Object not found");
        }
        throw err;
      }
    },

    async headObject(input): Promise<HeadObjectResult> {
      try {
        const result = await head(input.objectKey, { token: resolved });
        if (!result) {
          return { exists: false };
        }

        return {
          exists: true,
          contentType: result.contentType ?? undefined,
          contentLength: result.size ?? undefined,
          etag: result.etag,
          lastModified: result.uploadedAt,
        };
      } catch (err) {
        if (isBlobNotFoundError(err)) {
          return { exists: false };
        }
        throw err;
      }
    },

    async deleteObject(input): Promise<void> {
      try {
        await del(input.objectKey, { token: resolved });
      } catch (err) {
        if (isBlobNotFoundError(err)) return;
        throw err;
      }
    },
  };
}
