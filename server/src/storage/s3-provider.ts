import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { StorageProvider, GetObjectResult, HeadObjectResult } from "./types.js";
import { notFound, unprocessable } from "../errors.js";

interface S3ProviderConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildKey(prefix: string, objectKey: string): string {
  if (!prefix) return objectKey;
  return `${prefix}/${objectKey}`;
}

async function toReadableStream(body: unknown): Promise<Readable> {
  if (!body) throw notFound("Object not found");
  if (body instanceof Readable) return body;

  const candidate = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };

  if (typeof candidate.transformToWebStream === "function") {
    const webStream = candidate.transformToWebStream();
    const reader = webStream.getReader();
    return Readable.from(
      (async function* () {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) yield value;
        }
      })(),
    );
  }

  if (typeof candidate.arrayBuffer === "function") {
    const buffer = Buffer.from(await candidate.arrayBuffer());
    return Readable.from(buffer);
  }

  throw unprocessable("Unsupported S3 body stream type");
}

function toDate(value: Date | undefined): Date | undefined {
  return value instanceof Date ? value : undefined;
}

export function createS3StorageProvider(config: S3ProviderConfig): StorageProvider {
  const bucket = config.bucket.trim();
  const region = config.region.trim();
  if (!bucket) throw unprocessable("S3 storage bucket is required");
  if (!region) throw unprocessable("S3 storage region is required");

  const prefix = normalizePrefix(config.prefix);
  const client = new S3Client({
    region,
    endpoint: config.endpoint,
    forcePathStyle: Boolean(config.forcePathStyle),
  });

  return {
    id: "s3",

    async putObject(input) {
      const key = buildKey(prefix, input.objectKey);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
        }),
      );
    },

    async getObject(input): Promise<GetObjectResult> {
      const key = buildKey(prefix, input.objectKey);
      try {
        const output = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );

        return {
          stream: await toReadableStream(output.Body),
          contentType: output.ContentType,
          contentLength: output.ContentLength,
          etag: output.ETag,
          lastModified: toDate(output.LastModified),
        };
      } catch (err) {
        const code = (err as { name?: string }).name;
        if (code === "NoSuchKey" || code === "NotFound") throw notFound("Object not found");
        throw err;
      }
    },

    async headObject(input): Promise<HeadObjectResult> {
      const key = buildKey(prefix, input.objectKey);
      try {
        const output = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );

        return {
          exists: true,
          contentType: output.ContentType,
          contentLength: output.ContentLength,
          etag: output.ETag,
          lastModified: toDate(output.LastModified),
        };
      } catch (err) {
        const code = (err as { name?: string }).name;
        if (code === "NoSuchKey" || code === "NotFound") return { exists: false };
        throw err;
      }
    },

    async deleteObject(input): Promise<void> {
      const key = buildKey(prefix, input.objectKey);
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    },
  };
}
