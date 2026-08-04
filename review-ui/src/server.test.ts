import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from './server.js';

// ── DB stub ──────────────────────────────────────────────────────────────────
vi.mock('./db.js', () => ({
  pool: {
    query: vi.fn(),
  },
}));

// ── Auth: Paperclip API stub ─────────────────────────────────────────────────
// CEO agent ID that matches the default allowlist in auth.ts
const CEO_ID = 'b0f67cc2-259e-477b-ac89-d0ff4e7c8e89';
const STRANGER_ID = 'deadbeef-0000-0000-0000-000000000000';

function mockPaperclipAgent(agentId: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id: agentId }),
  } as unknown as Response);
}

function mockPaperclipUnauthorized() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    json: async () => ({}),
  } as unknown as Response);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function bearerReq(agentId?: string): Request {
  return new Request('http://localhost/api/batches', {
    headers: agentId
      ? { Authorization: `Bearer token-for-${agentId}` }
      : {},
  });
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when no Authorization header', async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request('http://localhost/api/batches'),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when Paperclip API rejects the token', async () => {
    mockPaperclipUnauthorized();
    const app = createApp();
    const res = await app.fetch(bearerReq(CEO_ID));
    expect(res.status).toBe(401);
  });

  it('returns 403 when agent is not in the allowlist', async () => {
    mockPaperclipAgent(STRANGER_ID);
    const app = createApp();
    const res = await app.fetch(bearerReq(STRANGER_ID));
    expect(res.status).toBe(403);
  });

  it('passes through for an allowed agent', async () => {
    mockPaperclipAgent(CEO_ID);
    const { pool } = await import('./db.js');
    // @ts-expect-error vitest mock
    pool.query.mockResolvedValue({ rows: [] });
    const app = createApp();
    const res = await app.fetch(bearerReq(CEO_ID));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/staging input validation', () => {
  it('returns 400 when batch_id is missing', async () => {
    mockPaperclipAgent(CEO_ID);
    const app = createApp();
    const res = await app.fetch(
      new Request('http://localhost/api/staging', {
        headers: { Authorization: 'Bearer tok' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/batch_id/);
  });
});
