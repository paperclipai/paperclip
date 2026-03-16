import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { badRequest } from "../errors.js";

interface StoredLlmCredential {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Resolve the master key file path.
 * Uses PAPERCLIP_SECRETS_MASTER_KEY_FILE if set, otherwise defaults to data/secrets/master.key
 */
function resolveMasterKeyFilePath() {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return path.resolve(process.cwd(), "data/secrets/master.key");
}

/**
 * Decode a master key from hex, base64, or raw string format.
 * Returns null if the key is invalid.
 */
function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try hex format (64 chars)
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // Try base64 format
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }

  // Try raw UTF-8 format (32 chars)
  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }

  return null;
}

/**
 * Load or create the master encryption key.
 * 1. Checks PAPERCLIP_SECRETS_MASTER_KEY env var
 * 2. Checks PAPERCLIP_SECRETS_MASTER_KEY_FILE
 * 3. Creates and saves a new key if needed
 */
function loadOrCreateMasterKey(): Buffer {
  const envKeyRaw = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envKeyRaw && envKeyRaw.trim().length > 0) {
    const fromEnv = decodeMasterKey(envKeyRaw);
    if (!fromEnv) {
      throw badRequest(
        "Invalid PAPERCLIP_SECRETS_MASTER_KEY (expected 32-byte base64, 64-char hex, or raw 32-char string)",
      );
    }
    return fromEnv;
  }

  const keyPath = resolveMasterKeyFilePath();
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8");
    const decoded = decodeMasterKey(raw);
    if (!decoded) {
      throw badRequest(`Invalid secrets master key at ${keyPath}`);
    }
    return decoded;
  }

  const dir = path.dirname(keyPath);
  mkdirSync(dir, { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(keyPath, generated.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best effort
  }
  return generated;
}

/**
 * Encrypt an LLM API key using AES-256-GCM.
 * Returns the encrypted payload with scheme, IV, auth tag, and ciphertext.
 */
export function encryptLlmApiKey(apiKey: string): StoredLlmCredential {
  const masterKey = loadOrCreateMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);

  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypt an LLM API key from stored encrypted material.
 */
export function decryptLlmApiKey(material: StoredLlmCredential): string {
  const masterKey = loadOrCreateMasterKey();
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");

  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

/**
 * Validate encrypted material structure.
 */
export function asStoredLlmCredential(value: unknown): StoredLlmCredential {
  if (
    value &&
    typeof value === "object" &&
    "scheme" in value &&
    value.scheme === "local_encrypted_v1" &&
    typeof (value as any).iv === "string" &&
    typeof (value as any).tag === "string" &&
    typeof (value as any).ciphertext === "string"
  ) {
    return value as StoredLlmCredential;
  }
  throw badRequest("Invalid encrypted LLM credential material");
}

/**
 * Get the last 6 characters of an API key for display/fingerprinting.
 */
export function getKeyFingerprint(apiKey: string): string {
  return apiKey.slice(-6).toUpperCase();
}

/**
 * Compute SHA256 hash of an API key for duplicate detection.
 */
export function getKeyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}
