import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { assertSourceFileSize, fileRangeMd5, putS3Multipart, putS3MultipartFile, sendFileRequestWithRetry } from "./s3-multipart.js";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { recordS3BodyFailure, withS3FailureDiagnostics } from "./s3-failure.js";
import { sendThroughStorageOutage } from "./storage-unavailable.js";
import { addAbortSignal, Readable } from "node:stream";
import { retryS3RequestTimeouts } from "./s3-request-timeout-retry.js";
import { refreshS3CredentialsOnRejection } from "./s3-credential-refresh.js";
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

function observeBodyFailures(stream: Readable, response: unknown) {
  stream.on("error", function recordBodyFailure(error) {
    recordS3BodyFailure(error, response);
    if (stream.listenerCount("error") === 1) throw error;
  });
  return stream;
}

const BODY_RESUME_ATTEMPTS = 3;
const TRANSIENT_BODY_ERRORS = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET"]);

function isTransientBodyError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (typeof code === "string" && TRANSIENT_BODY_ERRORS.has(code))
    || (typeof message === "string" && /socket hang up|aborted|premature close/i.test(message));
}

function resumableBody(first: Readable, reopen: (offset: number, signal: AbortSignal) => Promise<Readable>, length: number, signal?: AbortSignal) {
  let current = first, closed = false;
  const reading = new AbortController();
  const resumeSignal = signal ? AbortSignal.any([signal, reading.signal]) : reading.signal;
  async function* chunks() {
    let offset = 0, resumes = 0;
    while (true) {
      try {
        for await (const chunk of current) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          offset += bytes.length;
          yield bytes;
        }
        return;
      } catch (error) {
        current.destroy();
        if (offset >= length) return;
        if (closed || signal?.aborted || resumes >= BODY_RESUME_ATTEMPTS || !isTransientBodyError(error)) throw error;
        resumes += 1;
        current = await reopen(offset, resumeSignal);
        if (closed) { current.destroy(); return; }
      }
    }
  }
  const stream = Readable.from(chunks(), { objectMode: false });
  const destroyWrapper = stream._destroy.bind(stream);
  stream._destroy = (error, callback) => {
    closed = true;
    reading.abort(error ?? new Error("download_closed"));
    current.destroy();
    destroyWrapper(error, callback);
  };
  return stream;
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
  retryS3RequestTimeouts(client);
  refreshS3CredentialsOnRejection(client);
  // File sources carry Content-MD5 as their integrity check. Send plain bodies
  // so the backend verifies that digest directly; the default client wraps
  // bodies in aws-chunked framing with its own trailing checksum.
  const fileClient = new S3Client({
    region,
    endpoint: config.endpoint,
    forcePathStyle: Boolean(config.forcePathStyle),
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  retryS3RequestTimeouts(fileClient);
  refreshS3CredentialsOnRejection(fileClient);

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
    immutableObjectNamespace: config.endpoint ? createHash("sha256").update(JSON.stringify(["s3",
      new URL(config.endpoint).href, region, bucket, prefix, Boolean(config.forcePathStyle),
    ])).digest("hex") : undefined,

    async putObjectConditional(input) {
      const send = () => withS3FailureDiagnostics("put_object", () => client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: buildKey(prefix, input.objectKey),
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        IfMatch: input.ifMatch,
        IfNoneMatch: input.ifNoneMatch,
      }), { abortSignal: input.signal }), input.signal);
      const output = Buffer.isBuffer(input.body) ? await sendThroughStorageOutage(send, input.signal) : await send();
      if (!output.ETag) throw new Error("Object storage did not return a publication ETag");
      return { etag: output.ETag };
    },

    async abortIncompleteUploads(input) {
      const key = buildKey(prefix, input.objectKey);
      const uploads: string[] = [];
      let keyMarker: string | undefined, uploadIdMarker: string | undefined;
      for (let pages = 0; ; pages++) {
        input.signal?.throwIfAborted();
        if (pages >= 100) throw new Error("s3_multipart_listing_cursor_invalid");
        const output = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key,
          KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker, MaxUploads: 1000 }), { abortSignal: input.signal });
        for (const upload of output.Uploads ?? []) if (upload.Key === key && upload.UploadId) uploads.push(upload.UploadId);
        if (!output.IsTruncated) break;
        if (!output.NextKeyMarker && !output.NextUploadIdMarker) throw new Error("s3_multipart_listing_cursor_invalid");
        keyMarker = output.NextKeyMarker; uploadIdMarker = output.NextUploadIdMarker;
      }
      let aborted = 0;
      for (const uploadId of uploads) {
        input.signal?.throwIfAborted();
        try {
          await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), { abortSignal: input.signal });
          aborted++;
        } catch (error) {
          if ((error as { name?: string }).name !== "NoSuchUpload") throw error;
        }
      }
      return aborted;
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
      const sourceFile = input.sourceFile;
      if (sourceFile && input.contentLength > 16 * 1024 * 1024) {
        return putS3MultipartFile(fileClient, bucket, key, { ...input, sourceFile });
      }
      if (sourceFile) {
        // Content-MD5 makes the backend reject any byte it did not receive intact.
        if (input.body instanceof Readable) input.body.destroy();
        await assertSourceFileSize(sourceFile, input.contentLength);
        const contentMd5 = await fileRangeMd5(sourceFile, 0, input.contentLength - 1, input.signal);
        await sendThroughStorageOutage(() => sendFileRequestWithRetry(input.signal, async () => {
          const body = createReadStream(sourceFile);
          try {
            await withS3FailureDiagnostics("put_object", () => fileClient.send(new PutObjectCommand({
              Bucket: bucket, Key: key, Body: body, ContentType: input.contentType,
              ContentLength: input.contentLength, ContentMD5: contentMd5,
            }), { abortSignal: input.signal }), input.signal);
          } finally { body.destroy(); }
        }), input.signal);
        return { integrity: "server_verified_md5" } as const;
      }
      if (input.contentLength > 16 * 1024 * 1024) {
        await putS3Multipart(client, bucket, key, input);
        return;
      }
      const send = () => withS3FailureDiagnostics("put_object", () => client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
        }),
        { abortSignal: input.signal },
      ), input.signal);
      await (Buffer.isBuffer(input.body) ? sendThroughStorageOutage(send, input.signal) : send());
    },

    async getObject(input): Promise<GetObjectResult> {
      const key = buildKey(prefix, input.objectKey);
      try {
        const output = await sendThroughStorageOutage(() => withS3FailureDiagnostics("get_object", () => client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            Range: input.range ? `bytes=${input.range.start}-${input.range.end}` : undefined,
          }),
          { abortSignal: input.signal },
        ), input.signal), input.signal);

        const first = observeBodyFailures(await toReadableStream(output.Body), output);
        const etag = output.ETag;
        const start = input.range?.start ?? 0;
        const end = input.range?.end ?? (typeof output.ContentLength === "number" ? output.ContentLength - 1 : undefined);
        const reopen = async (offset: number, resumeSignal: AbortSignal) => {
          const resumed = await withS3FailureDiagnostics("get_object", () => client.send(new GetObjectCommand({
            Bucket: bucket, Key: key, IfMatch: etag,
            Range: `bytes=${start + offset}-${end ?? ""}`,
          }), { abortSignal: resumeSignal }), resumeSignal);
          return observeBodyFailures(await toReadableStream(resumed.Body), resumed);
        };
        const stream = etag && end !== undefined
          ? resumableBody(first, reopen, end - start + 1, input.signal)
          : first;
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
        const output = await sendThroughStorageOutage(() => withS3FailureDiagnostics("head_object", () => client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
          { abortSignal: input.signal },
        ), input.signal), input.signal);

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
        await sendThroughStorageOutage(() => withS3FailureDiagnostics("delete_object", async () => {
          // Finish listing before deleting: removing a cursor version must not skip later pages.
          const versions = await listExactVersions(key, input.signal);
          for (const versionId of versions) {
            input.signal?.throwIfAborted();
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
              { abortSignal: input.signal });
          }
          if ((await listExactVersions(key, input.signal)).size) throw new Error("s3_object_versions_still_present");
        }, input.signal), input.signal);
        return;
      }
      await sendThroughStorageOutage(() => withS3FailureDiagnostics("delete_object", () => client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
        { abortSignal: input.signal },
      ), input.signal), input.signal);
    },
  };
}
