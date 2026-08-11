import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from './server.js';

// The review UI talks only to the core Paperclip API over HTTP; there is no
// direct database access and no local reviewer allowlist. These tests stub
// `fetch` to stand in for the core API.

const CORE = 'http://core.test';
const AGENT_ID = 'agent-123';
const COMPANY_ID = 'company-abc';

type StubResponse = { status: number; body: unknown };

/**
 * Route the two classes of call the server makes: `/api/agents/me` (auth) and
 * the company-scoped enrichment endpoints. `onCore` receives the resolved
 * enrichment sub-path (after `/enrichment`) plus the request init so a test can
 * assert forwarding and choose a response.
 */
function stubFetch(opts: {
  me?: StubResponse;
  onCore?: (path: string, init: RequestInit | undefined) => StubResponse;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/agents/me')) {
      const me = opts.me ?? { status: 200, body: { id: AGENT_ID, companyId: COMPANY_ID } };
      return new Response(JSON.stringify(me.body), { status: me.status });
    }
    const marker = '/enrichment';
    const idx = url.indexOf(marker);
    const sub = idx >= 0 ? url.slice(idx + marker.length) : url;
    const res = opts.onCore
      ? opts.onCore(sub, init)
      : { status: 200, body: {} };
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof fetch;
  return calls;
}

function bearerReq(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: 'Bearer tok', ...(init.headers ?? {}) },
  });
}

describe('review-ui server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_API_URL = CORE;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_API_URL;
  });

  describe('auth middleware', () => {
    it('returns 401 when no Authorization header', async () => {
      stubFetch({});
      const app = createApp();
      const res = await app.fetch(new Request('http://localhost/api/batches'));
      expect(res.status).toBe(401);
    });

    it('returns 401 when the core API rejects the token', async () => {
      stubFetch({ me: { status: 401, body: {} } });
      const app = createApp();
      const res = await app.fetch(bearerReq('/api/batches'));
      expect(res.status).toBe(401);
    });

    it('forwards a 403 from the core API (no local allowlist)', async () => {
      stubFetch({ me: { status: 403, body: {} } });
      const app = createApp();
      const res = await app.fetch(bearerReq('/api/batches'));
      expect(res.status).toBe(403);
    });

    it('passes through for a valid agent token', async () => {
      stubFetch({ onCore: () => ({ status: 200, body: { batches: [] } }) });
      const app = createApp();
      const res = await app.fetch(bearerReq('/api/batches'));
      expect(res.status).toBe(200);
    });
  });

  describe('company scoping and forwarding', () => {
    it('normalizes the core camelCase batch response for the browser UI', async () => {
      stubFetch({
        onCore: () => ({
          status: 200,
          body: { batches: [{ batchId: 'batch-1', rowCount: 12, flaggedCount: 3, approvedCount: 5 }] },
        }),
      });
      const app = createApp();
      const res = await app.fetch(bearerReq('/api/batches'));
      expect(await res.json()).toEqual({
        batches: [{ batch_id: 'batch-1', row_count: 12, flagged_count: 3, approved_count: 5 }],
      });
    });

    it('derives companyId from the agent and forwards the bearer token', async () => {
      const calls = stubFetch({ onCore: () => ({ status: 200, body: { batches: [{ batchId: 'b1', rowCount: 0, flaggedCount: 0, approvedCount: 0 }] } }) });
      const app = createApp();
      const res = await app.fetch(bearerReq('/api/batches'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ batches: [{ batch_id: 'b1', row_count: 0, flagged_count: 0, approved_count: 0 }] });

      const coreCall = calls.find((c) => c.url.includes('/enrichment/batches'));
      expect(coreCall?.url).toBe(`${CORE}/api/companies/${COMPANY_ID}/enrichment/batches`);
      expect((coreCall?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    });

    it('maps core staging rows into the UI shape with derived is_flagged', async () => {
      stubFetch({
        onCore: (path) => {
          expect(path).toBe('/staging?batchId=batch-1');
          return {
            status: 200,
            body: {
              rows: [
                { id: 'r1', sourceRowId: 's1', anomalyScore: '0.9000', reviewerVerdict: null, humanApprovedAt: null, humanApprovedBy: null, primaryOutputJson: {}, fallbackOutputJson: null, validatorResult: null },
                { id: 'r2', sourceRowId: 's2', anomalyScore: '0.1000', reviewerVerdict: null, humanApprovedAt: null, humanApprovedBy: null, primaryOutputJson: {}, fallbackOutputJson: null, validatorResult: null },
              ],
            },
          };
        },
      });
      const app = createApp();
      const res = await app.fetch(bearerReq('/api/staging?batch_id=batch-1'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: Array<{ id: string; is_flagged: boolean; source_row_id: string }> };
      expect(body.rows).toHaveLength(2);
      expect(body.rows[0]).toMatchObject({ id: 'r1', source_row_id: 's1', is_flagged: true });
      expect(body.rows[1]).toMatchObject({ id: 'r2', is_flagged: false });
    });

    it('propagates the flagged filter to the core API', async () => {
      const calls = stubFetch({ onCore: () => ({ status: 200, body: { rows: [] } }) });
      const app = createApp();
      await app.fetch(bearerReq('/api/staging?batch_id=batch-1&flagged=true'));
      const coreCall = calls.find((c) => c.url.includes('/enrichment/staging'));
      expect(coreCall?.url).toContain('batchId=batch-1');
      expect(coreCall?.url).toContain('flagged=true');
    });

    it('returns 400 when batch_id is missing on staging', async () => {
      stubFetch({});
      const app = createApp();
      const res = await app.fetch(bearerReq('/api/staging'));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/batch_id/);
    });

    it('forwards the core status on approve (e.g. 404 for an already-reviewed row)', async () => {
      const calls = stubFetch({ onCore: () => ({ status: 404, body: { error: 'Row not found or already reviewed' } }) });
      const app = createApp();
      const res = await app.fetch(bearerReq('/api/staging/row-1/approve', { method: 'POST' }));
      expect(res.status).toBe(404);
      const coreCall = calls.find((c) => c.url.includes('/enrichment/staging/'));
      expect(coreCall?.url).toBe(`${CORE}/api/companies/${COMPANY_ID}/enrichment/staging/row-1/approve`);
      expect(coreCall?.init?.method).toBe('POST');
    });

    it('forwards the rejection reason on reject', async () => {
      const calls = stubFetch({ onCore: () => ({ status: 200, body: { ok: true } }) });
      const app = createApp();
      const res = await app.fetch(
        bearerReq('/api/staging/row-1/reject', {
          method: 'POST',
          body: JSON.stringify({ reason: 'bad value' }),
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(res.status).toBe(200);
      const coreCall = calls.find((c) => c.url.includes('/reject'));
      expect(JSON.parse(String(coreCall?.init?.body))).toEqual({ reason: 'bad value' });
    });

    it('forwards bulk-approve to the company batch endpoint', async () => {
      const calls = stubFetch({ onCore: () => ({ status: 200, body: { ok: true, approved_count: 3 } }) });
      const app = createApp();
      const res = await app.fetch(bearerReq('/api/batches/batch-1/bulk-approve', { method: 'POST' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, approved_count: 3 });
      const coreCall = calls.find((c) => c.url.includes('/bulk-approve'));
      expect(coreCall?.url).toBe(`${CORE}/api/companies/${COMPANY_ID}/enrichment/batches/batch-1/bulk-approve`);
    });
  });
});
