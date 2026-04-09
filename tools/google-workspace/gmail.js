#!/usr/bin/env node
// Gmail CLI — search, read, send, drafts, labels
// Uses GWS_SERVICE_ACCOUNT_JSON + GWS_SUBJECT_EMAIL for auth (DWD)
// Zero external dependencies — Node.js only

import crypto from 'node:crypto';
import https from 'node:https';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const SA_JSON = process.env.GWS_SERVICE_ACCOUNT_JSON;
const SUBJECT = process.env.GWS_SUBJECT_EMAIL || '';
const SCOPES = 'https://mail.google.com/';

if (!SA_JSON) { console.error(JSON.stringify({ error: 'GWS_SERVICE_ACCOUNT_JSON env required' })); process.exit(1); }

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getToken() {
  const sa = JSON.parse(SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: sa.client_email, sub: SUBJECT || sa.client_email,
    scope: SCOPES, aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = base64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), sa.private_key));
  const jwt = `${header}.${payload}.${sig}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
    }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        try { const p = JSON.parse(data); p.access_token ? resolve(p.access_token) : reject(new Error(data)); }
        catch { reject(new Error(data)); }
      });
    });
    req.write(body); req.end();
  });
}

async function api(method, path, body, params) {
  const token = await getToken();
  let url = `${GMAIL_API}/${path}`;
  if (params) url += '?' + new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: res.status, body: text }; }
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { result[key] = next; i++; } else { result[key] = true; }
    } else { result._.push(arg); }
  }
  return result;
}

function encodeMessage(to, subject, body, opts = {}) {
  const lines = [];
  if (opts.from) lines.push(`From: ${opts.from}`);
  lines.push(`To: ${to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: ${opts.html ? 'text/html' : 'text/plain'}; charset=utf-8`);
  lines.push(''); lines.push(body);
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

function extractBody(payload) {
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      if (part.parts) { const r = extractBody(part); if (r) return r; }
    }
  }
  return '';
}

const args = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = args._;

async function main() {
  let result;
  switch (cmd) {
    case 'search': {
      const params = { maxResults: args.limit || '10' };
      if (rest[0]) params.q = rest[0];
      if (args.label) params.labelIds = args.label;
      if (args['include-spam-trash']) params.includeSpamTrash = 'true';
      if (args['page-token']) params.pageToken = args['page-token'];
      result = await api('GET', 'users/me/messages', null, params);
      break;
    }
    case 'get': {
      const msgId = rest[0]; if (!msgId) { result = { error: 'message_id required' }; break; }
      const fmt = args.format || 'full';
      const raw = await api('GET', `users/me/messages/${msgId}`, null, { format: fmt });
      if (raw.error) { result = raw; break; }
      if (fmt === 'full' || fmt === 'metadata') {
        const hdrs = raw.payload?.headers || [];
        const hdr = (n) => hdrs.find(h => h.name === n)?.value;
        result = { id: raw.id, threadId: raw.threadId, labelIds: raw.labelIds, snippet: raw.snippet,
          subject: hdr('Subject'), from: hdr('From'), to: hdr('To'), date: hdr('Date'),
          body: fmt === 'full' ? extractBody(raw.payload) : undefined };
      } else { result = raw; }
      break;
    }
    case 'send': {
      if (!args.to || !args.subject || !args.body) { result = { error: '--to, --subject, --body required' }; break; }
      const raw = encodeMessage(args.to, args.subject, args.body, { cc: args.cc, bcc: args.bcc, html: args.html, from: args.from });
      result = await api('POST', 'users/me/messages/send', { raw });
      if (result.id) result.status = 'sent';
      break;
    }
    case 'create-draft': {
      if (!args.to || !args.subject || !args.body) { result = { error: '--to, --subject, --body required' }; break; }
      const raw = encodeMessage(args.to, args.subject, args.body, { cc: args.cc, bcc: args.bcc, html: args.html, from: args.from });
      result = await api('POST', 'users/me/drafts', { message: { raw } });
      if (result.id) result.status = 'draft_created';
      break;
    }
    case 'send-draft': {
      const draftId = rest[0]; if (!draftId) { result = { error: 'draft_id required' }; break; }
      result = await api('POST', 'users/me/drafts/send', { id: draftId });
      if (result.id) result.status = 'sent';
      break;
    }
    case 'modify': {
      const msgId = rest[0]; if (!msgId) { result = { error: 'message_id required' }; break; }
      const data = {};
      if (args['add-label']) data.addLabelIds = [args['add-label']];
      if (args['remove-label']) data.removeLabelIds = [args['remove-label']];
      result = await api('POST', `users/me/messages/${msgId}/modify`, data);
      if (result.id) result.status = 'modified';
      break;
    }
    case 'list-labels': {
      result = await api('GET', 'users/me/labels');
      break;
    }
    default:
      result = { usage: {
        search: 'search [query] [--limit N] [--label LABEL] [--include-spam-trash] [--page-token TOKEN]',
        get: 'get MESSAGE_ID [--format full|metadata|minimal]',
        send: 'send --to ADDR --subject SUBJ --body BODY [--cc CC] [--bcc BCC] [--html] [--from ALIAS]',
        'create-draft': 'create-draft --to ADDR --subject SUBJ --body BODY [--cc CC] [--bcc BCC] [--html]',
        'send-draft': 'send-draft DRAFT_ID',
        modify: 'modify MESSAGE_ID [--add-label LABEL] [--remove-label LABEL]',
        'list-labels': 'list-labels',
      }};
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(err => { console.error(JSON.stringify({ error: err.message })); process.exit(1); });
