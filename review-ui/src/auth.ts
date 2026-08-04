import type { Context, Next } from 'hono';

// CEO: b0f67cc2-259e-477b-ac89-d0ff4e7c8e89
// SSI Director: 7cc4dafd-b41f-469c-b8ea-7b4110a11fe8
const DEFAULT_ALLOWED =
  'b0f67cc2-259e-477b-ac89-d0ff4e7c8e89,7cc4dafd-b41f-469c-b8ea-7b4110a11fe8';

const ALLOWED_AGENT_IDS = new Set(
  (process.env.REVIEW_ALLOWED_AGENT_IDS ?? DEFAULT_ALLOWED)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const PAPERCLIP_API_URL =
  process.env.PAPERCLIP_API_URL ?? 'http://127.0.0.1:3101';

export async function authMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const authHeader = c.req.header('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized — Bearer token required' }, 401);
  }
  const token = authHeader.slice(7);

  let agentId: string;
  try {
    const res = await fetch(`${PAPERCLIP_API_URL}/api/agents/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return c.json({ error: 'Unauthorized — token rejected by Paperclip' }, 401);
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) {
      return c.json({ error: 'Unauthorized — no agent id in response' }, 401);
    }
    agentId = body.id;
  } catch {
    return c.json({ error: 'Auth service unavailable' }, 503);
  }

  if (!ALLOWED_AGENT_IDS.has(agentId)) {
    return c.json({ error: 'Forbidden — agent not in reviewer allowlist' }, 403);
  }

  c.set('agentId', agentId);
  await next();
}
