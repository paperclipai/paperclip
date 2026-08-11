import type { Context, Next } from 'hono';

/**
 * Base URL of the Paperclip core API. Required — no hostname is baked in so the
 * review UI stays portable and never falls back to a private internal endpoint.
 */
export function coreApiBaseUrl(): string {
  const url = process.env.PAPERCLIP_API_URL?.trim();
  if (!url) {
    throw new Error('PAPERCLIP_API_URL is required (base URL of the Paperclip core API)');
  }
  return url.replace(/\/+$/, '');
}

/**
 * Verifies the caller's bearer token against the core API and captures the
 * agent identity it resolves to. There is no local allowlist: the core company
 * API's own authz/company-access decides what the token may do, and every
 * downstream call forwards this same token.
 */
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
  let companyId: string;
  try {
    const res = await fetch(`${coreApiBaseUrl()}/api/agents/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) {
      return c.json({ error: 'Forbidden — token rejected by Paperclip' }, 403);
    }
    if (!res.ok) {
      return c.json({ error: 'Unauthorized — token rejected by Paperclip' }, 401);
    }
    const body = (await res.json()) as { id?: string; companyId?: string };
    if (!body.id || !body.companyId) {
      return c.json({ error: 'Unauthorized — incomplete agent identity' }, 401);
    }
    agentId = body.id;
    companyId = body.companyId;
  } catch {
    return c.json({ error: 'Auth service unavailable' }, 503);
  }

  c.set('agentId', agentId);
  c.set('companyId', companyId);
  c.set('token', token);
  await next();
}
