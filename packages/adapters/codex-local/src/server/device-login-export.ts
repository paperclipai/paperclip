import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { readSubscriptionAccountId, writeCodexAuthCacheEntry } from "./codex-auth-cache.js";
import { copyBackCodexAuth } from "./codex-auth-copyback.js";
import {
  codexHomeHasUsableAuth,
  resolveManagedCodexHomeDir,
  resolveSharedCodexHomeDir,
} from "./codex-home.js";

// The credential export. It installs a device-login credential into a unique,
// run-scoped, private proof home. It handles the empty-home first-login case and
// a later strictly-newer, same-identity update. It removes the proof home on
// every terminal path.
//
// Security (Control 2): the export never accepts an arbitrary host-home
// argument. It derives a unique, run-scoped proof home under a dedicated
// company-scoped root. It rejects the default, the shared, and every managed
// Codex home. It calls `lstat` on the proof-home path and rejects a symlink or a
// non-regular file. It creates the root and the proof home at mode 0700. It
// stages and renames `auth.json` at mode 0600 under a directory lock (through the
// reused seed writer and copy-back helpers). It enforces a bounded-size,
// subscription-only auth shape before any write, so it rejects an API-key, a
// malformed, and an oversized payload. It never logs token bytes.

const PROOF_ROOT_DIR_NAME = "codex-device-login-proof";
// A private directory (owner rwx only). 0o700 has no group or other bits.
const PRIVATE_DIR_MODE = 0o700;
// The managed Codex home directory always uses this name (see
// `resolveManagedCodexHomeDir`). The export rejects any target with this name,
// so a shared company home and a per-agent home are both refused.
const MANAGED_HOME_DIR_NAME = "codex-home";
const AUTH_FILE_NAME = "auth.json";

// A bounded size for the credential payload. A real subscription `auth.json` is
// a few kilobytes. The export refuses a larger payload before any parse or write.
export const MAX_AUTH_JSON_BYTES = 64 * 1024;

export type InstallDeviceLoginOutcome = "seeded" | "updated" | "kept";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Sanitizes one raw value to a single safe path segment. Rejects an empty value,
 * a relative segment, a path separator, and a NUL byte, so the value can never
 * become a path traversal. Returns the trimmed, safe segment.
 */
function requireSafeSegment(value: string, label: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) throw new Error(`device-login export: ${label} is empty`);
  if (trimmed === "." || trimmed === "..") {
    throw new Error(`device-login export: ${label} is a relative path segment`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(`device-login export: ${label} contains a path separator`);
  }
  if (path.basename(trimmed) !== trimmed) {
    throw new Error(`device-login export: ${label} is not a single path segment`);
  }
  return trimmed;
}

/** Reduces a run id to a safe, bounded path segment. Never throws. */
function toSafeRunSegment(value: string | null): string {
  const cleaned = (value ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "run";
}

/**
 * Resolves the company-scoped proof-home root under the same isolation boundary
 * as the managed Codex home. The root is always company-scoped, so a proof home
 * can never cross a company boundary. `companyId` is required and is sanitized to
 * a single safe path segment.
 */
export function resolveProofHomeRoot(env: NodeJS.ProcessEnv = process.env, companyId: string): string {
  const safeCompanyId = requireSafeSegment(companyId, "companyId");
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", safeCompanyId, PROOF_ROOT_DIR_NAME);
}

export interface DeriveProofHomeInput {
  env?: NodeJS.ProcessEnv;
  companyId?: string;
  runId?: string;
}

/**
 * Returns a unique, run-scoped proof-home path under the company-scoped root.
 * The path carries the run id and a fresh random suffix, so two calls never
 * collide and every proof home is tied to its run.
 */
export function deriveProofHome(input: DeriveProofHomeInput = {}): string {
  const env = input.env ?? process.env;
  const companyId = requireSafeSegment(
    input.companyId ?? nonEmpty(env.PAPERCLIP_COMPANY_ID) ?? "",
    "companyId",
  );
  const runSegment = toSafeRunSegment(input.runId ?? nonEmpty(env.PAPERCLIP_RUN_ID));
  const root = resolveProofHomeRoot(env, companyId);
  return path.resolve(root, `${runSegment}-${randomUUID()}`);
}

/**
 * Rejects a target that is the shared, the default, or a managed Codex home, or
 * that is not strictly under the company-scoped proof root. This guard runs
 * before any filesystem write, so the export never writes outside its own root.
 */
function assertProofHomeIsSafeTarget(
  resolved: string,
  env: NodeJS.ProcessEnv,
  companyId: string,
): void {
  const shared = path.resolve(resolveSharedCodexHomeDir(env));
  if (resolved === shared) {
    throw new Error("device-login export: refused the shared or default Codex home");
  }
  const managed = path.resolve(resolveManagedCodexHomeDir(env, companyId));
  if (resolved === managed) {
    throw new Error("device-login export: refused the managed company Codex home");
  }
  if (path.basename(resolved) === MANAGED_HOME_DIR_NAME) {
    throw new Error("device-login export: refused a managed Codex home");
  }
  const root = resolveProofHomeRoot(env, companyId);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("device-login export: the proof home must be under the company-scoped proof root");
  }
}

/**
 * Enforces the bounded-size, subscription-only auth shape. Returns the
 * subscription `account_id` on success. Rejects an empty, an oversized, an
 * API-key, and a malformed payload. Never puts token bytes into the error.
 */
function assertUsableSubscriptionShape(bytes: Buffer): void {
  if (bytes.length === 0) {
    throw new Error("device-login export: refused an empty auth payload");
  }
  if (bytes.length > MAX_AUTH_JSON_BYTES) {
    throw new Error("device-login export: refused an oversized auth payload");
  }
  const accountId = readSubscriptionAccountId(bytes);
  if (!accountId) {
    // Covers an API-key payload, a malformed payload, and an unusable payload.
    throw new Error("device-login export: refused a non-subscription auth payload");
  }
}

/**
 * Ensures one directory exists and is private (mode 0700). Uses `lstat` (not
 * `stat`), so the export never writes through a planted symlink. Fails closed
 * when the existing path is a symlink or a non-directory.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  const existing = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("device-login export: the proof-home path is a symlink or a non-directory");
    }
    await chmod(dir, PRIVATE_DIR_MODE);
    return;
  }
  await mkdir(dir, { mode: PRIVATE_DIR_MODE });
  await chmod(dir, PRIVATE_DIR_MODE);
}

/**
 * Rejects an existing `auth.json` that is a symlink or a non-regular file. An
 * absent file is the normal first-install case.
 */
async function assertAuthPathIsRegularOrAbsent(authPath: string): Promise<void> {
  const existing = await lstat(authPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("device-login export: refused a symlink or a non-regular auth.json");
  }
}

export interface InstallDeviceLoginCredentialInput {
  /** The sandbox `auth.json` bytes read back from the login sandbox. */
  sandboxAuthBytes: Buffer;
  /** The run-scoped proof home from {@link deriveProofHome}. */
  proofHome: string;
  /** A non-leaking progress sink. It receives only fixed status lines. */
  log: (line: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  companyId?: string;
}

/**
 * Installs the sandbox credential into the run-scoped proof home. Seeds an empty
 * home. Applies a strictly-newer, same-identity update to a non-empty home.
 * Keeps the home otherwise. Enforces Control 2 before any write: the target
 * safety guard, the auth-shape gate, and the path-safety guard all run first.
 * Never logs token bytes.
 */
export async function installDeviceLoginCredential(
  input: InstallDeviceLoginCredentialInput,
): Promise<InstallDeviceLoginOutcome> {
  const { sandboxAuthBytes, log } = input;
  const env = input.env ?? process.env;
  const companyId = requireSafeSegment(
    input.companyId ?? nonEmpty(env.PAPERCLIP_COMPANY_ID) ?? "",
    "companyId",
  );
  const proofHome = path.resolve(input.proofHome);

  // 1. Target safety (pure path logic). Reject a shared, default, or managed
  //    home, or a path outside the proof root, before any filesystem work.
  assertProofHomeIsSafeTarget(proofHome, env, companyId);

  // 2. Auth-shape gate. Reject an empty, oversized, API-key, or malformed
  //    payload before any directory is created.
  assertUsableSubscriptionShape(sandboxAuthBytes);

  // 3. Path safety. Create the root and the proof home at mode 0700, each
  //    guarded by `lstat`.
  const root = resolveProofHomeRoot(env, companyId);
  await mkdir(path.dirname(root), { recursive: true });
  await ensurePrivateDir(root);
  await ensurePrivateDir(proofHome);

  const authPath = path.join(proofHome, AUTH_FILE_NAME);
  await assertAuthPathIsRegularOrAbsent(authPath);

  // 4. Decide first install versus update.
  const hadUsableAuth = await codexHomeHasUsableAuth(proofHome);
  if (!hadUsableAuth) {
    // First install: the copy-back predicate fails closed on an absent
    // destination, so the seed writer fills the empty home. The seed writer
    // stages and renames `auth.json` at mode 0600 under a directory lock.
    const outcome = await writeCodexAuthCacheEntry({
      sandboxAuthBytes,
      cacheEntryPath: authPath,
      log,
    });
    return outcome === "written" ? "seeded" : "kept";
  }

  // Update: install the credential only when it is strictly newer for the same
  // subscription identity. `copyBackCodexAuth` runs the same decision predicate
  // and the same 0600 staged rename under the directory lock.
  const outcome = await copyBackCodexAuth({
    readSandboxAuth: async () => sandboxAuthBytes,
    hostAuthPath: authPath,
    log,
    env,
  });
  return outcome === "copied" ? "updated" : "kept";
}

export interface RemoveProofHomeInput {
  env?: NodeJS.ProcessEnv;
  companyId?: string;
}

/**
 * Removes the proof home. Refuses a path outside the company-scoped proof root,
 * so a cleanup can never delete the shared, the default, or a managed home. A
 * missing proof home is a benign no-op.
 */
export async function removeProofHome(
  proofHome: string,
  input: RemoveProofHomeInput = {},
): Promise<void> {
  const env = input.env ?? process.env;
  const companyId = requireSafeSegment(
    input.companyId ?? nonEmpty(env.PAPERCLIP_COMPANY_ID) ?? "",
    "companyId",
  );
  const resolved = path.resolve(proofHome);
  const root = resolveProofHomeRoot(env, companyId);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("device-login export: refused to remove a path outside the proof root");
  }
  await rm(resolved, { recursive: true, force: true });
}
