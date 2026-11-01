'use strict';

/**
 * Opt-out endpoint — the {OPT_OUT_URL} the CAN-SPAM footer points at.
 *
 * Serves a landing page (GET /opt-out?email=...) that records the opt-out in
 * the global suppression list and confirms it to the requester, plus a JSON
 * API (POST /opt-out) for programmatic use and a read-only list view
 * (GET /suppression-list) so Legal can verify the store directly.
 *
 * The endpoint is domain-independent: it binds to a host/port and is fronted
 * by the verified sending domain (P3) when that lands. The suppression logic
 * it calls is the same global store the send guard and import guard use, so a
 * suppression recorded here is enforced everywhere immediately.
 *
 * Public vs. internal surface. One origin serves two audiences, so the routes
 * are split:
 *   public  — /opt-out (the recipient's opt-out, which 15 U.S.C. 7704(4)(C)
 *             requires to be exercisable without friction) and /health liveness.
 *   internal— /send-preflight (the dispatch gate), /stop (the reply forwarder)
 *             and /suppression-list (the Legal verification view).
 *
 * The internal routes are gated on `CAN_SPAM_API_TOKEN` and fail *closed* when
 * it is unset: an unconfigured origin authorises nobody rather than everybody.
 * The suppressed set is a list of people who asked not to be contacted —
 * publishing it, or letting an unauthenticated caller probe it address by
 * address, hands that list to anyone who asks. `/health` keeps a bare liveness
 * answer for probes and only reveals the store path, count and fingerprint to
 * an authorised caller.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { SuppressionList, resolveStorePath } = require('./suppression.cjs');
const { preflight, recordStopReply, parseStopReply } = require('./preflight.cjs');

const PORT = Number(process.env.OPTOUT_PORT || 8787);
const HOST = process.env.OPTOUT_HOST || '127.0.0.1';
const API_TOKEN = process.env.CAN_SPAM_API_TOKEN || '';

const STORE_PATH = resolveStorePath();
const list = new SuppressionList(STORE_PATH);

/**
 * Sources an opt-out may be attributed to. The origin is public, so a
 * caller-supplied `source` is attacker-controlled input that is stored and
 * rendered back on the landing page. Constraining it to known values keeps
 * that string from carrying markup, and keeps the audit log meaningful.
 */
const ALLOWED_SOURCES = new Set(['opt-out-endpoint', 'stop-reply', 'operator-cli', 'import']);
const DEFAULT_SOURCE = 'opt-out-endpoint';

function resolveSource(value, fallback = DEFAULT_SOURCE) {
  return ALLOWED_SOURCES.has(value) ? value : fallback;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Constant-time token comparison. Compares digests so the check does not leak
 * the token's length or a matching prefix through response timing.
 */
function isAuthorized(req) {
  if (!API_TOKEN) return false;
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const presented = bearer || String(req.headers['x-can-spam-token'] || '').trim();
  if (!presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(API_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Gate an internal route. Returns null when the caller is authorised, or the
 * response to send instead. 503 (not 401) when no token is configured: that is
 * a deployment fault, and the send step's contract is "dispatch only on a 200
 * with ok:true", so it sends nothing either way.
 */
function requireToken(req, res) {
  if (isAuthorized(req)) return null;
  const unconfigured = !API_TOKEN;
  sendJson(res, unconfigured ? 503 : 401, {
    ok: false,
    reason: unconfigured ? 'api_token_unconfigured' : 'unauthorized',
    detail: unconfigured
      ? 'CAN_SPAM_API_TOKEN is not set on this origin, so no caller is authorised. Send nothing.'
      : 'Present the origin token as `Authorization: Bearer <CAN_SPAM_API_TOKEN>`.',
  });
  return true;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function landingPageHtml(email, result) {
  const escaped = escapeHtml(email);
  // Every interpolated value is escaped, including the entry's stored `source`
  // and `suppressedAt`. Those come back out of the store, and a public write
  // route is how a caller gets a string into the store in the first place.
  const source = escapeHtml(result.entry ? result.entry.source : 'web');
  const suppressedAt = escapeHtml(result.entry ? result.entry.suppressedAt : new Date().toISOString());
  const confirmed = result.added || result.already;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opt-out confirmed</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding:1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  .ok { color: #0a7d28; font-weight: 600; }
  .meta { color: #666; font-size: .9rem; margin-top: 1rem; }
  code { background:#f4f4f4; padding: .1rem .3rem; border-radius: 4px; }
</style>
</head>
<body>
<div class="card">
  <h1>${confirmed ? 'You have been removed from all lists' : 'Opt-out request received'}</h1>
  <p class="${confirmed ? 'ok' : ''}">${confirmed
    ? 'Your address <strong>' + escaped + '</strong> has been added to our global suppression list. It is removed from every list, permanently, and cannot be re-imported into any campaign.'
    : 'We could not process that address. Please reply "STOP" to any message instead.'}</p>
  <p class="meta">Recorded at ${suppressedAt} &middot; Source: ${source} &middot; List fingerprint: <code>${escapeHtml(list.fingerprint())}</code></p>
</div>
</body>
</html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e5) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Read a JSON request body that must be an object. `JSON.parse('null')` and
 * `JSON.parse('[1,2]')` both succeed, so reading a field off the result is the
 * only thing standing between a malformed body and a `TypeError` — and a throw
 * inside this async handler is an unhandled rejection, which takes the whole
 * origin down and with it the public opt-out page. A body that is not an object
 * is a 400.
 */
async function readJsonObject(req) {
  const raw = await readBody(req);
  const parsed = JSON.parse(raw || '{}');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('body must be a JSON object');
    err.invalidBody = true;
    throw err;
  }
  return parsed;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_err) {
    return sendJson(res, 400, { ok: false, reason: 'invalid_request_target' });
  }

  try {
    return await route(req, res, url);
  } catch (err) {
    // The handler is async and the origin is public: an unhandled throw here
    // becomes an unhandled rejection, which terminates the process. Answer
    // instead, and never let a handler failure read as a successful opt-out.
    process.stderr.write(`request failed ${req.method} ${url.pathname}: ${err.stack || err.message}\n`);
    if (res.headersSent) return res.end();
    return sendJson(res, 500, { ok: false, reason: 'internal_error' });
  }
});

async function route(req, res, url) {
  if (url.pathname === '/health') {
    // Liveness stays public and reveals nothing; the store path, count and
    // fingerprint are for the operator verifying the wiring, so they are
    // behind the token.
    if (!isAuthorized(req)) {
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 200, {
      ok: true,
      suppressed: list.count(),
      fingerprint: list.fingerprint(),
      store: STORE_PATH,
      storeReadable: list.isReadable(),
      apiTokenConfigured: Boolean(API_TOKEN),
    });
  }

  // Send preflight. Served by the same origin, from the same in-process store,
  // that serves {OPT_OUT_URL} — so the send step and the opt-out page cannot
  // drift onto two different lists. The send step calls this immediately
  // before dispatch, not once at batch start. Internal route: it answers "is
  // this address still allowed to be emailed", which is not public.
  if (url.pathname === '/send-preflight' && req.method === 'POST') {
    if (requireToken(req, res)) return;
    let body;
    try {
      body = await readJsonObject(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, reason: 'invalid_body', detail: err.message });
    }
    const recipients = Array.isArray(body.recipients)
      ? body.recipients
      : String(body.recipients || '').split(/[\s,;]+/).filter(Boolean);
    const report = preflight(recipients, { list, campaign: body.campaign ?? null });
    return sendJson(res, report.fatal ? 503 : 200, {
      ok: report.ok,
      fatal: report.fatal,
      exitCode: report.exitCode,
      audited: report.audited,
      auditError: report.auditError,
      storeReadable: report.storeReadable,
      storeError: report.storeError,
      storeFingerprint: report.storeFingerprint,
      campaign: report.campaign,
      checkedAt: report.checkedAt,
      allowed: report.allowed,
      blocked: report.blocked,
    });
  }

  // STOP / unsubscribe reply processing. Writes to the same global store the
  // preflight reads, so a reply opt-out takes effect on the very next dispatch.
  // Internal route: the sender address comes from the mailbox holder, so the
  // caller has to prove it holds that mailbox.
  if (url.pathname === '/stop') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
    }
    if (requireToken(req, res)) return;
    let body;
    try {
      body = await readJsonObject(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, reason: 'invalid_body', detail: err.message });
    }
    // A body is classified whenever one is supplied. The previous guard only
    // classified when `email` was absent, so a request carrying both an
    // address and a body skipped classification entirely and suppressed
    // whoever the address belonged to on the strength of an arbitrary body.
    if (Object.prototype.hasOwnProperty.call(body, 'body')) {
      const parsed = parseStopReply(body.body);
      if (!parsed.isStopRequest) {
        return sendJson(res, 422, { ok: false, reason: 'not_a_stop_request' });
      }
    }
    if (body.email === undefined) {
      return sendJson(res, 400, { ok: false, reason: 'missing_email' });
    }
    let result;
    try {
      result = recordStopReply(body.email, {
        list,
        source: resolveSource(body.source, 'stop-reply'),
        campaign: body.campaign ?? null,
      });
    } catch (err) {
      return sendJson(res, 503, { ok: false, reason: 'store_unavailable', detail: err.message });
    }
    if (!result.ok) {
      return sendJson(res, 422, { ok: false, reason: result.reason, email: result.email });
    }
    return sendJson(res, 200, {
      ok: true,
      added: result.added,
      already: result.already,
      suppressedAt: result.entry.suppressedAt,
      audited: result.audited,
      fingerprint: list.fingerprint(),
    });
  }

  // The Legal verification view. Internal: it is the full suppressed set.
  if (url.pathname === '/suppression-list') {
    if (requireToken(req, res)) return;
    return sendJson(res, 200, {
      count: list.count(),
      fingerprint: list.fingerprint(),
      entries: list.list(),
    });
  }

  if (url.pathname === '/opt-out') {
    let email = url.searchParams.get('email');
    if (req.method === 'POST') {
      try {
        const body = await readJsonObject(req);
        email = body.email || email;
      } catch (err) {
        return sendJson(res, 400, { ok: false, reason: 'invalid_body', detail: err.message });
      }
    }
    if (!email) {
      return sendJson(res, 400, { ok: false, reason: 'missing_email' });
    }
    let result;
    try {
      result = list.suppress(email, { source: DEFAULT_SOURCE });
    } catch (err) {
      // The opt-out could not be written. Never confirm it — a recipient told
      // "you have been removed" who then receives another email is the worst
      // outcome this control has. 503 + no confirmation, and the sender's
      // preflight keeps this address blocked until the store is repaired.
      return sendJson(res, 503, { ok: false, reason: 'store_unavailable', detail: err.message });
    }
    if (!result.ok) {
      return sendJson(res, 422, { ok: false, reason: result.reason, email: result.email });
    }
    const wantsJson = req.method === 'POST' || (req.headers.accept || '').includes('application/json');
    if (wantsJson) {
      return sendJson(res, 200, {
        ok: true,
        added: result.added,
        already: result.already,
        suppressedAt: result.entry.suppressedAt,
        fingerprint: list.fingerprint(),
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(landingPageHtml(email, result));
  }

  return sendJson(res, 404, { ok: false, reason: 'not_found' });
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`opt-out endpoint listening on http://${HOST}:${PORT}\n`);
    process.stdout.write(`  public:        http://${HOST}:${PORT}/opt-out?email=you@example.com\n`);
    process.stdout.write(`  public json:   POST http://${HOST}:${PORT}/opt-out  {email}\n`);
    process.stdout.write(
      API_TOKEN
        ? `  internal:      /send-preflight, /stop, /suppression-list  (Authorization: Bearer <CAN_SPAM_API_TOKEN>)\n`
        : `  WARNING:       CAN_SPAM_API_TOKEN is not set — /send-preflight, /stop and /suppression-list will refuse every caller (503)\n`
    );
  });
}

module.exports = { server, list, isAuthorized, ALLOWED_SOURCES };
