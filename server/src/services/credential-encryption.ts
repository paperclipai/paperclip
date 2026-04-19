import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { badRequest, unprocessable } from "../errors.js";

export type EncryptedCredentialMaterial = {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
  [key: string]: unknown;
};

function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }
  if (Buffer.byteLength(trimmed, "utf8") === 32) return Buffer.from(trimmed, "utf8");
  return null;
}

function resolveMasterKeyFilePath() {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return path.resolve(process.cwd(), "data/secrets/master.key");
}

let cachedKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const credentialEnv = process.env.PAPERCLIP_CREDENTIAL_KEY;
  if (credentialEnv && credentialEnv.trim().length > 0) {
    const fromEnv = decodeMasterKey(credentialEnv);
    if (!fromEnv) {
      throw badRequest(
        "Invalid PAPERCLIP_CREDENTIAL_KEY (expected 32-byte base64, 64-char hex, or raw 32-char string)",
      );
    }
    cachedKey = fromEnv;
    return fromEnv;
  }

  const secretsEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (secretsEnv && secretsEnv.trim().length > 0) {
    const fromEnv = decodeMasterKey(secretsEnv);
    if (fromEnv) {
      cachedKey = fromEnv;
      return fromEnv;
    }
  }

  const keyPath = resolveMasterKeyFilePath();
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8");
    const decoded = decodeMasterKey(raw);
    if (decoded) {
      cachedKey = decoded;
      return decoded;
    }
  }

  throw unprocessable(
    "Credential encryption key not configured. Set PAPERCLIP_CREDENTIAL_KEY or PAPERCLIP_SECRETS_MASTER_KEY to a 32-byte base64/hex value.",
  );
}

export function isCredentialKeyConfigured(): boolean {
  try {
    loadMasterKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptCredential(payload: Record<string, unknown>): EncryptedCredentialMaterial {
  const key = loadMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function isEncryptedCredentialMaterial(value: unknown): value is EncryptedCredentialMaterial {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.scheme === "local_encrypted_v1" &&
    typeof v.iv === "string" &&
    typeof v.tag === "string" &&
    typeof v.ciphertext === "string"
  );
}

export function decryptCredential(material: unknown): Record<string, unknown> {
  if (!isEncryptedCredentialMaterial(material)) {
    throw badRequest("Invalid credential material");
  }
  const key = loadMasterKey();
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(plain.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("Decrypted credential payload is not an object");
  }
  return parsed as Record<string, unknown>;
}
