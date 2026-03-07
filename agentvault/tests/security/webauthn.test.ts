/**
 * WebAuthn / Biometric Fallback — Unit Tests
 *
 * Covers:
 *   1. Credential setup (P-256 keypair generation, encrypted storage)
 *   2. signChallenge() — ECDSA signature + counter increment
 *   3. verifyWebAuthnAssertion() — signature verification
 *   4. Counter replay protection
 *   5. Invalid public key / signature rejection
 *   6. hasBiometricCredential() / getDevicePublicKey() helpers
 *   7. Full round-trip: setup → sign → verify
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'av-webauthn-test-'));
  vi.stubEnv('HOME', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function loadWebAuthn() {
  return import('../../src/security/webauthn.js');
}

// ─── 1. Credential setup ──────────────────────────────────────────────────────

describe('setupBiometricCredential()', () => {
  it('returns a valid BiometricSetup object', async () => {
    const { setupBiometricCredential } = await loadWebAuthn();
    const setup = setupBiometricCredential('test-device-fp');

    expect(setup.credentialId).toMatch(/^[a-f0-9]{32}$/);
    expect(setup.deviceFingerprint).toBe('test-device-fp');
    expect(setup.publicKeyB64).toBeTruthy();
    expect(setup.createdAt).toBeDefined();
  });

  it('credential is accessible after setup (hasBiometricCredential confirms write)', async () => {
    const { setupBiometricCredential, hasBiometricCredential } = await loadWebAuthn();
    setupBiometricCredential('fp-mode-check');
    // Verify the module can read back what it wrote (proves write succeeded)
    expect(hasBiometricCredential('fp-mode-check')).toBe(true);
  });

  it('two setups for different fingerprints produce different credentials', async () => {
    const { setupBiometricCredential } = await loadWebAuthn();
    const s1 = setupBiometricCredential('fp-alpha');
    const s2 = setupBiometricCredential('fp-beta');

    expect(s1.credentialId).not.toBe(s2.credentialId);
    expect(s1.publicKeyB64).not.toBe(s2.publicKeyB64);
  });
});

// ─── 2. hasBiometricCredential / getDevicePublicKey ───────────────────────────

describe('credential helpers', () => {
  it('hasBiometricCredential() returns false before setup', async () => {
    const { hasBiometricCredential } = await loadWebAuthn();
    expect(hasBiometricCredential('no-such-fp')).toBe(false);
  });

  it('hasBiometricCredential() returns true after setup', async () => {
    const { setupBiometricCredential, hasBiometricCredential } = await loadWebAuthn();
    setupBiometricCredential('fp-has');
    expect(hasBiometricCredential('fp-has')).toBe(true);
  });

  it('getDevicePublicKey() returns null before setup', async () => {
    const { getDevicePublicKey } = await loadWebAuthn();
    expect(getDevicePublicKey('no-such-fp')).toBeNull();
  });

  it('getDevicePublicKey() returns base64url string after setup', async () => {
    const { setupBiometricCredential, getDevicePublicKey } = await loadWebAuthn();
    const setup = setupBiometricCredential('fp-pubkey');
    const pk = getDevicePublicKey('fp-pubkey');
    expect(pk).toBe(setup.publicKeyB64);
  });
});

// ─── 3. signChallenge() ───────────────────────────────────────────────────────

describe('signChallenge()', () => {
  it('returns a WebAuthnAssertion with all required fields', async () => {
    const { setupBiometricCredential, signChallenge } = await loadWebAuthn();
    setupBiometricCredential('fp-sign');
    const assertion = signChallenge('a'.repeat(64), 'fp-sign');

    expect(assertion.credentialId).toMatch(/^[a-f0-9]{32}$/);
    expect(assertion.clientDataHash).toMatch(/^[a-f0-9]{64}$/);
    expect(assertion.signatureB64).toBeTruthy();
    expect(assertion.signCounter).toBe(1);
    expect(assertion.timestamp).toBeDefined();
  });

  it('sign counter increments on each call', async () => {
    const { setupBiometricCredential, signChallenge } = await loadWebAuthn();
    setupBiometricCredential('fp-counter');
    const a1 = signChallenge('challenge-a', 'fp-counter');
    const a2 = signChallenge('challenge-b', 'fp-counter');
    expect(a2.signCounter).toBe(a1.signCounter + 1);
  });

  it('throws when no credential enrolled', async () => {
    const { signChallenge } = await loadWebAuthn();
    expect(() => signChallenge('challenge-x', 'fp-not-enrolled')).toThrow();
  });
});

// ─── 4. verifyWebAuthnAssertion() ─────────────────────────────────────────────

describe('verifyWebAuthnAssertion()', () => {
  it('accepts a valid assertion (full round-trip)', async () => {
    const { setupBiometricCredential, signChallenge, verifyWebAuthnAssertion } =
      await loadWebAuthn();
    const setup = setupBiometricCredential('fp-verify');
    const challengeHash = 'b'.repeat(64);
    const assertion = signChallenge(challengeHash, 'fp-verify');

    const result = verifyWebAuthnAssertion(assertion, challengeHash, setup.publicKeyB64, 0);
    expect(result.ok).toBe(true);
  });

  it('rejects counter replay (signCounter not greater than lastSeenCounter)', async () => {
    const { setupBiometricCredential, signChallenge, verifyWebAuthnAssertion } =
      await loadWebAuthn();
    const setup = setupBiometricCredential('fp-replay');
    const assertion = signChallenge('c'.repeat(64), 'fp-replay');

    // Pretend we've already seen counter = 5
    const result = verifyWebAuthnAssertion(assertion, 'c'.repeat(64), setup.publicKeyB64, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('counter-replay');
  });

  it('rejects a tampered signature', async () => {
    const { setupBiometricCredential, signChallenge, verifyWebAuthnAssertion } =
      await loadWebAuthn();
    const setup = setupBiometricCredential('fp-tamper');
    const assertion = signChallenge('d'.repeat(64), 'fp-tamper');

    // Flip a byte in the signature
    const tamperedSig = Buffer.from(assertion.signatureB64, 'base64url');
    tamperedSig.writeUInt8(tamperedSig[0]! ^ 0xff, 0);
    const tampered = { ...assertion, signatureB64: tamperedSig.toString('base64url') };

    const result = verifyWebAuthnAssertion(tampered, 'd'.repeat(64), setup.publicKeyB64, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature-invalid');
  });

  it('rejects an invalid public key', async () => {
    const { setupBiometricCredential, signChallenge, verifyWebAuthnAssertion } =
      await loadWebAuthn();
    setupBiometricCredential('fp-badkey');
    const assertion = signChallenge('e'.repeat(64), 'fp-badkey');

    const result = verifyWebAuthnAssertion(assertion, 'e'.repeat(64), 'not-a-valid-spki', 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-public-key');
  });
});

// ─── 5. getSignCounter() ──────────────────────────────────────────────────────

describe('getSignCounter()', () => {
  it('returns 0 for unknown device', async () => {
    const { getSignCounter } = await loadWebAuthn();
    expect(getSignCounter('unknown-device')).toBe(0);
  });

  it('returns current counter after signing', async () => {
    const { setupBiometricCredential, signChallenge, getSignCounter } = await loadWebAuthn();
    setupBiometricCredential('fp-getctr');
    signChallenge('f'.repeat(64), 'fp-getctr');
    signChallenge('g'.repeat(64), 'fp-getctr');
    expect(getSignCounter('fp-getctr')).toBe(2);
  });
});
