import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { putS3Multipart } from "./s3-multipart.js";
import { withS3FailureDiagnostics } from "./s3-failure.js";
import { addAbortSignal, Readable } from "node:stream";
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
  });

  async function listExactVersions(key: string, signal?: AbortSignal) {
    const versions = new Set<string>(), cursors = new Set<string>();
    let keyMarker: string | undefined, versionMarker: string | undefined;
    while (true) {
      signal?.throwIfAborted();
      const output = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key,
        KeyMarker: keyMarker, VersionIdMarker: versionMarker, MaxKeys: 1000 }), { abortSignal: signal });
      if (typeof output.IsTruncated !== "boolean") throw new Error("s3_version_listing_invalid");
      for (const entry of [...(output.Versions ?? []), ...(output.DeleteMarkers ?? [])]) {
        if (typeof entry.Key !== "string" || !entry.Key.startsWith(key) ||
          typeof entry.VersionId !== "string" || !entry.VersionId) throw new Error("s3_version_listing_invalid");
        // Prefix is the narrowest S3 listing filter, but neighboring keys are never ours to delete.
        if (entry.Key === key) versions.add(entry.VersionId);
      }
      if (!output.IsTruncated) return versions;
      const nextKey = output.NextKeyMarker, nextVersion = output.NextVersionIdMarker;
      if (!nextKey || !nextKey.startsWith(key) || !nextVersion ||
        (keyMarker && Buffer.compare(Buffer.from(nextKey), Buffer.from(keyMarker)) < 0)) {
        throw new Error("s3_version_listing_cursor_invalid");
      }
      const cursor = JSON.stringify([nextKey, nextVersion]);
      if (cursors.has(cursor)) throw new Error("s3_version_listing_cursor_invalid");
      cursors.add(cursor); keyMarker = nextKey; versionMarker = nextVersion;
    }
  }

  return {
    id: "s3",

    async putObjectConditional(input) {
      const output = await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: buildKey(prefix, input.objectKey),
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        IfMatch: input.ifMatch,
        IfNoneMatch: input.ifNoneMatch,
      }), { abortSignal: input.signal });
      if (!output.ETag) throw new Error("Object storage did not return a publication ETag");
      return { etag: output.ETag };
    },

    async listObjects(input) {
      const keyPrefix = buildKey(prefix, input.prefix);
      const output = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: keyPrefix,
        ContinuationToken: input.continuationToken, MaxKeys: 1000,
      }), { abortSignal: input.signal });
      const strip = prefix ? prefix.length + 1 : 0;
      return {
        keys: (output.Contents ?? []).flatMap(object => object.Key ? [object.Key.slice(strip)] : []),
        continuationToken: output.IsTruncated ? output.NextContinuationToken : undefined,
      };
    },

    async putObject(input) {
      const key = buildKey(prefix, input.objectKey);
      if (input.contentLength > 16 * 1024 * 1024) {
        await putS3Multipart(client, bucket, key, input);
        return;
      }
      await withS3FailureDiagnostics("put_object", () => client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
        }),
        { abortSignal: input.signal },
      ));
    },

    async getObject(input): Promise<GetObjectResult> {
      const key = buildKey(prefix, input.objectKey);
      try {
        const output = await withS3FailureDiagnostics("get_object", () => client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            Range: input.range ? `bytes=${input.range.start}-${input.range.end}` : undefined,
          }),
          { abortSignal: input.signal },
        ));

        const stream = await toReadableStream(output.Body);
        if (input.signal) addAbortSignal(input.signal, stream);
        return {
          stream,
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
        const output = await withS3FailureDiagnostics("head_object", () => client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
          { abortSignal: input.signal },
        ));

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
      if (input.allVersions) {
        await withS3FailureDiagnostics("delete_object", async () => {
          // Finish listing before deleting: removing a cursor version must not skip later pages.
          const versions = await listExactVersions(key, input.signal);
          for (const versionId of versions) {
            input.signal?.throwIfAborted();
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
              { abortSignal: input.signal });
          }
          if ((await listExactVersions(key, input.signal)).size) throw new Error("s3_object_versions_still_present");
        });
        return;
      }
      await withS3FailureDiagnostics("delete_object", () => client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
        { abortSignal: input.signal },
      ));
    },
  };
}
