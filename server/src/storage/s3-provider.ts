import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
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
  return prefix
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
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
    return Readable.from((async function* () {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    })());
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
    // The SDK's optional streaming checksum wrapper does not propagate source
    // errors: its detached digest promise can reject unhandled and stop the
    // server. Keep ordinary streaming/backpressure for fallible file sources.
    // Work-folder content integrity is independently checked before publication.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });

  return {
    id: "s3",

    async putObject(input) {
      const key = buildKey(prefix, input.objectKey);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      });
      if (!(input.body instanceof Readable)) {
        await client.send(command);
        return;
      }
      const body = input.body;
      const abort = new AbortController();
      // Observe the source before the SDK starts asynchronous signing. An early
      // source failure or a successful HTTP response must not escape validation.
      const completed = finished(body, { cleanup: true }).catch((error) => {
        abort.abort();
        throw error;
      });
      try {
        await Promise.all([completed, client.send(command, { abortSignal: abort.signal })]);
      } finally {
        // A rejected request must release a remote file reader too. Promise.all
        // already observes completion's rejection when destruction closes it.
        body.destroy();
      }
    },

    async getObject(input): Promise<GetObjectResult> {
      const key = buildKey(prefix, input.objectKey);
      try {
        const output = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            Range: input.range ? `bytes=${input.range.start}-${input.range.end}` : undefined,
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
