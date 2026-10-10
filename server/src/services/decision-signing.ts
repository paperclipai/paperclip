import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDefaultSecretsKeyFilePath } from "../home-paths.js";

const VERSION = "decision-spec-v1";
const MIN_SECRET_LENGTH = 32;

function resolveGeneratedSecretFilePath() {
  return path.join(path.dirname(resolveDefaultSecretsKeyFilePath()), "decision-signing.key");
}

function assertOwnedByCurrentUser(stats: Stats, description: string) {
  if (process.platform === "win32") return;

  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stats.uid !== currentUserId) {
    throw new Error(`${description} must be owned by the Paperclip process user`);
  }
}

function enforceKeyFilePermissions(keyPath: string) {
  let stats = lstatSync(keyPath);
  if (!stats.isFile()) {
    throw new Error(`Decision signing key at ${keyPath} must be a regular file`);
  }
  assertOwnedByCurrentUser(stats, `Decision signing key at ${keyPath}`);
  if (process.platform === "win32") return;

  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    chmodSync(keyPath, 0o600);
    stats = lstatSync(keyPath);
    if (!stats.isFile()) {
      throw new Error(`Decision signing key at ${keyPath} must be a regular file`);
    }
    assertOwnedByCurrentUser(stats, `Decision signing key at ${keyPath}`);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Decision signing key at ${keyPath} must have permissions 0600`);
    }
  }
}

function enforceSecretsDirectoryPermissions(directoryPath: string) {
  let stats = lstatSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error(`Decision signing secrets directory at ${directoryPath} must be a directory`);
  }
  assertOwnedByCurrentUser(stats, `Decision signing secrets directory at ${directoryPath}`);
  if (process.platform === "win32") return;

  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    chmodSync(directoryPath, 0o700);
    stats = lstatSync(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error(`Decision signing secrets directory at ${directoryPath} must be a directory`);
    }
    assertOwnedByCurrentUser(stats, `Decision signing secrets directory at ${directoryPath}`);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Decision signing secrets directory at ${directoryPath} must have permissions 0700`);
    }
  }
}

function readGeneratedSecret(keyPath: string): string {
  enforceKeyFilePermissions(keyPath);
  const existing = readFileSync(keyPath, "utf8").trim();
  if (existing.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `Invalid decision signing key at ${keyPath} (must be at least ${MIN_SECRET_LENGTH} characters); remove the file to regenerate it or set PAPERCLIP_DECISION_SIGNING_SECRET`,
    );
  }
  return existing;
}

function isAlreadyExists(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isNotFound(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function loadOrCreateGeneratedSecret(): string {
  const keyPath = resolveGeneratedSecretFilePath();
  const secretsDirectoryPath = path.dirname(keyPath);
  try {
    enforceSecretsDirectoryPermissions(secretsDirectoryPath);
    return readGeneratedSecret(keyPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  mkdirSync(secretsDirectoryPath, { recursive: true, mode: 0o700 });
  enforceSecretsDirectoryPermissions(secretsDirectoryPath);
  const generated = randomBytes(32).toString("base64");
  const temporaryPath = `${keyPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    writeFileSync(temporaryPath, generated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    enforceKeyFilePermissions(temporaryPath);

    try {
      // Publish only a complete key. A hard link is atomic and never replaces
      // a key another server process created first.
      linkSync(temporaryPath, keyPath);
      enforceKeyFilePermissions(keyPath);
      return generated;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return readGeneratedSecret(keyPath);
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export function resolveDecisionSigningSecret(): string {
  const fromEnv = process.env.PAPERCLIP_DECISION_SIGNING_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `PAPERCLIP_DECISION_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters when set (unset it to use an auto-generated key)`,
      );
    }
    return fromEnv;
  }
  return loadOrCreateGeneratedSecret();
}

/**
 * Startup guard: resolves the signing secret once so an invalid explicit
 * PAPERCLIP_DECISION_SIGNING_SECRET fails fast and the generated key file is
 * materialized before the first decision write. A missing env var is not an
 * error — the secret is auto-generated and persisted per instance.
 */
export function ensureDecisionSigningSecret() {
  resolveDecisionSigningSecret();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signDecisionSpec(value: unknown) {
  return `${VERSION}.${createHmac("sha256", resolveDecisionSigningSecret()).update(`${VERSION}:${canonical(value)}`).digest("hex")}`;
}

export function verifyDecisionSpec(value: unknown, signature: string) {
  const expected = Buffer.from(signDecisionSpec(value));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
