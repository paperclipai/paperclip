#!/usr/bin/env node
/**
 * get-bot-token.mjs
 * Generates a short-lived GitHub installation token for the commitperclip app.
 * Reads COMMITPERCLIP_KEY env var (PEM content of private key).
 * Prints the token to stdout.
 *
 * Also exports: generateJWT(privateKey), ghFetch(path, token, options)
 * These are used by all other gate scripts.
 */
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP_ID = '3718661';

export function generateJWT(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 10, exp: now + 60, iss: APP_ID };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

export async function ghFetch(path, token, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${options.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  const privateKey = process.env.COMMITPERCLIP_KEY;
  if (!privateKey) {
    console.error('ERROR: COMMITPERCLIP_KEY env var not set.');
    console.error('Add to ~/.bash_profile: export COMMITPERCLIP_KEY="$(cat ~/.config/commitperclip/private-key.pem)"');
    process.exit(1);
  }

  const jwt = generateJWT(privateKey);

  const installations = await ghFetch('/app/installations', jwt);
  if (!installations.length) {
    console.error('ERROR: No installations found for commitperclip.');
    console.error('Install URL: https://github.com/apps/commitperclip/installations/new');
    process.exit(1);
  }

  const { token } = await ghFetch(
    `/app/installations/${installations[0].id}/access_tokens`,
    jwt,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } }
  );

  if (!token) {
    console.error('ERROR: Failed to get installation token from GitHub API.');
    process.exit(1);
  }

  process.stdout.write(token);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
