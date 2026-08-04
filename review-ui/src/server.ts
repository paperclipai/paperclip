import { Hono } from 'hono';
import { pool } from './db.js';
import { authMiddleware } from './auth.js';
import { renderReviewPage } from './html.js';

type Variables = { agentId: string };

export function createApp(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // Static HTML shell is served without auth so the browser can load it and
  // then acquire a token via the login form (which then calls the API).
  app.get('/', (c) => c.redirect('/review'));
  app.get('/review', (c) => c.html(renderReviewPage()));

  // All /api/* routes require a valid Paperclip bearer token in the allowlist.
  app.use('/api/*', authMiddleware);

  // GET /api/batches — list all batch IDs with counts
  app.get('/api/batches', async (c) => {
    const { rows } = await pool.query<{
      batch_id: string;
      row_count: string;
      flagged_count: string;
      approved_count: string;
    }>(`
      SELECT
        batch_id::text,
        COUNT(*)::text                                              AS row_count,
        SUM(CASE WHEN is_flagged THEN 1 ELSE 0 END)::text          AS flagged_count,
        SUM(CASE WHEN human_approved_at IS NOT NULL THEN 1 ELSE 0 END)::text AS approved_count
      FROM enrichment_staging.enrichment_staging_review_view
      GROUP BY batch_id
      ORDER BY batch_id
    `);
    return c.json({ batches: rows });
  });

  // GET /api/staging?batch_id=<uuid>[&flagged=true]
  app.get('/api/staging', async (c) => {
    const batchId = c.req.query('batch_id');
    if (!batchId) return c.json({ error: 'batch_id is required' }, 400);

    const flaggedOnly = c.req.query('flagged') === 'true';
    const params: unknown[] = [batchId];
    let sql = `
      SELECT *
      FROM enrichment_staging.enrichment_staging_review_view
      WHERE batch_id = $1
    `;
    if (flaggedOnly) sql += ` AND is_flagged = true`;
    sql += ` ORDER BY anomaly_score DESC NULLS LAST, id`;

    const { rows } = await pool.query(sql, params);
    return c.json({ rows });
  });

  // POST /api/staging/:id/approve
  app.post('/api/staging/:id/approve', async (c) => {
    const id = c.req.param('id');
    const agentId = c.get('agentId');

    const result = await pool.query(
      `UPDATE enrichment_staging.enrichment_staging
       SET human_approved_at = NOW(),
           human_approved_by = $2,
           reviewer_verdict  = 'approved'
       WHERE id = $1 AND human_approved_at IS NULL`,
      [id, agentId],
    );
    if ((result.rowCount ?? 0) === 0) {
      return c.json({ error: 'Row not found or already reviewed' }, 404);
    }
    return c.json({ ok: true });
  });

  // POST /api/staging/:id/reject  — body: { reason?: string }
  app.post('/api/staging/:id/reject', async (c) => {
    const id = c.req.param('id');
    const agentId = c.get('agentId');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}));
    const verdict = body.reason?.trim()
      ? `rejected: ${body.reason.trim()}`
      : 'rejected';

    await pool.query(
      `UPDATE enrichment_staging.enrichment_staging
       SET human_approved_at = NOW(),
           human_approved_by = $2,
           reviewer_verdict  = $3
       WHERE id = $1`,
      [id, agentId, verdict],
    );
    return c.json({ ok: true });
  });

  // POST /api/batches/:batch_id/bulk-approve
  // Approves all clean (unflagged), unapproved rows in the batch.
  // Uses a subquery on the view so the flagged logic stays DRY.
  app.post('/api/batches/:batch_id/bulk-approve', async (c) => {
    const batchId = c.req.param('batch_id');
    const agentId = c.get('agentId');

    const result = await pool.query(
      `UPDATE enrichment_staging.enrichment_staging
       SET human_approved_at = NOW(),
           human_approved_by = $2,
           reviewer_verdict  = 'approved'
       WHERE id IN (
           SELECT id
           FROM   enrichment_staging.enrichment_staging_review_view
           WHERE  batch_id          = $1
             AND  is_flagged        = false
             AND  human_approved_at IS NULL
       )`,
      [batchId, agentId],
    );
    return c.json({ ok: true, approved_count: result.rowCount ?? 0 });
  });

  return app;
}
