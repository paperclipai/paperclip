#!/usr/bin/env node
// Generates a short-lived OAuth2 access token from a Google service account JSON key.
// Uses only node:crypto — zero external dependencies.
// Usage: node gws-token.js [scope1,scope2,...]
// Outputs just the access token string to stdout.

import crypto from 'node:crypto';
import https from 'node:https';

const saJson = process.env.GWS_SERVICE_ACCOUNT_JSON;
const subject = process.env.GWS_SUBJECT_EMAIL || '';
const scopes = process.argv[2] || 'https://www.googleapis.com/auth/analytics.readonly';

if (!saJson) { console.error('GWS_SERVICE_ACCOUNT_JSON env required'); process.exit(1); }

const sa = JSON.parse(saJson);

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const payload = base64url(JSON.stringify({
  iss: sa.client_email,
  sub: subject || sa.client_email,
  scope: scopes,
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 3600,
}));

const signature = base64url(
  crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), sa.private_key)
);

const jwt = `${header}.${payload}.${signature}`;
const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

const req = https.request('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.access_token) { console.log(parsed.access_token); }
      else { console.error(JSON.stringify(parsed)); process.exit(1); }
    } catch { console.error(data); process.exit(1); }
  });
});
req.write(body);
req.end();
