import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  generateJWT,
  resolveAppCredentials,
  resolveInstallationId,
} from '../get-bot-token.mjs';

test('generateJWT: uses an explicitly selected GitHub App ID as the issuer', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = generateJWT(privateKey, '987654');
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

  assert.equal(payload.iss, '987654');
});

test('resolveAppCredentials: selects an explicit app without mixing legacy credentials', () => {
  assert.deepEqual(resolveAppCredentials({
    GITHUB_APP_ID: '987654',
    GITHUB_APP_PRIVATE_KEY: 'dedicated-key',
    GITHUB_APP_NAME: 'paperclip-evals',
    COMMITPERCLIP_KEY: 'legacy-key',
  }), {
    appId: '987654',
    privateKey: 'dedicated-key',
    appName: 'paperclip-evals',
  });
});

test('resolveAppCredentials: rejects a partially configured explicit app', () => {
  assert.throws(
    () => resolveAppCredentials({
      GITHUB_APP_ID: '987654',
      COMMITPERCLIP_KEY: 'legacy-key',
    }),
    /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set together/
  );
});

test('resolveInstallationId: uses the repo installation endpoint when repo context is available', async () => {
  const seenPaths = [];
  const installationId = await resolveInstallationId(async (path) => {
    seenPaths.push(path);
    return { id: 42 };
  }, 'jwt', 'paperclipai/paperclip', 'paperclipai');

  assert.equal(installationId, 42);
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/installation']);
});

test('resolveInstallationId: falls back to the matching owner installation', async () => {
  const installationId = await resolveInstallationId(async () => ([
    { id: 1, account: { login: 'someone-else' } },
    { id: 7, account: { login: 'PaperclipAI' } },
  ]), 'jwt', undefined, 'paperclipai');

  assert.equal(installationId, 7);
});

test('resolveInstallationId: rejects ambiguous installations without repo or owner context', async () => {
  await assert.rejects(
    resolveInstallationId(async () => ([
      { id: 1, account: { login: 'org-one' } },
      { id: 2, account: { login: 'org-two' } },
    ]), 'jwt'),
    /Multiple GitHub App installations found/
  );
});
