#!/usr/bin/env node
/**
 * Cheap Higgsfield headless-API credential verifier for Paperclip CMO.
 *
 * Verifies that HF_CREDENTIALS / HF_KEY / HF_API_KEY+HF_API_SECRET are present
 * and that the Higgsfield v2 API is reachable/authenticated. It intentionally
 * sends an invalid empty-prompt request so a 400/422 validation error counts as
 * success while avoiding real media generation.
 *
 * No npm dependencies required; this mirrors the official v2 SDK request shape:
 *   POST https://platform.higgsfield.ai/<endpoint>
 *   Authorization: Key KEY_ID:KEY_SECRET
 */

import https from 'node:https';

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function credential() {
  if (process.env.HF_CREDENTIALS) return process.env.HF_CREDENTIALS;
  if (process.env.HF_KEY) return process.env.HF_KEY;
  if (process.env.HF_API_KEY && process.env.HF_API_SECRET) {
    return `${process.env.HF_API_KEY}:${process.env.HF_API_SECRET}`;
  }
  return '';
}

function postJson(url, body, headers = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'nbos-cmo-higgsfield-verify/1.0',
        ...headers,
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const creds = credential();
  const baseURL = argValue('--base-url', 'https://platform.higgsfield.ai').replace(/\/$/, '');
  const endpoint = argValue('--endpoint', 'flux-pro/kontext/max/text-to-image').replace(/^\//, '');

  if (!creds || !creds.includes(':')) {
    console.error('FAIL: missing Higgsfield credentials. Set HF_CREDENTIALS="KEY_ID:KEY_SECRET" or HF_API_KEY + HF_API_SECRET.');
    process.exit(2);
  }

  const url = `${baseURL}/${endpoint}`;
  const response = await postJson(url, {
    prompt: '',
    aspect_ratio: '16:9',
  }, {
    Authorization: `Key ${creds}`,
  });

  const body = response.body || '';
  const lower = body.toLowerCase();

  if (response.status === 400 || response.status === 422 || lower.includes('prompt') || lower.includes('validation')) {
    console.log('SUCCESS: Higgsfield credentials are present and API is reachable.');
    console.log(`Evidence: expected validation failure HTTP ${response.status}: ${body.slice(0, 220)}`);
    process.exit(0);
  }

  if (response.status === 403 && (lower.includes('not_enough_credits') || lower.includes('not enough credits'))) {
    console.log('SUCCESS: Higgsfield credentials are valid and API is reachable.');
    console.log(`Evidence: authenticated but account lacks credits HTTP ${response.status}: ${body.slice(0, 220)}`);
    console.log('Blocker: add Higgsfield credits before generation; keep fal.ai fallback active.');
    process.exit(0);
  }

  if (response.status === 401 || response.status === 403 || lower.includes('unauthorized') || lower.includes('forbidden')) {
    console.error(`FAIL: Higgsfield auth rejected credentials HTTP ${response.status}.`);
    console.error(body.slice(0, 300));
    process.exit(4);
  }

  if (response.status >= 200 && response.status < 300) {
    let requestId = '';
    try { requestId = JSON.parse(body).request_id || ''; } catch (_) {}
    console.log('SUCCESS: Higgsfield credentials are valid, API credits are active, and generation requests can queue.');
    console.log(`Evidence: HTTP ${response.status}${requestId ? ` request_id=${requestId}` : ''}.`);
    console.log('Note: the empty-prompt probe was accepted by Higgsfield, so use OAuth CLI cost probe for no-generation checks when possible.');
    process.exit(0);
  }

  console.error(`FAIL: unexpected Higgsfield verification response HTTP ${response.status}.`);
  console.error(body.slice(0, 500));
  process.exit(5);
}

main().catch((err) => {
  console.error('FAIL: verifier crashed.');
  console.error(String(err?.message || err).slice(0, 500));
  process.exit(9);
});
