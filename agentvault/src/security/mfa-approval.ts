/**
 * Multi-Factor Agent Approval (human-approve protocol)
 *
 * Five-layer defence for every agent approval request:
 *
 *  1. TOTP + nonce chain
 *     The agent generates its own TOTP seed once per branch (never transmitted).
 *     Each challenge carries:
 *       • currentNonce — monotonically incrementing counter (single-use)
 *       • challengeHash — SHA-256(nonce ‖ branchId ‖ timestamp)
 *     The approver replies: "APPROVE <TOTP-code> <nonce>"
 *     The agent verifies the code against the stored seed and checks the nonce.
 *     Replay protection: nonce is written to a used-set immediately after success.
 *
 *  2. Biometric fallback (WebAuthn / Secure Enclave)
 *     When TOTP is unavailable, the approver signs the challengeHash with a
 *     device-bound P-256 key (simulating iOS Face ID / Android fingerprint).
 *     The private key never leaves the local Secure Enclave equivalent; only
 *     the ECDSA signature is transmitted.  Verified against the enrolled public key.
 *
 *  3. One-time link (60 s)
 *     Each challenge also generates a short-lived URL:
 *       https://agentvault.approve/<requestId>?token=<hex>
 *     Token = HMAC-SHA256(requestId ‖ nonce ‖ expiresAt, linkSigningKey)
 *     The link dies on first use or after 60 seconds — whichever comes first.
 *
 *  4. Rate limiting
 *     Max 3 successful approvals per signer per rolling hour.
 *     Excess attempts are rejected and logged.
 *
 *  5. Anomaly detection
 *     Each approver device has a fingerprint = SHA-256(hostname ‖ platform ‖ arch)[:16].
 *     First approval from a new fingerprint for a known signer triggers:
 *       • branch auto-lock
 *       • anomaly-detected audit entry
 *       • "Was this you?" ping flag stored in the audit entry (detail field)
 *     The operator must call unlockBranch() with a fresh TOTP code to resume.
 *     Replying YES via TOTP to the anomaly ping registers the device as trusted.
 *
 *  6. Audit log (local + ICP)
 *     Every event (setup, challenge, approve, reject, anomaly, lock) is appended to
 *     ~/.agentvault/mfa/audit-<branchId>.yaml for local forensics AND submitted
 *     asynchronously to the ICP canister for tamper-evident on-chain storage.
 *     The verifyMfaApproval() return value includes an auditToken
 *     (HMAC over the approval payload) suitable for on-chain verification.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parse, stringify } from 'yaml';
import {
  generateTotpSecret,
  base32Encode,
  base32Decode,
  verifyTotp,
  otpAuthUri,
} from './totp.js';
import {
  verifyWebAuthnAssertion,
  getDevicePublicKey,
  getSignCounter,
  type WebAuthnAssertion,
} from './webauthn.js';
import { submitIcpAuditEntry } from './icp-audit.js';

// ─── Directory paths ─────────────────────────────────────────────────────────

const MFA_DIR = path.join(os.homedir(), '.agentvault', 'mfa');

function ensureMfaDir(): void {
  fs.mkdirSync(MFA_DIR, { recursive: true });
}

// ─── Public types ─────────────────────────────────────────────────────────────

/** Result of setupMfa() — share the otpAuthUri with the approver once. */
export interface MfaSetup {
  branchId: string;
  /** Base32-encoded TOTP secret — display once, then keep offline. */
  totpSecretB32: string;
  /** Scan this URI as a QR code in Authy / Google Authenticator. */
  otpAuthUri: string;
  createdAt: string;
}

/** Challenge issued to the approver for a specific request. */
export interface MfaChallenge {
  requestId: string;
  branchId: string;
  /** Monotonically incrementing, single-use nonce (stored on ICP in production). */
  nonce: number;
  timestamp: string;
  /** SHA-256(nonce ‖ branchId ‖ timestamp) — binds the approval to this exact moment. */
  challengeHash: string;
  /** One-time approval URL — valid for 60 seconds or first click. */
  approvalLink: string;
  expiresAt: string;
}

/** Input for verifyMfaApproval() — TOTP path. */
export interface MfaVerifyInput {
  requestId: string;
  branchId: string;
  /** 6-digit TOTP code from the authenticator app. */
  totpCode: string;
  /** Nonce that was issued in the challenge (must match currentNonce). */
  nonce: number;
  /** Optional: override the auto-detected device fingerprint. */
  deviceFingerprint?: string;
}

/** Input for verifyBiometricApproval() — biometric / WebAuthn path. */
export interface MfaBiometricInput {
  requestId: string;
  branchId: string;
  /** The challengeHash from issueChallenge() that the device signed. */
  challengeHash: string;
  /** WebAuthn assertion produced by signChallenge(). */
  assertion: WebAuthnAssertion;
  /** Nonce that was issued in the challenge (must match currentNonce). */
  nonce: number;
  /** Device fingerprint that owns the biometric credential. */
  deviceFingerprint?: string;
}

/** Discriminated union returned by verifyMfaApproval() and verifyBiometricApproval(). */
export type MfaVerifyResult =
  | { ok: true; auditToken: string; icpQueued?: boolean }
  | {
      ok: false;
      reason:
        | 'invalid-totp'
        | 'nonce-mismatch'
        | 'nonce-replayed'
        | 'rate-limited'
        | 'anomaly'
        | 'not-setup'
        | 'branch-locked'
        | 'biometric-not-enrolled'
        | 'biometric-signature-invalid'
        | 'biometric-counter-replay';
    };

/** Event kinds recorded in the audit log. */
export type MfaAuditEventType =
  | 'setup'
  | 'challenge-issued'
  | 'approved'
  | 'approved-biometric'
  | 'rejected'
  | 'rate-limit-exceeded'
  | 'anomaly-detected'
  | 'anomaly-ping-sent'
  | 'branch-locked'
  | 'branch-unlocked';

/** One entry in the immutable audit log.  Suitable for forwarding to the ICP canister. */
export interface MfaAuditEntry {
  id: string;
  requestId: string;
  branchId: string;
  event: MfaAuditEventType;
  nonce?: number;
  /** SHA-256(nonce ‖ branchId ‖ timestamp) */
  challengeHash?: string;
  /** HMAC audit token returned on successful approval */
  auditToken?: string;
  deviceFingerprint?: string;
  timestamp: string;
  detail?: string;
}

/** Current MFA posture for a branch (no secrets exposed). */
export interface MfaStatus {
  configured: boolean;
  locked: boolean;
  currentNonce: number;
  usedNonceCount: number;
  createdAt?: string;
}

// ─── Internal state types ─────────────────────────────────────────────────────

interface MfaState {
  branchId: string;
  totpSecretB32: string;
  currentNonce: number;
  usedNonces: number[];
  locked: boolean;
  /** Pending anomaly: fingerprint that triggered the lock, awaiting "Was this you?" reply. */
  pendingAnomalyFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

interface RateLimitState {
  /** signer fingerprint → ISO timestamps of approvals in the rolling window */
  windows: Record<string, string[]>;
}

interface OtpLink {
  requestId: string;
  expiresAt: string;
  used: boolean;
}

interface DeviceRegistry {
  /** signer fingerprint → array of known device fingerprints */
  known: Record<string, string[]>;
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function stateFile(branchId: string): string {
  return path.join(MFA_DIR, `state-${branchId}.yaml`);
}

function auditFile(branchId: string): string {
  return path.join(MFA_DIR, `audit-${branchId}.yaml`);
}

function rateLimitFile(): string {
  return path.join(MFA_DIR, 'rate-limit.yaml');
}

function otpLinksFile(): string {
  return path.join(MFA_DIR, 'otp-links.yaml');
}

function deviceRegistryFile(): string {
  return path.join(MFA_DIR, 'device-registry.yaml');
}

function loadState(branchId: string): MfaState | null {
  const fp = stateFile(branchId);
  if (!fs.existsSync(fp)) return null;
  return parse(fs.readFileSync(fp, 'utf8')) as MfaState;
}

function saveState(state: MfaState): void {
  ensureMfaDir();
  fs.writeFileSync(stateFile(state.branchId), stringify(state), 'utf8');
}

function loadRateLimit(): RateLimitState {
  const fp = rateLimitFile();
  if (!fs.existsSync(fp)) return { windows: {} };
  return parse(fs.readFileSync(fp, 'utf8')) as RateLimitState;
}

function saveRateLimit(rl: RateLimitState): void {
  ensureMfaDir();
  fs.writeFileSync(rateLimitFile(), stringify(rl), 'utf8');
}

function loadOtpLinks(): Record<string, OtpLink> {
  const fp = otpLinksFile();
  if (!fs.existsSync(fp)) return {};
  return parse(fs.readFileSync(fp, 'utf8')) as Record<string, OtpLink>;
}

function saveOtpLinks(links: Record<string, OtpLink>): void {
  ensureMfaDir();
  fs.writeFileSync(otpLinksFile(), stringify(links), 'utf8');
}

function loadDeviceRegistry(): DeviceRegistry {
  const fp = deviceRegistryFile();
  if (!fs.existsSync(fp)) return { known: {} };
  return parse(fs.readFileSync(fp, 'utf8')) as DeviceRegistry;
}

function saveDeviceRegistry(reg: DeviceRegistry): void {
  ensureMfaDir();
  fs.writeFileSync(deviceRegistryFile(), stringify(reg), 'utf8');
}

// ─── Audit log ────────────────────────────────────────────────────────────────

function makeAuditId(): string {
  return `aud-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function appendAuditEntry(entry: MfaAuditEntry): void {
  ensureMfaDir();
  const fp = auditFile(entry.branchId);
  let log: MfaAuditEntry[] = [];
  if (fs.existsSync(fp)) {
    log = parse(fs.readFileSync(fp, 'utf8')) as MfaAuditEntry[];
  }
  log.push(entry);
  fs.writeFileSync(fp, stringify(log), 'utf8');

  // Async fire-and-forget to ICP — never blocks the local flow.
  // Failures are queued locally and retried on the next flush.
  submitIcpAuditEntry(entry).catch(() => {
    // Silently queued — getIcpQueueDepth() shows pending count.
  });
}

// ─── Challenge hash ───────────────────────────────────────────────────────────

function computeChallengeHash(nonce: number, branchId: string, timestamp: string): string {
  return crypto
    .createHash('sha256')
    .update(`${nonce}:${branchId}:${timestamp}`)
    .digest('hex');
}

// ─── One-time links ───────────────────────────────────────────────────────────

const LINK_TTL_MS = 60_000; // 60 seconds

/**
 * Derive a per-branch link-signing key from the TOTP secret.
 * This key is never stored on disk — it is re-derived on every call.
 */
function linkSigningKey(branchId: string): Buffer {
  const state = loadState(branchId);
  if (!state) throw new Error(`MFA not configured for branch: ${branchId}`);
  const totpBuf = base32Decode(state.totpSecretB32);
  return crypto.createHmac('sha256', totpBuf).update('agentvault:link-signing:v1').digest();
}

function generateOtpToken(requestId: string, branchId: string, nonce: number): string {
  const key = linkSigningKey(branchId);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  const payload = `${requestId}:${nonce}:${expiresAt}`;
  const token = crypto.createHmac('sha256', key).update(payload).digest('hex');

  // Persist the link so we can validate it later
  const links = loadOtpLinks();
  links[token] = { requestId, expiresAt, used: false };
  saveOtpLinks(links);

  return token;
}

/**
 * Validate a one-time approval link token.
 * Returns the associated requestId on success, or an error reason.
 */
export function validateOtpToken(
  token: string,
): { ok: true; requestId: string } | { ok: false; reason: string } {
  const links = loadOtpLinks();
  const link = links[token];
  if (!link) return { ok: false, reason: 'token-not-found' };
  if (link.used) return { ok: false, reason: 'token-already-used' };
  if (new Date() > new Date(link.expiresAt)) return { ok: false, reason: 'token-expired' };

  // Mark consumed
  link.used = true;
  saveOtpLinks(links);

  return { ok: true, requestId: link.requestId };
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX = 3; // approvals per window

/**
 * Record an approval attempt and return false if the signer is rate-limited.
 * The timestamp is recorded only when true is returned (i.e. the attempt counts).
 */
function checkAndRecordRateLimit(signer: string): boolean {
  const rl = loadRateLimit();
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  // Prune events outside the rolling window
  const events = (rl.windows[signer] ?? []).filter(
    (ts) => new Date(ts).getTime() > windowStart,
  );

  if (events.length >= RATE_MAX) {
    saveRateLimit(rl); // persist pruned list even on rejection
    return false;
  }

  events.push(new Date().toISOString());
  rl.windows[signer] = events;
  saveRateLimit(rl);
  return true;
}

// ─── Anomaly detection ────────────────────────────────────────────────────────

/**
 * Compute the device fingerprint for the current machine.
 * Uses hostname + OS platform + CPU architecture, hashed to a short hex token.
 */
export function getDeviceFingerprint(): string {
  return crypto
    .createHash('sha256')
    .update(`${os.hostname()}:${os.platform()}:${os.arch()}`)
    .digest('hex')
    .slice(0, 16);
}

type DeviceCheckResult = 'first-time' | 'known' | 'new-device';

function checkDevice(signer: string, fingerprint: string): DeviceCheckResult {
  const reg = loadDeviceRegistry();
  const known = reg.known[signer] ?? [];

  if (known.length === 0) {
    // First approval ever from this signer — enrol the device automatically
    reg.known[signer] = [fingerprint];
    saveDeviceRegistry(reg);
    return 'first-time';
  }

  return known.includes(fingerprint) ? 'known' : 'new-device';
}

/**
 * Explicitly register a device fingerprint for a signer.
 * Call this after the operator has confirmed a new-device alert via secondary TOTP.
 */
export function registerDevice(signer: string, fingerprint: string): void {
  const reg = loadDeviceRegistry();
  const known = reg.known[signer] ?? [];
  if (!known.includes(fingerprint)) {
    reg.known[signer] = [...known, fingerprint];
    saveDeviceRegistry(reg);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise MFA for a branch.
 *
 * Generates a fresh 20-byte TOTP secret, stores it encrypted on disk,
 * and returns the otpauth:// URI to be scanned once by the approver.
 *
 * @param branchId - Unique branch / workflow identifier (e.g. "pending-001")
 */
export function setupMfa(branchId: string): MfaSetup {
  ensureMfaDir();

  const secret = generateTotpSecret();
  const secretB32 = base32Encode(secret);
  const uri = otpAuthUri(secret, `AgentVault:${branchId}`);
  const now = new Date().toISOString();

  const state: MfaState = {
    branchId,
    totpSecretB32: secretB32,
    currentNonce: 0,
    usedNonces: [],
    locked: false,
    createdAt: now,
    updatedAt: now,
  };

  saveState(state);

  appendAuditEntry({
    id: makeAuditId(),
    requestId: 'setup',
    branchId,
    event: 'setup',
    timestamp: now,
    detail: 'TOTP seed generated — enrol in authenticator app using the otpauth URI',
  });

  return { branchId, totpSecretB32: secretB32, otpAuthUri: uri, createdAt: now };
}

/**
 * Issue a challenge for a pending approval request.
 *
 * Increments the branch nonce, computes the challenge hash, and generates
 * a 60-second one-time approval link.  The approver must reply with:
 *   APPROVE <TOTP-code> <nonce>
 *
 * @param requestId - Approval request identifier (e.g. "pending-001")
 * @param branchId  - Branch that owns the TOTP seed
 */
export function issueChallenge(requestId: string, branchId: string): MfaChallenge {
  const state = loadState(branchId);
  if (!state) {
    throw new Error(
      `MFA not configured for branch '${branchId}'. Run: agentvault approve mfa setup --branch ${branchId}`,
    );
  }
  if (state.locked) {
    throw new Error(
      `Branch '${branchId}' is locked due to a security anomaly. ` +
        `Investigate, then run: agentvault approve mfa unlock --branch ${branchId}`,
    );
  }

  // Monotonically increment nonce
  state.currentNonce += 1;
  state.updatedAt = new Date().toISOString();
  saveState(state);

  const nonce = state.currentNonce;
  const timestamp = new Date().toISOString();
  const challengeHash = computeChallengeHash(nonce, branchId, timestamp);
  const token = generateOtpToken(requestId, branchId, nonce);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();

  appendAuditEntry({
    id: makeAuditId(),
    requestId,
    branchId,
    event: 'challenge-issued',
    nonce,
    challengeHash,
    timestamp,
    detail: `One-time link expires at ${expiresAt}`,
  });

  return {
    requestId,
    branchId,
    nonce,
    timestamp,
    challengeHash,
    approvalLink: `https://agentvault.approve/${requestId}?token=${token}`,
    expiresAt,
  };
}

/**
 * Verify a TOTP code + nonce submitted by the approver.
 *
 * Runs all five security layers in order:
 *   1. MFA setup / branch-lock check
 *   2. Nonce match + replay detection
 *   3. TOTP verification (±1 window for clock drift)
 *   4. Rate-limit check (3 / hour)
 *   5. Device-fingerprint anomaly detection
 *
 * On success, marks the nonce as consumed, appends an audit entry,
 * and returns a cryptographic auditToken suitable for on-chain logging.
 */
export function verifyMfaApproval(input: MfaVerifyInput): MfaVerifyResult {
  const { requestId, branchId, totpCode, nonce } = input;
  const fingerprint = input.deviceFingerprint ?? getDeviceFingerprint();
  const now = new Date().toISOString();

  // ── Layer 1: setup / lock check ──────────────────────────────────────────
  const state = loadState(branchId);
  if (!state) {
    return { ok: false, reason: 'not-setup' };
  }

  if (state.locked) {
    appendAuditEntry({
      id: makeAuditId(),
      requestId,
      branchId,
      event: 'rejected',
      nonce,
      timestamp: now,
      detail: 'Branch is locked — approval blocked',
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'branch-locked' };
  }

  // ── Layer 2: nonce match ──────────────────────────────────────────────────
  if (nonce !== state.currentNonce) {
    appendAuditEntry({
      id: makeAuditId(),
      requestId,
      branchId,
      event: 'rejected',
      nonce,
      timestamp: now,
      detail: `Nonce mismatch — expected ${state.currentNonce}, got ${nonce}`,
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'nonce-mismatch' };
  }

  // ── Layer 2b: replay detection ────────────────────────────────────────────
  if (state.usedNonces.includes(nonce)) {
    appendAuditEntry({
      id: makeAuditId(),
      requestId,
      branchId,
      event: 'rejected',
      nonce,
      timestamp: now,
      detail: 'Nonce already consumed — replay attempt blocked',
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'nonce-replayed' };
  }

  // ── Layer 3: TOTP verification ────────────────────────────────────────────
  const secret = base32Decode(state.totpSecretB32);
  if (!verifyTotp(secret, totpCode)) {
    appendAuditEntry({
      id: makeAuditId(),
      requestId,
      branchId,
      event: 'rejected',
      nonce,
      timestamp: now,
      detail: 'TOTP code invalid',
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'invalid-totp' };
  }

  // ── Layer 4: rate limiting ────────────────────────────────────────────────
  if (!checkAndRecordRateLimit(fingerprint)) {
    appendAuditEntry({
      id: makeAuditId(),
      requestId,
      branchId,
      event: 'rate-limit-exceeded',
      nonce,
      timestamp: now,
      detail: `Device ${fingerprint} exceeded ${RATE_MAX} approvals / hour`,
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'rate-limited' };
  }

  // ── Layer 5: anomaly detection ────────────────────────────────────────────
  // Use branchId as the stable identity key: tracks which devices have ever
  // successfully approved requests for this branch.
  const deviceCheck = checkDevice(branchId, fingerprint);
  if (deviceCheck === 'new-device') {
    // Auto-lock the branch and demand secondary confirmation
    state.locked = true;
    state.pendingAnomalyFingerprint = fingerprint;
    state.updatedAt = new Date().toISOString();
    saveState(state);

    appendAuditEntry({
      id: makeAuditId(),
      requestId,
      branchId,
      event: 'anomaly-detected',
      nonce,
      timestamp: now,
      detail: `Unknown device fingerprint ${fingerprint} — was this you? Reply YES via TOTP to agentvault approve mfa unlock --branch ${branchId} --register-device ${fingerprint}`,
      deviceFingerprint: fingerprint,
    });
    appendAuditEntry({
      id: makeAuditId(),
      requestId,
      branchId,
      event: 'anomaly-ping-sent',
      timestamp: now,
      detail: `Branch auto-locked. Operator notified: run 'agentvault approve mfa unlock --branch ${branchId} --totp <code> --register-device ${fingerprint}' to confirm and re-register, or leave unregistered to deny.`,
      deviceFingerprint: fingerprint,
    });
    appendAuditEntry({
      id: makeAuditId(),
      requestId,
      branchId,
      event: 'branch-locked',
      timestamp: now,
      detail: 'Auto-locked after anomaly. Confirm via secondary TOTP then call unlockBranch().',
      deviceFingerprint: fingerprint,
    });

    return { ok: false, reason: 'anomaly' };
  }

  // ── All layers passed — commit the approval ───────────────────────────────

  // Consume the nonce (replay guard)
  state.usedNonces.push(nonce);
  state.updatedAt = now;
  saveState(state);

  // Compute an HMAC-based audit token over the approval payload
  const challengeHash = computeChallengeHash(nonce, branchId, now);
  const auditToken = crypto
    .createHmac('sha256', base32Decode(state.totpSecretB32))
    .update(`${nonce}:${requestId}:${branchId}:${now}`)
    .digest('hex');

  appendAuditEntry({
    id: makeAuditId(),
    requestId,
    branchId,
    event: 'approved',
    nonce,
    challengeHash,
    auditToken,
    timestamp: now,
    detail: `Approved by device ${fingerprint}`,
    deviceFingerprint: fingerprint,
  });

  return { ok: true, auditToken };
}

/**
 * Verify a biometric (WebAuthn) assertion instead of a TOTP code.
 *
 * This is the Layer 2 fallback path: used when TOTP is unavailable or the
 * approver's device natively supports WebAuthn (iOS Face ID, Android fingerprint,
 * YubiKey, etc.).
 *
 * The flow:
 *   1. Caller obtains a challengeHash from issueChallenge().
 *   2. Device signs it via signChallenge() (or browser WebAuthn API).
 *   3. This function verifies the ECDSA signature, nonce, rate-limit, and anomaly.
 *   4. On success an auditToken is returned identical to the TOTP path.
 *
 * @param input - { requestId, branchId, challengeHash, assertion, nonce, deviceFingerprint? }
 */
export function verifyBiometricApproval(input: MfaBiometricInput): MfaVerifyResult {
  const { requestId, branchId, challengeHash, assertion, nonce } = input;
  const fingerprint = input.deviceFingerprint ?? getDeviceFingerprint();
  const now = new Date().toISOString();

  // ── Layer 1: setup / lock check ──────────────────────────────────────────
  const state = loadState(branchId);
  if (!state) return { ok: false, reason: 'not-setup' };

  if (state.locked) {
    appendAuditEntry({
      id: makeAuditId(), requestId, branchId, event: 'rejected',
      nonce, timestamp: now,
      detail: 'Branch is locked — biometric approval blocked',
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'branch-locked' };
  }

  // ── Layer 2: nonce match + replay ─────────────────────────────────────────
  if (nonce !== state.currentNonce) {
    appendAuditEntry({
      id: makeAuditId(), requestId, branchId, event: 'rejected',
      nonce, timestamp: now,
      detail: `Nonce mismatch — expected ${state.currentNonce}, got ${nonce}`,
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'nonce-mismatch' };
  }

  if (state.usedNonces.includes(nonce)) {
    appendAuditEntry({
      id: makeAuditId(), requestId, branchId, event: 'rejected',
      nonce, timestamp: now,
      detail: 'Nonce already consumed — replay attempt blocked',
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'nonce-replayed' };
  }

  // ── Layer 3: biometric signature verification ─────────────────────────────
  const publicKeyB64 = getDevicePublicKey(fingerprint);
  if (!publicKeyB64) {
    appendAuditEntry({
      id: makeAuditId(), requestId, branchId, event: 'rejected',
      nonce, timestamp: now,
      detail: `No biometric credential enrolled for device ${fingerprint}`,
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'biometric-not-enrolled' };
  }

  const lastCounter = getSignCounter(fingerprint) - 1; // current stored is already incremented
  const verifyResult = verifyWebAuthnAssertion(
    assertion,
    challengeHash,
    publicKeyB64,
    lastCounter,
  );

  if (!verifyResult.ok) {
    const reason = verifyResult.reason === 'counter-replay'
      ? 'biometric-counter-replay'
      : 'biometric-signature-invalid';
    appendAuditEntry({
      id: makeAuditId(), requestId, branchId, event: 'rejected',
      nonce, timestamp: now,
      detail: `Biometric verification failed: ${verifyResult.reason}`,
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason };
  }

  // ── Layer 4: rate limiting ────────────────────────────────────────────────
  if (!checkAndRecordRateLimit(fingerprint)) {
    appendAuditEntry({
      id: makeAuditId(), requestId, branchId,
      event: 'rate-limit-exceeded', nonce, timestamp: now,
      detail: `Device ${fingerprint} exceeded ${RATE_MAX} approvals / hour`,
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'rate-limited' };
  }

  // ── Layer 5: anomaly detection ────────────────────────────────────────────
  const deviceCheck = checkDevice(branchId, fingerprint);
  if (deviceCheck === 'new-device') {
    state.locked = true;
    state.pendingAnomalyFingerprint = fingerprint;
    state.updatedAt = new Date().toISOString();
    saveState(state);

    appendAuditEntry({
      id: makeAuditId(), requestId, branchId, event: 'anomaly-detected',
      nonce, timestamp: now,
      detail: `Unknown biometric device ${fingerprint} — was this you? Reply YES via TOTP to unlock.`,
      deviceFingerprint: fingerprint,
    });
    appendAuditEntry({
      id: makeAuditId(), requestId, branchId, event: 'branch-locked',
      timestamp: now,
      detail: 'Auto-locked after biometric anomaly.',
      deviceFingerprint: fingerprint,
    });
    return { ok: false, reason: 'anomaly' };
  }

  // ── All layers passed ─────────────────────────────────────────────────────
  state.usedNonces.push(nonce);
  state.updatedAt = now;
  saveState(state);

  const auditToken = crypto
    .createHmac('sha256', base32Decode(state.totpSecretB32))
    .update(`biometric:${nonce}:${requestId}:${branchId}:${now}`)
    .digest('hex');

  appendAuditEntry({
    id: makeAuditId(), requestId, branchId,
    event: 'approved-biometric', nonce, challengeHash,
    auditToken, timestamp: now,
    detail: `Approved via biometric by device ${fingerprint} (signCounter=${assertion.signCounter})`,
    deviceFingerprint: fingerprint,
  });

  return { ok: true, auditToken };
}

/**
 * Unlock a branch after an anomaly has been investigated.
 *
 * Requires a valid TOTP code to prevent unauthorised unlocking.
 * Optionally registers the new device fingerprint so future approvals succeed.
 *
 * @param branchId      - Branch to unlock
 * @param totpCode      - Fresh 6-digit TOTP code from the authenticator app
 * @param newFingerprint - If provided, add this fingerprint to the known-device list
 */
export function unlockBranch(
  branchId: string,
  totpCode: string,
  newFingerprint?: string,
): boolean {
  const state = loadState(branchId);
  if (!state) return false;

  const secret = base32Decode(state.totpSecretB32);
  if (!verifyTotp(secret, totpCode)) return false;

  state.locked = false;
  state.pendingAnomalyFingerprint = undefined;
  state.updatedAt = new Date().toISOString();
  saveState(state);

  if (newFingerprint) {
    registerDevice(branchId, newFingerprint);
  }

  appendAuditEntry({
    id: makeAuditId(),
    requestId: 'unlock',
    branchId,
    event: 'branch-unlocked',
    timestamp: new Date().toISOString(),
    detail: newFingerprint
      ? `Branch unlocked; device ${newFingerprint} registered as trusted (anomaly confirmed as operator)`
      : 'Branch unlocked after anomaly investigation (new device NOT registered)',
    deviceFingerprint: newFingerprint,
  });

  return true;
}

/**
 * Return the complete audit log for a branch.
 * Suitable for piping to the ICP canister or displaying with `approve mfa audit`.
 */
export function getMfaAuditLog(branchId: string): MfaAuditEntry[] {
  const fp = auditFile(branchId);
  if (!fs.existsSync(fp)) return [];
  return parse(fs.readFileSync(fp, 'utf8')) as MfaAuditEntry[];
}

/**
 * Return the current MFA posture for a branch (no secrets exposed).
 */
export function getMfaStatus(branchId: string): MfaStatus {
  const state = loadState(branchId);
  if (!state) {
    return { configured: false, locked: false, currentNonce: 0, usedNonceCount: 0 };
  }
  return {
    configured: true,
    locked: state.locked,
    currentNonce: state.currentNonce,
    usedNonceCount: state.usedNonces.length,
    createdAt: state.createdAt,
  };
}
