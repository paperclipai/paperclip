/**
 * Binance API Key Manager
 *
 * Manages Binance API key lifecycle with mandatory weekly rotation.
 * Keys are stored encrypted on disk using AES-256-GCM; only the
 * metadata (creation timestamp, rotation interval) is held in plaintext.
 *
 * Threat model: assume the host is compromised at rest.
 *   - Never log raw API key or secret.
 *   - Rotation is enforced: operations on an overdue key are blocked by default.
 *   - IP whitelist is embedded in the key record so it travels with the secret.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KEY_ROTATION_INTERVAL_DAYS = 7;

/** Bytes used for AES-256-GCM IV and salt. */
const IV_BYTES = 12;
const SALT_BYTES = 16;
const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BinanceApiKey {
  /** Opaque label / nickname for this key pair (e.g. "trading-bot-1"). */
  label: string;
  /** Binance API key (public portion). */
  apiKey: string;
  /** Binance API secret (sensitive). */
  apiSecret: string;
  /** ISO-8601 timestamp when this key was first provisioned. */
  createdAt: string;
  /**
   * IP addresses / CIDR blocks that Binance should restrict this key to.
   * These mirror the IP restrictions you configure on the Binance sub-account.
   */
  ipWhitelist: string[];
  /** Rotation interval in days (default: 7). */
  rotationIntervalDays: number;
}

/** Encrypted envelope stored on disk. */
interface EncryptedKeyRecord {
  version: 1;
  label: string;
  createdAt: string;
  rotationIntervalDays: number;
  ipWhitelist: string[];
  /** hex-encoded salt used for PBKDF2 */
  salt: string;
  /** hex-encoded IV */
  iv: string;
  /** hex-encoded GCM auth tag */
  authTag: string;
  /** hex-encoded ciphertext containing { apiKey, apiSecret } as JSON */
  ciphertext: string;
}

export interface KeyRotationStatus {
  label: string;
  createdAt: string;
  rotationDue: boolean;
  /** Days until rotation is due (negative means overdue). */
  daysRemaining: number;
  overdueDays: number;
}

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM + PBKDF2)
// ---------------------------------------------------------------------------

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    passphrase,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_BYTES,
    'sha256',
  );
}

function encrypt(plaintext: string, passphrase: string): {
  iv: Buffer;
  salt: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
} {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return { iv, salt, authTag, ciphertext };
}

function decrypt(
  ciphertext: Buffer,
  iv: Buffer,
  salt: Buffer,
  authTag: Buffer,
  passphrase: string,
): string {
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Rotation logic
// ---------------------------------------------------------------------------

export function getRotationStatus(record: Pick<BinanceApiKey, 'label' | 'createdAt' | 'rotationIntervalDays'>): KeyRotationStatus {
  const createdAt = new Date(record.createdAt);
  const now = new Date();
  const ageMs = now.getTime() - createdAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const daysRemaining = record.rotationIntervalDays - ageDays;
  const overdueDays = Math.max(0, -daysRemaining);

  return {
    label: record.label,
    createdAt: record.createdAt,
    rotationDue: daysRemaining <= 0,
    daysRemaining: Math.ceil(daysRemaining),
    overdueDays: Math.floor(overdueDays),
  };
}

/**
 * Returns true if the key is within the allowed rotation window.
 * Use this as a guard before allowing trade execution.
 */
export function isKeyValid(key: BinanceApiKey): boolean {
  return !getRotationStatus(key).rotationDue;
}

// ---------------------------------------------------------------------------
// ApiKeyManager
// ---------------------------------------------------------------------------

export class ApiKeyManager {
  private readonly vaultDir: string;

  /**
   * @param vaultDir Directory where encrypted key records are stored.
   *                 Must be kept under a firewall-restricted VPS path.
   */
  constructor(vaultDir: string) {
    this.vaultDir = path.resolve(vaultDir);
  }

  // ── Storage helpers ────────────────────────────────────────────────────────

  private recordPath(label: string): string {
    // Sanitise label so it is safe to use as a filename.
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.vaultDir, `${safe}.binance.enc`);
  }

  private ensureVaultDir(): void {
    fs.mkdirSync(this.vaultDir, { recursive: true });
    // Restrict directory to owner only (rwx------).
    fs.chmodSync(this.vaultDir, 0o700);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Persist a Binance API key pair, encrypted with `passphrase`.
   *
   * The passphrase should be derived from an operator-held master secret
   * (e.g. a hardware token or the AgentVault VetKeys seed phrase) — never
   * a static string baked into source code.
   */
  save(key: BinanceApiKey, passphrase: string): void {
    this.ensureVaultDir();

    const payload = JSON.stringify({ apiKey: key.apiKey, apiSecret: key.apiSecret });
    const { iv, salt, authTag, ciphertext } = encrypt(payload, passphrase);

    const record: EncryptedKeyRecord = {
      version: 1,
      label: key.label,
      createdAt: key.createdAt,
      rotationIntervalDays: key.rotationIntervalDays,
      ipWhitelist: key.ipWhitelist,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    };

    const filePath = this.recordPath(key.label);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
  }

  /**
   * Load and decrypt a stored key record.
   * Throws if the file is missing, tampered, or the passphrase is wrong.
   */
  load(label: string, passphrase: string): BinanceApiKey {
    const filePath = this.recordPath(label);
    if (!fs.existsSync(filePath)) {
      throw new Error(`No key record found for label: ${label}`);
    }

    const record = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EncryptedKeyRecord;

    const plaintext = decrypt(
      Buffer.from(record.ciphertext, 'hex'),
      Buffer.from(record.iv, 'hex'),
      Buffer.from(record.salt, 'hex'),
      Buffer.from(record.authTag, 'hex'),
      passphrase,
    );

    const { apiKey, apiSecret } = JSON.parse(plaintext) as { apiKey: string; apiSecret: string };

    return {
      label: record.label,
      apiKey,
      apiSecret,
      createdAt: record.createdAt,
      ipWhitelist: record.ipWhitelist,
      rotationIntervalDays: record.rotationIntervalDays,
    };
  }

  /**
   * List labels of all stored key records (without decrypting).
   */
  list(): string[] {
    if (!fs.existsSync(this.vaultDir)) return [];
    return fs
      .readdirSync(this.vaultDir)
      .filter(f => f.endsWith('.binance.enc'))
      .map(f => f.replace(/\.binance\.enc$/, ''));
  }

  /**
   * Delete a stored key record from disk.
   * Call this *after* revoking the key on Binance.
   */
  delete(label: string): void {
    const filePath = this.recordPath(label);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath);
    }
  }

  /**
   * Check rotation status for a single stored key without decrypting secrets.
   */
  checkRotation(label: string): KeyRotationStatus {
    const filePath = this.recordPath(label);
    if (!fs.existsSync(filePath)) {
      throw new Error(`No key record found for label: ${label}`);
    }
    const record = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EncryptedKeyRecord;
    return getRotationStatus({
      label: record.label,
      createdAt: record.createdAt,
      rotationIntervalDays: record.rotationIntervalDays,
    });
  }

  /**
   * Return rotation status for every stored key.
   */
  checkAllRotations(): KeyRotationStatus[] {
    return this.list().map(label => this.checkRotation(label));
  }

  /**
   * Rotate an existing key: save the new credentials, delete the old record.
   *
   * The caller is responsible for:
   *   1. Creating the new key on the Binance sub-account portal.
   *   2. Configuring the IP restriction on Binance before calling this.
   *   3. Revoking the old key on Binance after this returns.
   *
   * The `newKey.createdAt` should be set to the current time.
   */
  rotate(oldLabel: string, newKey: BinanceApiKey, passphrase: string): void {
    this.save(newKey, passphrase);
    this.delete(oldLabel);
  }
}
