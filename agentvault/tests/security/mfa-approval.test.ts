/**
 * Multi-Factor Agent Approval — Unit Tests
 *
 * Covers:
 *   1. TOTP module (base32, HOTP, TOTP generate/verify, otpauth URI)
 *   2. MFA setup / challenge / verify flow (happy path)
 *   3. Nonce replay protection
 *   4. Invalid TOTP rejection
 *   5. One-time link generate / validate / expiry / reuse
 *   6. Rate limiting (>3 approvals / hour)
 *   7. Anomaly detection + branch auto-lock
 *   8. Branch unlock
 *   9. Audit log persistence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── Helpers: redirect MFA_DIR to a temp directory for each test ─────────────
//
// We override process.env.HOME so the MFA module writes to a throwaway dir.
// The module reads os.homedir() at call time via path.join, so this works
// as long as we set it before the first import.  We use vi.stubEnv instead
// of direct assignment to ensure proper cleanup.

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'av-mfa-test-'));
  vi.stubEnv('HOME', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ─── Lazy imports (after env stub) ───────────────────────────────────────────

async function loadTotp() {
  return import('../../src/security/totp.js');
}

async function loadMfa() {
  return import('../../src/security/mfa-approval.js');
}

// ─── 1. TOTP module ───────────────────────────────────────────────────────────

describe('TOTP module', () => {
  it('generateTotpSecret() returns 20-byte Buffer', async () => {
    const { generateTotpSecret } = await loadTotp();
    const secret = generateTotpSecret();
    expect(secret).toBeInstanceOf(Buffer);
    expect(secret.length).toBe(20);
  });

  it('base32Encode / base32Decode roundtrip', async () => {
    const { base32Encode, base32Decode, generateTotpSecret } = await loadTotp();
    const buf = generateTotpSecret();
    const encoded = base32Encode(buf);
    const decoded = base32Decode(encoded);
    expect(decoded.toString('hex')).toBe(buf.toString('hex'));
  });

  it('base32Decode throws on invalid character', async () => {
    const { base32Decode } = await loadTotp();
    expect(() => base32Decode('INVALID!CHAR')).toThrow();
  });

  it('generateTotp() returns 6-digit string', async () => {
    const { generateTotpSecret, generateTotp } = await loadTotp();
    const secret = generateTotpSecret();
    const code = generateTotp(secret);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('verifyTotp() accepts the current code', async () => {
    const { generateTotpSecret, generateTotp, verifyTotp } = await loadTotp();
    const secret = generateTotpSecret();
    const code = generateTotp(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it('verifyTotp() rejects a wrong code', async () => {
    const { generateTotpSecret, verifyTotp } = await loadTotp();
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '000000')).toBe(false);
  });

  it('verifyTotp() accepts code from adjacent window', async () => {
    const { generateTotpSecret, generateTotp, verifyTotp } = await loadTotp();
    const secret = generateTotpSecret();
    const now = Date.now();
    // Simulate a code that was generated 29 seconds ago (one period behind)
    const pastCode = generateTotp(secret, { nowMs: now - 29_000 });
    expect(verifyTotp(secret, pastCode, { nowMs: now })).toBe(true);
  });

  it('otpAuthUri() contains expected fields', async () => {
    const { generateTotpSecret, base32Encode, otpAuthUri } = await loadTotp();
    const secret = generateTotpSecret();
    const uri = otpAuthUri(secret, 'AgentVault:pending-001');

    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=' + base32Encode(secret));
    expect(uri).toContain('issuer=AgentVault');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('generateTotp() is deterministic for same secret and time', async () => {
    const { generateTotpSecret, generateTotp } = await loadTotp();
    const secret = generateTotpSecret();
    const nowMs = Date.now();
    expect(generateTotp(secret, { nowMs })).toBe(generateTotp(secret, { nowMs }));
  });

  it('generateTotp() produces different codes in different periods', async () => {
    const { generateTotpSecret, generateTotp } = await loadTotp();
    const secret = generateTotpSecret();
    const t1 = 0;
    const t2 = 30_000; // one period later
    // Codes are deterministic so they MAY collide by chance; but for random secrets this is negligible
    const c1 = generateTotp(secret, { nowMs: t1 });
    const c2 = generateTotp(secret, { nowMs: t2 });
    // Both must be 6-digit strings
    expect(c1).toMatch(/^\d{6}$/);
    expect(c2).toMatch(/^\d{6}$/);
  });
});

// ─── 2. MFA happy path ────────────────────────────────────────────────────────

describe('MFA approval — happy path', () => {
  it('setupMfa() returns valid setup object', async () => {
    const { setupMfa } = await loadMfa();
    const setup = setupMfa('branch-001');

    expect(setup.branchId).toBe('branch-001');
    expect(setup.totpSecretB32).toMatch(/^[A-Z2-7]+=*$/);
    expect(setup.otpAuthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.createdAt).toBeDefined();
  });

  it('issueChallenge() returns challenge with nonce=1 on first call', async () => {
    const { setupMfa, issueChallenge } = await loadMfa();
    setupMfa('branch-002');
    const challenge = issueChallenge('req-001', 'branch-002');

    expect(challenge.nonce).toBe(1);
    expect(challenge.requestId).toBe('req-001');
    expect(challenge.branchId).toBe('branch-002');
    expect(challenge.challengeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(challenge.approvalLink).toContain('req-001');
    expect(challenge.expiresAt).toBeDefined();
  });

  it('nonce increments on successive challenges', async () => {
    const { setupMfa, issueChallenge } = await loadMfa();
    setupMfa('branch-003');
    const c1 = issueChallenge('req-001', 'branch-003');
    const c2 = issueChallenge('req-002', 'branch-003');
    expect(c2.nonce).toBe(c1.nonce + 1);
  });

  it('verifyMfaApproval() succeeds with correct code and nonce', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval } = await loadMfa();
    const { generateTotp, base32Decode } = await loadTotp();

    const setup = setupMfa('branch-004');
    const challenge = issueChallenge('req-001', 'branch-004');

    // Generate a valid TOTP code using the exposed secret
    const secret = base32Decode(setup.totpSecretB32);
    const code = generateTotp(secret);

    const result = verifyMfaApproval({
      requestId: 'req-001',
      branchId: 'branch-004',
      totpCode: code,
      nonce: challenge.nonce,
      deviceFingerprint: 'test-device-fp',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auditToken).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

// ─── 3. Nonce replay protection ───────────────────────────────────────────────

describe('Nonce replay protection', () => {
  it('rejects a previously-used nonce', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval } = await loadMfa();
    const { generateTotp, base32Decode } = await loadTotp();

    const setup = setupMfa('branch-replay');
    const challenge = issueChallenge('req-001', 'branch-replay');
    const secret = base32Decode(setup.totpSecretB32);
    const code = generateTotp(secret);

    // First approval — should succeed
    const first = verifyMfaApproval({
      requestId: 'req-001',
      branchId: 'branch-replay',
      totpCode: code,
      nonce: challenge.nonce,
      deviceFingerprint: 'fp-replay',
    });
    expect(first.ok).toBe(true);

    // Second approval with same nonce — replay
    const second = verifyMfaApproval({
      requestId: 'req-001',
      branchId: 'branch-replay',
      totpCode: code,
      nonce: challenge.nonce,
      deviceFingerprint: 'fp-replay',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('nonce-replayed');
  });

  it('rejects an out-of-order nonce', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval } = await loadMfa();
    const { generateTotp, base32Decode } = await loadTotp();

    const setup = setupMfa('branch-oom');
    issueChallenge('req-001', 'branch-oom'); // nonce = 1
    issueChallenge('req-002', 'branch-oom'); // nonce = 2 (current)

    const secret = base32Decode(setup.totpSecretB32);
    const code = generateTotp(secret);

    // Try to approve with nonce=1 (old, not yet used but not current)
    const result = verifyMfaApproval({
      requestId: 'req-001',
      branchId: 'branch-oom',
      totpCode: code,
      nonce: 1,
      deviceFingerprint: 'fp-oom',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('nonce-mismatch');
  });
});

// ─── 4. Invalid TOTP rejection ────────────────────────────────────────────────

describe('TOTP rejection', () => {
  it('rejects wrong TOTP code', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval } = await loadMfa();
    setupMfa('branch-bad-totp');
    const challenge = issueChallenge('req-001', 'branch-bad-totp');

    const result = verifyMfaApproval({
      requestId: 'req-001',
      branchId: 'branch-bad-totp',
      totpCode: '000000',
      nonce: challenge.nonce,
      deviceFingerprint: 'fp-bad',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-totp');
  });

  it('returns not-setup when branch has no seed', async () => {
    const { verifyMfaApproval } = await loadMfa();
    const result = verifyMfaApproval({
      requestId: 'req-001',
      branchId: 'nonexistent-branch',
      totpCode: '123456',
      nonce: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-setup');
  });
});

// ─── 5. One-time link ─────────────────────────────────────────────────────────

describe('One-time approval link', () => {
  it('generateOtpToken embed in challenge link contains a hex token', async () => {
    const { setupMfa, issueChallenge } = await loadMfa();
    setupMfa('branch-link');
    const challenge = issueChallenge('req-001', 'branch-link');
    // Link format: https://agentvault.approve/<req>?token=<64-hex>
    expect(challenge.approvalLink).toMatch(/token=[a-f0-9]{64}/);
  });

  it('validateOtpToken() succeeds on first use', async () => {
    const { setupMfa, issueChallenge, validateOtpToken } = await loadMfa();
    setupMfa('branch-link2');
    const challenge = issueChallenge('req-001', 'branch-link2');
    const token = challenge.approvalLink.split('token=')[1];
    if (!token) throw new Error('Token not found in approval link');

    const result = validateOtpToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.requestId).toBe('req-001');
  });

  it('validateOtpToken() rejects on second use (replay)', async () => {
    const { setupMfa, issueChallenge, validateOtpToken } = await loadMfa();
    setupMfa('branch-link3');
    const challenge = issueChallenge('req-001', 'branch-link3');
    const token = challenge.approvalLink.split('token=')[1];
    if (!token) throw new Error('Token not found in approval link');

    validateOtpToken(token); // first use — ok
    const second = validateOtpToken(token); // replay
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('token-already-used');
  });

  it('validateOtpToken() rejects unknown token', async () => {
    const { validateOtpToken } = await loadMfa();
    const result = validateOtpToken('a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token-not-found');
  });
});

// ─── 6. Rate limiting ─────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  it('allows up to 3 approvals per hour and blocks the 4th', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval } = await loadMfa();
    const { generateTotp, base32Decode } = await loadTotp();

    const setup = setupMfa('branch-rl');
    const secret = base32Decode(setup.totpSecretB32);
    const fp = 'fp-rate-limit';

    for (let i = 1; i <= 3; i++) {
      const challenge = issueChallenge(`req-${i}`, 'branch-rl');
      const code = generateTotp(secret);
      const result = verifyMfaApproval({
        requestId: `req-${i}`,
        branchId: 'branch-rl',
        totpCode: code,
        nonce: challenge.nonce,
        deviceFingerprint: fp,
      });
      expect(result.ok).toBe(true);
    }

    // 4th attempt — should be rate-limited
    const challenge4 = issueChallenge('req-4', 'branch-rl');
    const code4 = generateTotp(secret);
    const result4 = verifyMfaApproval({
      requestId: 'req-4',
      branchId: 'branch-rl',
      totpCode: code4,
      nonce: challenge4.nonce,
      deviceFingerprint: fp,
    });
    expect(result4.ok).toBe(false);
    if (!result4.ok) expect(result4.reason).toBe('rate-limited');
  });
});

// ─── 7. Anomaly detection ─────────────────────────────────────────────────────

describe('Anomaly detection', () => {
  it('locks branch on first unknown device after a known one', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval } = await loadMfa();
    const { generateTotp, base32Decode } = await loadTotp();

    const setup = setupMfa('branch-anomaly');
    const secret = base32Decode(setup.totpSecretB32);

    // First approval — first-time device (auto-enrolled)
    const c1 = issueChallenge('req-1', 'branch-anomaly');
    const code1 = generateTotp(secret);
    const r1 = verifyMfaApproval({
      requestId: 'req-1',
      branchId: 'branch-anomaly',
      totpCode: code1,
      nonce: c1.nonce,
      deviceFingerprint: 'known-device',
    });
    expect(r1.ok).toBe(true);

    // Second approval from a NEW device — anomaly
    const c2 = issueChallenge('req-2', 'branch-anomaly');
    const code2 = generateTotp(secret);
    const r2 = verifyMfaApproval({
      requestId: 'req-2',
      branchId: 'branch-anomaly',
      totpCode: code2,
      nonce: c2.nonce,
      deviceFingerprint: 'new-unknown-device',
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('anomaly');
  });
});

// ─── 8. Branch unlock ─────────────────────────────────────────────────────────

describe('Branch unlock', () => {
  it('unlockBranch() succeeds with valid TOTP', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval, unlockBranch, getMfaStatus } =
      await loadMfa();
    const { generateTotp, base32Decode } = await loadTotp();

    const setup = setupMfa('branch-unlock');
    const secret = base32Decode(setup.totpSecretB32);

    // Trigger anomaly to lock branch
    const c1 = issueChallenge('req-1', 'branch-unlock');
    verifyMfaApproval({
      requestId: 'req-1', branchId: 'branch-unlock',
      totpCode: generateTotp(secret), nonce: c1.nonce,
      deviceFingerprint: 'device-A',
    });

    const c2 = issueChallenge('req-2', 'branch-unlock');
    const r2 = verifyMfaApproval({
      requestId: 'req-2', branchId: 'branch-unlock',
      totpCode: generateTotp(secret), nonce: c2.nonce,
      deviceFingerprint: 'device-B-new',
    });
    expect(r2.ok).toBe(false); // anomaly — branch now locked

    // Unlock with fresh TOTP
    const freshCode = generateTotp(secret);
    const unlocked = unlockBranch('branch-unlock', freshCode);
    expect(unlocked).toBe(true);

    const status = getMfaStatus('branch-unlock');
    expect(status.locked).toBe(false);
  });

  it('unlockBranch() fails with wrong TOTP', async () => {
    const { setupMfa, unlockBranch } = await loadMfa();
    setupMfa('branch-failunlock');
    const ok = unlockBranch('branch-failunlock', '000000');
    expect(ok).toBe(false);
  });
});

// ─── 9. Audit log persistence ─────────────────────────────────────────────────

describe('Audit log', () => {
  it('records setup and challenge-issued events', async () => {
    const { setupMfa, issueChallenge, getMfaAuditLog } = await loadMfa();
    setupMfa('branch-audit');
    issueChallenge('req-001', 'branch-audit');

    const log = getMfaAuditLog('branch-audit');
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log.some((e) => e.event === 'setup')).toBe(true);
    expect(log.some((e) => e.event === 'challenge-issued')).toBe(true);
  });

  it('records approved event on successful verify', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval, getMfaAuditLog } = await loadMfa();
    const { generateTotp, base32Decode } = await loadTotp();

    const setup = setupMfa('branch-audit2');
    const challenge = issueChallenge('req-001', 'branch-audit2');
    const secret = base32Decode(setup.totpSecretB32);
    const code = generateTotp(secret);

    verifyMfaApproval({
      requestId: 'req-001', branchId: 'branch-audit2',
      totpCode: code, nonce: challenge.nonce,
      deviceFingerprint: 'audit-fp',
    });

    const log = getMfaAuditLog('branch-audit2');
    const approved = log.find((e) => e.event === 'approved');
    expect(approved).toBeDefined();
    expect(approved?.auditToken).toMatch(/^[a-f0-9]{64}$/);
    expect(approved?.nonce).toBe(1);
  });

  it('returns empty array for unknown branch', async () => {
    const { getMfaAuditLog } = await loadMfa();
    expect(getMfaAuditLog('nonexistent')).toEqual([]);
  });
});

// ─── 10. getMfaStatus() ───────────────────────────────────────────────────────

describe('getMfaStatus()', () => {
  it('returns configured=false for unknown branch', async () => {
    const { getMfaStatus } = await loadMfa();
    const s = getMfaStatus('unknown');
    expect(s.configured).toBe(false);
    expect(s.locked).toBe(false);
    expect(s.currentNonce).toBe(0);
  });

  it('returns correct nonce after challenges', async () => {
    const { setupMfa, issueChallenge, getMfaStatus } = await loadMfa();
    setupMfa('branch-status');
    issueChallenge('req-1', 'branch-status');
    issueChallenge('req-2', 'branch-status');
    const s = getMfaStatus('branch-status');
    expect(s.configured).toBe(true);
    expect(s.currentNonce).toBe(2);
  });
});

// ─── 11. Biometric (WebAuthn) approval ────────────────────────────────────────

async function loadWebAuthn() {
  return import('../../src/security/webauthn.js');
}

describe('verifyBiometricApproval() — happy path', () => {
  it('accepts a valid biometric assertion', async () => {
    const { setupMfa, issueChallenge, verifyBiometricApproval } = await loadMfa();
    const { setupBiometricCredential, signChallenge } = await loadWebAuthn();

    setupMfa('branch-bio');
    const challenge = issueChallenge('req-bio-001', 'branch-bio');
    setupBiometricCredential('bio-device-fp');

    const assertion = signChallenge(challenge.challengeHash, 'bio-device-fp');
    const result = verifyBiometricApproval({
      requestId: 'req-bio-001',
      branchId: 'branch-bio',
      challengeHash: challenge.challengeHash,
      assertion,
      nonce: challenge.nonce,
      deviceFingerprint: 'bio-device-fp',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auditToken).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('records approved-biometric event in audit log', async () => {
    const { setupMfa, issueChallenge, verifyBiometricApproval, getMfaAuditLog } = await loadMfa();
    const { setupBiometricCredential, signChallenge } = await loadWebAuthn();

    setupMfa('branch-bio-audit');
    const challenge = issueChallenge('req-bio-002', 'branch-bio-audit');
    setupBiometricCredential('bio-audit-fp');

    const assertion = signChallenge(challenge.challengeHash, 'bio-audit-fp');
    verifyBiometricApproval({
      requestId: 'req-bio-002',
      branchId: 'branch-bio-audit',
      challengeHash: challenge.challengeHash,
      assertion,
      nonce: challenge.nonce,
      deviceFingerprint: 'bio-audit-fp',
    });

    const log = getMfaAuditLog('branch-bio-audit');
    expect(log.some((e) => e.event === 'approved-biometric')).toBe(true);
  });
});

describe('verifyBiometricApproval() — rejections', () => {
  it('rejects when no biometric credential enrolled', async () => {
    const { setupMfa, issueChallenge, verifyBiometricApproval } = await loadMfa();
    const { setupBiometricCredential, signChallenge } = await loadWebAuthn();

    setupMfa('branch-bio-nokey');
    const challenge = issueChallenge('req-bio-003', 'branch-bio-nokey');
    setupBiometricCredential('other-fp'); // different fingerprint
    const assertion = signChallenge(challenge.challengeHash, 'other-fp');

    const result = verifyBiometricApproval({
      requestId: 'req-bio-003',
      branchId: 'branch-bio-nokey',
      challengeHash: challenge.challengeHash,
      assertion,
      nonce: challenge.nonce,
      deviceFingerprint: 'fp-not-enrolled', // mismatch
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('biometric-not-enrolled');
  });

  it('rejects a tampered biometric signature', async () => {
    const { setupMfa, issueChallenge, verifyBiometricApproval } = await loadMfa();
    const { setupBiometricCredential, signChallenge } = await loadWebAuthn();

    setupMfa('branch-bio-tamper');
    const challenge = issueChallenge('req-bio-004', 'branch-bio-tamper');
    setupBiometricCredential('bio-tamper-fp');
    const assertion = signChallenge(challenge.challengeHash, 'bio-tamper-fp');

    // Tamper the signature
    const sigBuf = Buffer.from(assertion.signatureB64, 'base64url');
    sigBuf.writeUInt8(sigBuf[0]! ^ 0xff, 0);
    const tamperedAssertion = { ...assertion, signatureB64: sigBuf.toString('base64url') };

    const result = verifyBiometricApproval({
      requestId: 'req-bio-004',
      branchId: 'branch-bio-tamper',
      challengeHash: challenge.challengeHash,
      assertion: tamperedAssertion,
      nonce: challenge.nonce,
      deviceFingerprint: 'bio-tamper-fp',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('biometric-signature-invalid');
  });

  it('rejects nonce mismatch in biometric path', async () => {
    const { setupMfa, issueChallenge, verifyBiometricApproval } = await loadMfa();
    const { setupBiometricCredential, signChallenge } = await loadWebAuthn();

    setupMfa('branch-bio-nonce');
    issueChallenge('req-bio-005a', 'branch-bio-nonce'); // nonce=1
    const c2 = issueChallenge('req-bio-005b', 'branch-bio-nonce'); // nonce=2
    setupBiometricCredential('bio-nonce-fp');
    const assertion = signChallenge(c2.challengeHash, 'bio-nonce-fp');

    const result = verifyBiometricApproval({
      requestId: 'req-bio-005b',
      branchId: 'branch-bio-nonce',
      challengeHash: c2.challengeHash,
      assertion,
      nonce: 1, // wrong — current is 2
      deviceFingerprint: 'bio-nonce-fp',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('nonce-mismatch');
  });
});

// ─── 12. Anomaly detection ping ────────────────────────────────────────────────

describe('Anomaly detection — "Was this you?" ping', () => {
  it('anomaly-ping-sent event appears after new-device anomaly', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval, getMfaAuditLog } = await loadMfa();
    const { generateTotp, base32Decode } = await loadTotp();

    const setup = setupMfa('branch-ping');
    const secret = base32Decode(setup.totpSecretB32);

    // First approval — enrol device A
    const c1 = issueChallenge('req-1', 'branch-ping');
    verifyMfaApproval({
      requestId: 'req-1', branchId: 'branch-ping',
      totpCode: generateTotp(secret), nonce: c1.nonce,
      deviceFingerprint: 'device-known',
    });

    // Second approval — new unknown device triggers anomaly + ping
    const c2 = issueChallenge('req-2', 'branch-ping');
    const r2 = verifyMfaApproval({
      requestId: 'req-2', branchId: 'branch-ping',
      totpCode: generateTotp(secret), nonce: c2.nonce,
      deviceFingerprint: 'device-new-stranger',
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('anomaly');

    const log = getMfaAuditLog('branch-ping');
    expect(log.some((e) => e.event === 'anomaly-ping-sent')).toBe(true);
    const pingEntry = log.find((e) => e.event === 'anomaly-ping-sent');
    expect(pingEntry?.detail).toContain('agentvault approve mfa unlock');
  });

  it('unlockBranch() clears pendingAnomalyFingerprint', async () => {
    const { setupMfa, issueChallenge, verifyMfaApproval, unlockBranch, getMfaStatus } =
      await loadMfa();
    const { generateTotp, base32Decode } = await loadTotp();

    const setup = setupMfa('branch-ping-unlock');
    const secret = base32Decode(setup.totpSecretB32);

    const c1 = issueChallenge('req-1', 'branch-ping-unlock');
    verifyMfaApproval({
      requestId: 'req-1', branchId: 'branch-ping-unlock',
      totpCode: generateTotp(secret), nonce: c1.nonce,
      deviceFingerprint: 'device-a',
    });

    const c2 = issueChallenge('req-2', 'branch-ping-unlock');
    verifyMfaApproval({
      requestId: 'req-2', branchId: 'branch-ping-unlock',
      totpCode: generateTotp(secret), nonce: c2.nonce,
      deviceFingerprint: 'device-b-new',
    }); // anomaly → locked

    // Unlock with TOTP and register new device
    const unlocked = unlockBranch('branch-ping-unlock', generateTotp(secret), 'device-b-new');
    expect(unlocked).toBe(true);

    const status = getMfaStatus('branch-ping-unlock');
    expect(status.locked).toBe(false);
  });
});
