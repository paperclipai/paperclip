import type { RequestHandler } from "express";
import { deflateSync, gzipSync } from "node:zlib";

export const API_COMPRESSION_THRESHOLD_BYTES = 1024;

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

function statusAllowsBody(statusCode: number): boolean {
  return statusCode !== 204 && statusCode !== 304 && statusCode >= 200;
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

    res.write = ((chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      if (passthrough) {
        return originalWrite(chunk as never, encodingOrCallback as never, callback as never);
      }
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encodingOrCallback === "string" ? encodingOrCallback : undefined));
      }
      const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (writeCallback) writeCallbacks.push(() => writeCallback(null));
      return true;
    }) as typeof res.write;

    res.end = ((...args: unknown[]) => {
      restore();
      const { chunk, encoding, callback } = normalizeEndArgs(args);
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding));
      }

      const body = Buffer.concat(chunks);
      const alreadyEncoded = res.hasHeader("Content-Encoding") && String(res.getHeader("Content-Encoding")).toLowerCase() !== "identity";
      const shouldCompress =
        !passthrough &&
        !alreadyEncoded &&
        statusAllowsBody(res.statusCode) &&
        body.length >= thresholdBytes &&
        isJsonContentType(res.getHeader("Content-Type")) &&
        !shouldSkipForCacheControl(res.getHeader("Cache-Control"));

      if (!shouldCompress) {
        const result = originalEnd(body, callback);
        for (const writeCallback of writeCallbacks) writeCallback();
        return result;
      }

      const compressed = selectedEncoding === "gzip" ? gzipSync(body) : deflateSync(body);
      res.vary("Accept-Encoding");
      res.setHeader("Content-Encoding", selectedEncoding);
      res.setHeader("Content-Length", String(compressed.length));
      res.removeHeader("Content-MD5");
      res.removeHeader("ETag");
      const result = originalEnd(compressed, callback);
      for (const writeCallback of writeCallbacks) writeCallback();
      return result;
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
