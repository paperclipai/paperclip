// Shared request body-parser stack, mounted by createApp on BOTH the API tier
// and the worker tier. Kept in its own express-only module (no DB / app deps)
// so it can be unit-tested in isolation.
//
// Why three parsers, all capturing rawBody:
//   - Provider webhooks (Slack, Linear) sign the EXACT request bytes. The
//     API->worker reverse proxy forwards req.rawBody verbatim so the HMAC
//     signature still verifies on the worker tier. Anything that re-serializes
//     the parsed body (JSON.stringify(req.body)) corrupts the signed bytes.
//   - Slack interactivity (button clicks) is application/x-www-form-urlencoded
//     (`payload=<urlencoded-json>`), so express.urlencoded is required or
//     req.body stays {} and the interactivity handler (which reads
//     req.body.payload) never fires.
//   - The express.raw({type:"*/*"}) catch-all guarantees req.rawBody is
//     captured for EVERY content-type. Without it, a future webhook arriving
//     with a content-type neither json nor urlencoded handles would fall
//     through with no rawBody and silently re-break signature verification.
//     body-parser 2.x skips already-consumed streams via onFinished.isFinished
//     (NOT a req._body flag), so the catch-all only acts when json/urlencoded
//     did not — it never double-parses or clobbers a parsed req.body.

import express from "express";
import {
  DEFAULT_JSON_BODY_LIMIT,
  PORTABLE_JSON_BODY_LIMIT,
} from "./body-limits.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";

/** Stash the exact request bytes so downstream code can verify provider HMACs. */
function captureRawBody(
  req: express.Request,
  _res: express.Response,
  buf: Buffer,
): void {
  (req as unknown as { rawBody: Buffer }).rawBody = buf;
}

/**
 * Mount the body-parser middleware stack on `app`. Order matters:
 *   1. company-import path gets a larger JSON limit (mounted first, path-scoped)
 *   2. global JSON
 *   3. global urlencoded (form bodies → req.body, e.g. Slack interactivity)
 *   4. raw catch-all (captures rawBody for any other content-type)
 * Every parser captures req.rawBody via the same verify hook.
 */
export function registerBodyParsers(app: express.Express): void {
  app.use(
    COMPANY_IMPORT_API_PATH,
    express.json({ limit: PORTABLE_JSON_BODY_LIMIT, verify: captureRawBody }),
  );
  app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT, verify: captureRawBody }));
  app.use(
    express.urlencoded({
      extended: false,
      limit: DEFAULT_JSON_BODY_LIMIT,
      verify: captureRawBody,
    }),
  );
  app.use(
    express.raw({
      type: "*/*",
      limit: DEFAULT_JSON_BODY_LIMIT,
      verify: captureRawBody,
    }),
  );
}
