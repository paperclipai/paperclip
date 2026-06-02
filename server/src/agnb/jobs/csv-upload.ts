import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * csv-upload — ported from agnb api/internal/csv-upload.
 *
 * The agnb route was request-triggered: a signed-in user POSTed
 * { uploadId, filename, csvText }, the route minted a Rocket SDR signed S3
 * URL, PUT the bytes, and flipped the agnb.csv_uploads row to "ready".
 *
 * In the scheduler there is no inbound file/blob and no in-process
 * equivalent for the browser-driven upload, so this job ports only the
 * DB-processing half: it scans for csv_uploads rows that are stuck in a
 * non-terminal state and reports them. The actual Rocket mint + S3 PUT is
 * left as a no-op.
 *
 * // PHASE 5: wire the upload trigger (Rocket get_csv_upload_url + S3 PUT)
 * // once a server-side blob source exists. For now the upload itself is a
 * // no-op; this job only surfaces rows awaiting processing.
 */
export async function csvUpload(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;

  // DB-processing part: surface uploads not yet in a terminal state so the
  // operator (or a future PHASE 5 worker) can act on them.
  const pending = rows<{ id: string; filename: string; status: string; uploaded_at: string }>(
    await db.execute(sql`
      SELECT id, filename, status, uploaded_at
      FROM agnb.csv_uploads
      WHERE status NOT IN ('ready', 'failed')
      ORDER BY uploaded_at ASC
      LIMIT 50
    `)
  );

  // PHASE 5: upload-trigger is a no-op (no in-process blob source). When the
  // Rocket pipe is reintroduced, mint a signed URL + PUT csvText here and
  // flip status to 'ready' / 'failed'.
  if (pending.length === 0) {
    return { ok: true, processed: 0, summary: "no pending csv uploads" };
  }

  ctx.log("csv uploads pending (upload-trigger no-op — PHASE 5)", {
    count: pending.length,
    ids: pending.map((p) => p.id),
  });

  return {
    ok: true,
    processed: 0,
    pending: pending.length,
    pending_ids: pending.map((p) => p.id),
    summary: `${pending.length} pending uploads (upload-trigger no-op — PHASE 5)`,
  };
}
