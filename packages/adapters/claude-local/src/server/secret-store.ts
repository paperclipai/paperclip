import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { secretbox } from "@noble/ciphers/salsa.js";

/**
 * Pluggable secret store contract for `claude_local`.
 *
 * Phase 1 ships a single implementation (`EncryptedFileSecretStore`) backed
 * by `~/.paperclip/secrets/<companyId>.json` encrypted with XSalsa20-Poly1305
 * (NaCl `crypto_secretbox`). A future `KeyringSecretStore` can be added
 * without touching call sites.
 *
 * Refs use the `secrets://<key>` scheme — for example
 * `secrets://gh/paperclip-foundingeng`. The store sees just `<key>`
 * (`gh/paperclip-foundingeng`).
 */
export interface SecretStore {
  resolve(ref: string): Promise<string | null>;
  put(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  list(): Promise<string[]>;
}

export const SECRETS_REF_SCHEME = "secrets://";
export const SECRET_STORE_SELECTOR_ENV = "PAPERCLIP_SECRET_STORE";

const MASTER_KEY_LEN = 32;
const NONCE_LEN = 24;

/** Strip the `secrets://` scheme. Returns null when the ref is not a `secrets://` ref or the key is unsafe. */
export function parseSecretsRef(ref: string): string | null {
  if (typeof ref !== "string" || !ref.startsWith(SECRETS_REF_SCHEME)) return null;
  const key = ref.slice(SECRETS_REF_SCHEME.length).trim();
  if (key.length === 0) return null;
  // Defense in depth: keys are looked up by name in a JSON map; reject anything that smells like a path.
  if (key.includes("..") || key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    return null;
  }
  return key;
}

function normalizeKey(refOrKey: string): string {
  const key = parseSecretsRef(
    refOrKey.startsWith(SECRETS_REF_SCHEME) ? refOrKey : `${SECRETS_REF_SCHEME}${refOrKey}`,
  );
  if (key === null) {
    throw new Error(`invalid secret key "${refOrKey}"`);
  }
  return key;
}

export interface EncryptedFileSecretStoreOptions {
  companyId: string;
  /** Defaults to `~/.paperclip/secrets`. */
  rootDir?: string;
  /** Defaults to `<rootDir>/.master.key`. */
  masterKeyPath?: string;
}

/**
 * `EncryptedFileSecretStore` — Phase 1 implementation.
 *
 * - Master key: 32 random bytes, mode 0600, owner-only. Boot-checked on every load.
 * - Per-company file: `<rootDir>/<companyId>.json`, mode 0600, owner-only.
 * - AEAD: NaCl `crypto_secretbox` (XSalsa20-Poly1305) via `@noble/ciphers` — audited (Cure53),
 *   pure JS, no native build. Equivalent primitive to libsodium `crypto_secretbox`; we picked
 *   noble for the no-build-toolchain ergonomics (already in the workspace lockfile).
 */
export class EncryptedFileSecretStore implements SecretStore {
  readonly companyId: string;
  readonly rootDir: string;
  readonly masterKeyPath: string;
  readonly secretsFilePath: string;

  constructor(opts: EncryptedFileSecretStoreOptions) {
    if (!opts.companyId || !/^[A-Za-z0-9._-]+$/.test(opts.companyId)) {
      throw new Error(`EncryptedFileSecretStore: invalid companyId "${opts.companyId}"`);
    }
    this.companyId = opts.companyId;
    this.rootDir = opts.rootDir ?? path.join(os.homedir(), ".paperclip", "secrets");
    this.masterKeyPath = opts.masterKeyPath ?? path.join(this.rootDir, ".master.key");
    this.secretsFilePath = path.join(this.rootDir, `${this.companyId}.json`);
  }

  async resolve(ref: string): Promise<string | null> {
    const key = parseSecretsRef(ref);
    if (key === null) return null;
    const master = await this.loadMasterKey();
    let file: SecretsFile;
    try {
      file = await this.loadSecretsFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const entry = file.entries[key];
    if (!entry) return null;
    const nonce = decodeBase64(entry.nonce, `secret "${key}" nonce`);
    const ciphertext = decodeBase64(entry.ciphertext, `secret "${key}" ciphertext`);
    if (nonce.length !== NONCE_LEN) {
      throw new Error(`secret "${key}" has invalid nonce length ${nonce.length} (expected ${NONCE_LEN})`);
    }
    try {
      const plaintext = secretbox(master, nonce).open(ciphertext);
      return Buffer.from(plaintext).toString("utf8");
    } catch (err) {
      throw new Error(
        `secret "${key}" failed to decrypt — master key may be wrong or ciphertext is corrupted (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  async put(ref: string, value: string): Promise<void> {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("secret value must be a non-empty string");
    }
    const key = normalizeKey(ref);
    const master = await this.loadMasterKey();
    const nonce = crypto.randomBytes(NONCE_LEN);
    const ciphertext = secretbox(master, nonce).seal(Buffer.from(value, "utf8"));
    await ensureSecureDir(this.rootDir);
    let file: SecretsFile;
    try {
      file = await this.loadSecretsFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        file = { version: 1, entries: {} };
      } else {
        throw err;
      }
    }
    file.entries[key] = {
      nonce: Buffer.from(nonce).toString("base64"),
      ciphertext: Buffer.from(ciphertext).toString("base64"),
      createdAt: new Date().toISOString(),
    };
    await this.writeSecretsFile(file);
  }

  async delete(ref: string): Promise<void> {
    const key = normalizeKey(ref);
    let file: SecretsFile;
    try {
      file = await this.loadSecretsFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (!(key in file.entries)) return;
    delete file.entries[key];
    await this.writeSecretsFile(file);
  }

  async list(): Promise<string[]> {
    try {
      const file = await this.loadSecretsFile();
      return Object.keys(file.entries).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Exposed for tests + CLI surface; production callers should go through `resolve`. */
  async loadMasterKey(): Promise<Buffer> {
    await assertSecretFileMode(this.masterKeyPath, "master key");
    const raw = await fs.readFile(this.masterKeyPath);
    if (raw.length !== MASTER_KEY_LEN) {
      throw new Error(
        `master key at ${this.masterKeyPath} has invalid length ${raw.length} (expected ${MASTER_KEY_LEN})`,
      );
    }
    return raw;
  }

  private async loadSecretsFile(): Promise<SecretsFile> {
    await assertSecretFileMode(this.secretsFilePath, "secrets file");
    const raw = await fs.readFile(this.secretsFilePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `secrets file ${this.secretsFilePath} contains invalid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.entries)) {
      throw new Error(
        `secrets file ${this.secretsFilePath} is not a recognized format (expected { version: 1, entries: {...} })`,
      );
    }
    const entries: Record<string, SecretsEntry> = {};
    for (const [k, v] of Object.entries(parsed.entries)) {
      if (!isPlainObject(v) || typeof v.nonce !== "string" || typeof v.ciphertext !== "string") {
        throw new Error(`secrets file ${this.secretsFilePath} has malformed entry "${k}"`);
      }
      entries[k] = {
        nonce: v.nonce,
        ciphertext: v.ciphertext,
        createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date(0).toISOString(),
      };
    }
    return { version: 1, entries };
  }

  private async writeSecretsFile(file: SecretsFile): Promise<void> {
    const body = `${JSON.stringify(file, null, 2)}\n`;
    const tmpPath = `${this.secretsFilePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmpPath, body, { encoding: "utf8", mode: 0o600 });
    try {
      await fs.chmod(tmpPath, 0o600);
    } catch {
      // best-effort on filesystems without POSIX mode bits
    }
    await fs.rename(tmpPath, this.secretsFilePath);
    try {
      await fs.chmod(this.secretsFilePath, 0o600);
    } catch {
      // best-effort
    }
  }
}

interface SecretsFile {
  version: 1;
  entries: Record<string, SecretsEntry>;
}

interface SecretsEntry {
  nonce: string;
  ciphertext: string;
  createdAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string, label: string): Buffer {
  const buf = Buffer.from(value, "base64");
  // Buffer.from("base64") silently strips invalid chars; sanity-check round-trip length.
  if (buf.length === 0 && value.length > 0) {
    throw new Error(`${label} is not valid base64`);
  }
  return buf;
}

async function ensureSecureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // best-effort
  }
}

/**
 * Refuse to read the file if it is not 0600 or not owned by the current uid.
 * No silent fallback — misconfigured permissions should fail loudly so the operator notices.
 */
async function assertSecretFileMode(file: string, label: string): Promise<void> {
  if (process.platform === "win32") return; // POSIX mode bits are meaningless on Windows
  const stat = await fs.stat(file);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `${label} at ${file} has unsafe permissions ${mode.toString(8).padStart(3, "0")} (expected 600). ` +
        `Run: chmod 600 "${file}"`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) {
    throw new Error(
      `${label} at ${file} is owned by uid ${stat.uid} but current uid is ${uid}. ` +
        `Refusing to read another user's secret material.`,
    );
  }
}

/**
 * Idempotent master-key initializer used by `paperclipai secrets init`.
 * Returns `{ created: false }` if the file already exists (no error — safe to re-run).
 */
export async function initMasterKey(
  opts: { masterKeyPath?: string; rootDir?: string } = {},
): Promise<{ path: string; created: boolean; rootDir: string }> {
  const rootDir = opts.rootDir ?? path.join(os.homedir(), ".paperclip", "secrets");
  const masterKeyPath = opts.masterKeyPath ?? path.join(rootDir, ".master.key");
  await ensureSecureDir(rootDir);
  try {
    await fs.access(masterKeyPath);
    return { path: masterKeyPath, created: false, rootDir };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = crypto.randomBytes(MASTER_KEY_LEN);
  // `wx` flag = fail if file exists, so two concurrent inits don't race.
  await fs.writeFile(masterKeyPath, key, { mode: 0o600, flag: "wx" });
  try {
    await fs.chmod(masterKeyPath, 0o600);
  } catch {
    // best-effort
  }
  return { path: masterKeyPath, created: true, rootDir };
}

/**
 * Factory: pick the right SecretStore based on the env selector.
 * Phase 1 only supports `file`; unknown selectors throw loudly so misconfig is visible.
 */
export function createDefaultSecretStore(opts: {
  companyId: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  rootDir?: string;
}): SecretStore {
  const env = opts.env ?? process.env;
  const selector = (env[SECRET_STORE_SELECTOR_ENV] ?? "file").trim().toLowerCase();
  if (selector === "file") {
    return new EncryptedFileSecretStore({ companyId: opts.companyId, rootDir: opts.rootDir });
  }
  throw new Error(
    `${SECRET_STORE_SELECTOR_ENV}=${selector} is not supported in Phase 1 (only "file" is available)`,
  );
}

export const __testing = {
  MASTER_KEY_LEN,
  NONCE_LEN,
  assertSecretFileMode,
};
