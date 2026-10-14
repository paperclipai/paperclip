import compression from "compression";
import type { RequestHandler } from "express";
import { constants } from "node:zlib";

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
