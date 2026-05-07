import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import type { SecretProviderModule, StoredSecretVersionMaterial } from "./types.js";
import { badRequest } from "../errors.js";

export interface LocalEncryptedMaterial extends StoredSecretVersionMaterial {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
}

function resolveMasterKeyFilePath() {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return path.resolve(process.cwd(), "data/secrets/master.key");
}

function assertMasterKeyLength(masterKey: Buffer) {
  if (masterKey.length !== 32) {
    throw badRequest("Invalid local encrypted secrets master key");
  }
}

export function decodeLocalEncryptedMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }

  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}

export function generateLocalEncryptedMasterKey(): Buffer {
  return randomBytes(32);
}

export function formatLocalEncryptedMasterKey(masterKey: Buffer): string {
  assertMasterKeyLength(masterKey);
  return masterKey.toString("base64");
}

export function readLocalEncryptedMasterKeyFile(keyPath: string): Buffer {
  const raw = readFileSync(keyPath, "utf8");
  const decoded = decodeLocalEncryptedMasterKey(raw);
  if (!decoded) {
    throw badRequest(`Invalid secrets master key at ${keyPath}`);
  }
  return decoded;
}

function loadOrCreateMasterKey(): Buffer {
  const envKeyRaw = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envKeyRaw && envKeyRaw.trim().length > 0) {
    const fromEnv = decodeLocalEncryptedMasterKey(envKeyRaw);
    if (!fromEnv) {
      throw badRequest(
        "Invalid PAPERCLIP_SECRETS_MASTER_KEY (expected 32-byte base64, 64-char hex, or raw 32-char string)",
      );
    }
    return fromEnv;
  }

  const keyPath = resolveMasterKeyFilePath();
  if (existsSync(keyPath)) {
    return readLocalEncryptedMasterKeyFile(keyPath);
  }

  const dir = path.dirname(keyPath);
  mkdirSync(dir, { recursive: true });
  const generated = generateLocalEncryptedMasterKey();
  writeFileSync(keyPath, formatLocalEncryptedMasterKey(generated), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best effort
  }
  return generated;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function encryptLocalEncryptedValueWithKey(
  masterKey: Buffer,
  value: string,
): LocalEncryptedMaterial {
  assertMasterKeyLength(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptLocalEncryptedValueWithKey(
  masterKey: Buffer,
  material: LocalEncryptedMaterial,
): string {
  assertMasterKeyLength(masterKey);
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

export function asLocalEncryptedMaterial(value: StoredSecretVersionMaterial): LocalEncryptedMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === "local_encrypted_v1" &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.ciphertext === "string"
  ) {
    return value as LocalEncryptedMaterial;
  }
  throw badRequest("Invalid local_encrypted secret material");
}

export function rekeyLocalEncryptedMaterial(
  material: StoredSecretVersionMaterial,
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): LocalEncryptedMaterial {
  const plain = decryptLocalEncryptedValueWithKey(
    oldMasterKey,
    asLocalEncryptedMaterial(material),
  );
  return encryptLocalEncryptedValueWithKey(newMasterKey, plain);
}

export const localEncryptedProvider: SecretProviderModule = {
  id: "local_encrypted",
  descriptor: {
    id: "local_encrypted",
    label: "Local encrypted (default)",
    requiresExternalRef: false,
  },
  async createVersion(input) {
    const masterKey = loadOrCreateMasterKey();
    return {
      material: encryptLocalEncryptedValueWithKey(masterKey, input.value),
      valueSha256: sha256Hex(input.value),
      externalRef: null,
    };
  },
  async resolveVersion(input) {
    const masterKey = loadOrCreateMasterKey();
    return decryptLocalEncryptedValueWithKey(masterKey, asLocalEncryptedMaterial(input.material));
  },
};
