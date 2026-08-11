import { Hono } from 'hono';
import type { Context } from 'hono';
import { authMiddleware, coreApiBaseUrl } from './auth.js';
import { renderReviewPage } from './html.js';

type Variables = { agentId: string; companyId: string; token: string };

// Display-only mirror of the core API's FLAG_THRESHOLD. The core owns the
// authoritative flag logic (and the server-side `flagged` filter); this derives
// the per-row badge the static UI renders. Keep in step with the server const.
const FLAG_THRESHOLD = 0.5;

type CoreStagingRow = {
  id: string;
  sourceRowId: string;
  anomalyScore: string | null;
  reviewerVerdict: string | null;
  humanApprovedAt: string | null;
  humanApprovedBy: string | null;
  primaryOutputJson: unknown;
  fallbackOutputJson: unknown;
  validatorResult: unknown;
};

type CoreBatch = {
  batchId: string;
  rowCount: number;
  flaggedCount: number;
  approvedCount: number;
};

/** Reshape a core batch summary into the field names used by the browser UI. */
function toReviewBatch(batch: CoreBatch) {
  return {
    batch_id: batch.batchId,
    row_count: batch.rowCount,
    flagged_count: batch.flaggedCount,
    approved_count: batch.approvedCount,
  };
}

/** Reshape a core (camelCase) staging row into the shape the static UI expects. */
function toReviewRow(row: CoreStagingRow) {
  const score = row.anomalyScore == null ? null : Number(row.anomalyScore);
  return {
    id: row.id,
    source_row_id: row.sourceRowId,
    anomaly_score: row.anomalyScore,
    is_flagged: score != null && score >= FLAG_THRESHOLD,
    reviewer_verdict: row.reviewerVerdict,
    human_approved_at: row.humanApprovedAt,
    human_approved_by: row.humanApprovedBy,
    primary_output_json: row.primaryOutputJson,
    fallback_output_json: row.fallbackOutputJson,
    validator_result: row.validatorResult,
    // The company-scoped model retains no raw source payload column.
    source_payload_json: null,
  };
}

/** Server-to-server call to the core API forwarding the caller's bearer token. */
function coreFetch(c: Context<{ Variables: Variables }>, path: string, init: RequestInit = {}) {
  return fetch(`${coreApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${c.get('token')}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export function createApp(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // Static HTML shell is served without auth so the browser can load it and
  // then acquire a token via the login form (which then calls the API).
  app.get('/', (c) => c.redirect('/review'));
  app.get('/review', (c) => c.html(renderReviewPage()));

  // All /api/* routes require a valid Paperclip bearer token; the core company
  // API enforces which enrichment data that token may see and mutate.
  app.use('/api/*', authMiddleware);

  const enrichmentBase = (c: Context<{ Variables: Variables }>) =>
    `/api/companies/${c.get('companyId')}/enrichment`;

  // GET /api/batches — batch summaries for the caller's company.
  app.get('/api/batches', async (c) => {
    const res = await coreFetch(c, `${enrichmentBase(c)}/batches`);
    const body = (await res.json()) as { batches?: CoreBatch[] };
    return c.json({ batches: (body.batches ?? []).map(toReviewBatch) }, res.ok ? 200 : (res.status as 400));
  });

  // GET /api/staging?batch_id=<uuid>[&flagged=true]
  app.get('/api/staging', async (c) => {
    const batchId = c.req.query('batch_id');
    if (!batchId) return c.json({ error: 'batch_id is required' }, 400);

    const flaggedOnly = c.req.query('flagged') === 'true';
    const query = new URLSearchParams({ batchId });
    if (flaggedOnly) query.set('flagged', 'true');

    const res = await coreFetch(c, `${enrichmentBase(c)}/staging?${query.toString()}`);
    if (!res.ok) return c.json(await res.json(), res.status as 400);
    const body = (await res.json()) as { rows?: CoreStagingRow[] };
    return c.json({ rows: (body.rows ?? []).map(toReviewRow) });
  });

  // POST /api/staging/:id/approve
  app.post('/api/staging/:id/approve', async (c) => {
    const id = c.req.param('id');
    const res = await coreFetch(c, `${enrichmentBase(c)}/staging/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
    });
    return c.json(await res.json(), res.status as 200);
  });

  // POST /api/staging/:id/reject  — body: { reason?: string }
  app.post('/api/staging/:id/reject', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    const res = await coreFetch(c, `${enrichmentBase(c)}/staging/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: body.reason }),
    });
    return c.json(await res.json(), res.status as 200);
  });

  // POST /api/batches/:batch_id/bulk-approve
  app.post('/api/batches/:batch_id/bulk-approve', async (c) => {
    const batchId = c.req.param('batch_id');
    const res = await coreFetch(c, `${enrichmentBase(c)}/batches/${encodeURIComponent(batchId)}/bulk-approve`, {
      method: 'POST',
    });
    return c.json(await res.json(), res.status as 200);
  });

  return app;
}
