import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDefaultSecretsKeyFilePath } from "../home-paths.js";
import type {
  PreparedSecretVersion,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  StoredSecretVersionMaterial,
} from "./types.js";
import { badRequest } from "../errors.js";

interface LocalEncryptedMaterial extends StoredSecretVersionMaterial {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
}

function resolveMasterKeyFilePath() {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return resolveDefaultSecretsKeyFilePath();
}

function decodeMasterKey(raw: string): Buffer | null {
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
    enforceKeyFilePermissionsBestEffort(keyPath);
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

function enforceKeyFilePermissionsBestEffort(keyPath: string) {
  try {
    const mode = statSync(keyPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      chmodSync(keyPath, 0o600);
    }
  } catch {
    // best effort only; health checks surface persistent permission problems.
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function prepareManagedVersion(value: string): PreparedSecretVersion {
  const masterKey = loadOrCreateMasterKey();
  const valueSha256 = sha256Hex(value);
  return {
    material: encryptValue(masterKey, value),
    valueSha256,
    fingerprintSha256: valueSha256,
    externalRef: null,
  };
}

async function inspectLocalEncryptedHealth(): Promise<SecretProviderHealthCheck> {
  const envKeyRaw = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envKeyRaw && envKeyRaw.trim().length > 0) {
    if (!decodeMasterKey(envKeyRaw)) {
      return {
        provider: "local_encrypted",
        status: "error",
        message:
          "PAPERCLIP_SECRETS_MASTER_KEY is invalid; expected 32-byte base64, 64-char hex, or raw 32-char string",
      };
    }
    return {
      provider: "local_encrypted",
      status: "ok",
      message: "Local encrypted provider is using PAPERCLIP_SECRETS_MASTER_KEY",
      backupGuidance: [
        "Back up the configured master key separately from the database.",
        "A restore needs both the database metadata and the same master key.",
      ],
      details: { keySource: "env" },
    };
  }

  const keyPath = resolveMasterKeyFilePath();
  if (!existsSync(keyPath)) {
    return {
      provider: "local_encrypted",
      status: "warn",
      message: `Secrets key file does not exist yet: ${keyPath}`,
      warnings: ["The first managed secret write will create this key file with 0600 permissions."],
      backupGuidance: [
        "Back up the key file together with database backups.",
        "The database alone cannot restore local encrypted secret values.",
      ],
      details: { keySource: "file", keyFilePath: keyPath },
    };
  }

  let mode: number | null = null;
  try {
    mode = statSync(keyPath).mode & 0o777;
  } catch (err) {
    return {
      provider: "local_encrypted",
      status: "error",
      message: `Could not stat secrets key file: ${err instanceof Error ? err.message : String(err)}`,
      details: { keySource: "file", keyFilePath: keyPath },
    };
  }

  try {
    const raw = readFileSync(keyPath, "utf8");
    if (!decodeMasterKey(raw)) {
      return {
        provider: "local_encrypted",
        status: "error",
        message: `Invalid key material in ${keyPath}`,
        details: { keySource: "file", keyFilePath: keyPath },
      };
    }
  } catch (err) {
    return {
      provider: "local_encrypted",
      status: "error",
      message: `Could not read secrets key file: ${err instanceof Error ? err.message : String(err)}`,
      details: { keySource: "file", keyFilePath: keyPath },
    };
  }

  const warnings =
    mode !== null && (mode & 0o077) !== 0
      ? [`Secrets key file permissions are ${mode.toString(8)}; run chmod 600 ${keyPath}`]
      : [];
  return {
    provider: "local_encrypted",
    status: warnings.length > 0 ? "warn" : "ok",
    message: `Local encrypted provider configured with key file ${keyPath}`,
    warnings,
    backupGuidance: [
      "Back up the key file together with database backups.",
      "The database alone cannot restore local encrypted secret values.",
    ],
    details: { keySource: "file", keyFilePath: keyPath },
  };
}

function encryptValue(masterKey: Buffer, value: string): LocalEncryptedMaterial {
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

function decryptValue(masterKey: Buffer, material: LocalEncryptedMaterial): string {
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

function asLocalEncryptedMaterial(value: StoredSecretVersionMaterial): LocalEncryptedMaterial {
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

export const localEncryptedProvider: SecretProviderModule = {
  id: "local_encrypted",
  descriptor() {
    return {
      id: "local_encrypted",
      label: "Local encrypted (default)",
      requiresExternalRef: false,
      supportsManagedValues: true,
      supportsExternalReferences: false,
      configured: true,
    };
  },
  async validateConfig(input): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    if (input?.deploymentMode === "authenticated" && input.strictMode !== true) {
      warnings.push("Strict secret mode should be enabled for authenticated deployments");
    }
    const health = await inspectLocalEncryptedHealth();
    if (health.status === "error") {
      throw badRequest(health.message);
    }
    warnings.push(...(health.warnings ?? []));
    return { ok: true, warnings };
  },
  async createSecret(input) {
    return prepareManagedVersion(input.value);
  },
  async createVersion(input) {
    return prepareManagedVersion(input.value);
  },
  async linkExternalSecret() {
    throw badRequest("local_encrypted does not support external reference secrets");
  },
  async resolveVersion(input) {
    const masterKey = loadOrCreateMasterKey();
    return decryptValue(masterKey, asLocalEncryptedMaterial(input.material));
  },
  async deleteOrArchive() {
    // Secret metadata deletion is handled in Paperclip DB; the local key is shared and must remain.
  },
  async healthCheck() {
    return inspectLocalEncryptedHealth();
  },
};
