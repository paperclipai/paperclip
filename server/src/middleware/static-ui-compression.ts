import compression from "compression";
import type { RequestHandler } from "express";
import { constants } from "node:zlib";
import path from "node:path";
import { staticUiFiles } from "./static-ui.js";

/** Compress only the built UI; API and MCP streams use their own transports. */
export function staticUiCompression(): RequestHandler {
  return compression({
    // Dynamic Brotli should not spend seconds compressing large JS bundles.
    brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
    filter(req, res) {
      // Byte ranges refer to the original file, so preserve their representation.
      if (req.headers.range || res.hasHeader("Content-Range")) return false;
      return compression.filter(req, res);
    },
  });
}

export function precompressedUiAssets(assetsDir: string): RequestHandler {
  const copies = PRECOMPRESSED_ENCODINGS.map(([encoding, extension]) => ({
    encoding,
    extension,
    serve: staticUiFiles(assetsDir, {
      maxAge: "1y",
      immutable: true,
      index: false,
      redirect: false,
      acceptRanges: false,
      setHeaders(res, filePath) {
        res.setHeader("Content-Encoding", encoding);
        res.setHeader("Vary", "Accept-Encoding");
        res.type(path.extname(filePath.slice(0, -extension.length)));
      },
    }),
  }));
  return (req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.headers.range) return next();
    const candidates = preferredCopies(String(req.headers["accept-encoding"] ?? ""), copies);
    const url = req.url;
    const queryStart = url.indexOf("?");
    const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
    const search = queryStart === -1 ? "" : url.slice(queryStart);
    const attempt = (index: number) => (error?: unknown) => {
      req.url = url;
      const copy = candidates[index];
      if (error || !copy) return next(error);
      req.url = pathname + copy.extension + search;
      copy.serve(req, res, attempt(index + 1));
      req.url = url;
    };
    attempt(0)();
  };
}

const PRECOMPRESSED_ENCODINGS = [["br", ".br"], ["gzip", ".gz"]] as const;

function preferredCopies<T extends { encoding: string }>(header: string, copies: readonly T[]): T[] {
  const quality = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    quality.set(name.trim(), q === undefined ? 1 : Number(q.slice(2)));
  }
  return copies
    .filter((copy) => (quality.get(copy.encoding) ?? 0) > 0)
    .sort((a, b) => (quality.get(b.encoding) ?? 0) - (quality.get(a.encoding) ?? 0));
}
