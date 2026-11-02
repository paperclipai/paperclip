import compression from "compression";
import type { RequestHandler } from "express";
import { constants } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

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
  const root = path.resolve(assetsDir);
  return (req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.headers.range) return next();
    let relative: string;
    try {
      relative = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (relative.includes("\0")) return next();
    const file = path.resolve(root, `.${relative}`);
    if (!file.startsWith(root + path.sep)) return next();
    const accepted = String(req.headers["accept-encoding"] ?? "");
    for (const [encoding, extension] of PRECOMPRESSED_ENCODINGS) {
      if (!acceptsEncoding(accepted, encoding)) continue;
      const candidate = file + extension;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Content-Length", String(stat.size));
      res.type(path.extname(file));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(candidate).on("error", next).pipe(res);
      return;
    }
    next();
  };
}

const PRECOMPRESSED_ENCODINGS = [["br", ".br"], ["gzip", ".gz"]] as const;

function acceptsEncoding(header: string, encoding: string): boolean {
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name !== encoding) return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}
