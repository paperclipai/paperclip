import type { RequestHandler } from "express";
import { promisify } from "node:util";
import { deflate, gzip } from "node:zlib";

export const API_COMPRESSION_THRESHOLD_BYTES = 1024;

const gzipAsync = promisify(gzip);
const deflateAsync = promisify(deflate);

type SupportedEncoding = "gzip" | "deflate";

type ApiCompressionOptions = {
  thresholdBytes?: number;
};

type EncodingPreference = {
  encoding: string;
  q: number;
};

function parseAcceptEncoding(value: string | string[] | undefined): EncodingPreference[] {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => {
      const [encodingPart, ...paramParts] = part.trim().split(";");
      const encoding = encodingPart?.trim().toLowerCase() ?? "";
      const qParam = paramParts
        .map((param) => param.trim())
        .find((param) => param.toLowerCase().startsWith("q="));
      const parsedQ = qParam ? Number(qParam.slice(2)) : 1;
      const q = Number.isFinite(parsedQ) ? parsedQ : 0;
      return { encoding, q };
    })
    .filter((entry) => entry.encoding.length > 0);
}

function selectEncoding(value: string | string[] | undefined): SupportedEncoding | null {
  const preferences = parseAcceptEncoding(value).filter((entry) => entry.q > 0);
  const findQ = (encoding: SupportedEncoding) =>
    preferences.find((entry) => entry.encoding === encoding)?.q ??
    preferences.find((entry) => entry.encoding === "*")?.q ??
    0;

  const gzipQ = findQ("gzip");
  const deflateQ = findQ("deflate");
  if (gzipQ <= 0 && deflateQ <= 0) return null;
  return gzipQ >= deflateQ ? "gzip" : "deflate";
}

function isJsonContentType(value: unknown): boolean {
  const contentType = String(value ?? "").toLowerCase();
  return contentType.includes("application/json") || contentType.includes("+json");
}

function shouldSkipForCacheControl(value: unknown): boolean {
  return /\bno-transform\b/i.test(String(value ?? ""));
}

function shouldSkipForStreamedResponse(res: Parameters<RequestHandler>[1]): boolean {
  return (
    res.hasHeader("Content-Disposition") ||
    res.hasHeader("Accept-Ranges") ||
    res.hasHeader("Content-Range")
  );
}

function statusAllowsBody(statusCode: number): boolean {
  return statusCode !== 204 && statusCode !== 304 && statusCode >= 200;
}

function shouldPassthroughWrite(res: Parameters<RequestHandler>[1]): boolean {
  const contentType = res.getHeader("Content-Type");
  const alreadyEncoded = res.hasHeader("Content-Encoding") && String(res.getHeader("Content-Encoding")).toLowerCase() !== "identity";
  return (
    // writeHead() may already have committed the response head (better-call
    // does this before streaming the body); headers can no longer change, so
    // buffering for compression would only risk corrupting the stream.
    res.headersSent ||
    alreadyEncoded ||
    !statusAllowsBody(res.statusCode) ||
    shouldSkipForCacheControl(res.getHeader("Cache-Control")) ||
    shouldSkipForStreamedResponse(res) ||
    contentType === undefined ||
    !isJsonContentType(contentType)
  );
}

function weakenStrongEtag(res: Parameters<RequestHandler>[1]): void {
  const etag = res.getHeader("ETag");
  if (etag === undefined) return;

  const weaken = (value: string) => /^W\//i.test(value) ? value : `W/${value}`;
  if (Array.isArray(etag)) {
    res.setHeader("ETag", etag.map((value) => weaken(String(value))));
    return;
  }

  res.setHeader("ETag", weaken(String(etag)));
}

function toBodyBuffer(chunk: unknown, encoding: BufferEncoding | undefined): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  // Handlers bridged from web Response streams (e.g. Better Auth via
  // better-call) write Uint8Array chunks; String(chunk) would serialize them
  // as comma-separated byte values and corrupt the body.
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk), encoding);
}

function normalizeEndArgs(args: unknown[]): {
  chunk: unknown;
  encoding: BufferEncoding | undefined;
  callback: (() => void) | undefined;
} {
  const [chunk, encodingOrCallback, callback] = args;
  return {
    chunk,
    encoding: typeof encodingOrCallback === "string" ? encodingOrCallback as BufferEncoding : undefined,
    callback:
      typeof encodingOrCallback === "function"
        ? encodingOrCallback as () => void
        : typeof callback === "function"
          ? callback as () => void
          : undefined,
  };
}

export function apiCompression(options: ApiCompressionOptions = {}): RequestHandler {
  const thresholdBytes = options.thresholdBytes ?? API_COMPRESSION_THRESHOLD_BYTES;

  return (req, res, next) => {
    const selectedEncoding = selectEncoding(req.headers["accept-encoding"]);
    if (!selectedEncoding || req.method === "HEAD") {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    const writeCallbacks: Array<() => void> = [];
    let passthrough = false;

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalFlushHeaders = res.flushHeaders?.bind(res);

    const restore = () => {
      res.write = originalWrite as typeof res.write;
      res.end = originalEnd as typeof res.end;
      if (originalFlushHeaders) {
        res.flushHeaders = originalFlushHeaders as typeof res.flushHeaders;
      }
    };

    const beginPassthrough = () => {
      if (passthrough) return;
      passthrough = true;
      restore();
      for (const buffered of chunks.splice(0)) {
        originalWrite(buffered);
      }
      for (const writeCallback of writeCallbacks.splice(0)) writeCallback();
    };

    res.write = ((chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      if (passthrough) {
        return originalWrite(chunk as never, encodingOrCallback as never, callback as never);
      }
      if (shouldPassthroughWrite(res)) {
        beginPassthrough();
        return originalWrite(chunk as never, encodingOrCallback as never, callback as never);
      }
      if (chunk !== undefined) {
        chunks.push(toBodyBuffer(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined));
      }
      const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (writeCallback) writeCallbacks.push(() => writeCallback(null));
      return true;
    }) as typeof res.write;

    res.end = ((...args: unknown[]) => {
      restore();
      const { chunk, encoding, callback } = normalizeEndArgs(args);
      if (chunk !== undefined) {
        chunks.push(toBodyBuffer(chunk, encoding));
      }

      const body = Buffer.concat(chunks);
      const alreadyEncoded = res.hasHeader("Content-Encoding") && String(res.getHeader("Content-Encoding")).toLowerCase() !== "identity";
      const shouldCompress =
        !passthrough &&
        !res.headersSent &&
        !alreadyEncoded &&
        statusAllowsBody(res.statusCode) &&
        body.length >= thresholdBytes &&
        isJsonContentType(res.getHeader("Content-Type")) &&
        !shouldSkipForCacheControl(res.getHeader("Cache-Control")) &&
        !shouldSkipForStreamedResponse(res);

      if (!shouldCompress) {
        const result = originalEnd(body, callback);
        for (const writeCallback of writeCallbacks) writeCallback();
        return result;
      }

      void (async () => {
        try {
          const compressed = selectedEncoding === "gzip"
            ? await gzipAsync(body)
            : await deflateAsync(body);
          res.vary("Accept-Encoding");
          res.setHeader("Content-Encoding", selectedEncoding);
          res.setHeader("Content-Length", String(compressed.length));
          weakenStrongEtag(res);
          res.removeHeader("Content-MD5");
          originalEnd(compressed, callback);
          for (const writeCallback of writeCallbacks) writeCallback();
        } catch (error) {
          // Compression is best-effort: never turn a healthy response into a
          // dropped connection. Send the original body if the head allows it.
          try {
            originalEnd(body, callback);
            for (const writeCallback of writeCallbacks) writeCallback();
          } catch {
            res.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        }
      })();
      return res;
    }) as typeof res.end;

    if (originalFlushHeaders) {
      res.flushHeaders = (() => {
        passthrough = true;
        restore();
        return originalFlushHeaders();
      }) as typeof res.flushHeaders;
    }

    next();
  };
}
