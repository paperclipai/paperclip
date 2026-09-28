import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { parseMuseAuthApiKey } from "./muse-auth.js";

// The company-scoped Muse credential home. A completed sandbox device login
// that is not tied to an AI connection promotes its Meta API key here, and
// `execute` reads it into META_API_KEY when nothing else is bound. Only the key
// is ever written: never the OAuth token or the account's name or email.

const KEY_FILE_NAME = "api-key";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_AUTH_JSON_BYTES = 64 * 1024;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireSafeCompanyId(companyId: string): string {
  const trimmed = typeof companyId === "string" ? companyId.trim() : "";
  if (trimmed.length === 0) throw new Error("muse device-login promotion: companyId is empty");
  if (trimmed === "." || trimmed === "..") throw new Error("muse device-login promotion: companyId is a relative path segment");
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("muse device-login promotion: companyId contains a path separator");
  }
  return trimmed;
}

/** `<instanceRoot>/companies/<companyId>/muse-home`. */
export function resolveManagedMuseHomeDir(env: NodeJS.ProcessEnv, companyId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", requireSafeCompanyId(companyId), "muse-home");
}

export interface CredentialReadinessResult {
  ready: boolean;
  reason?: string;
}

/** Offline readiness: the staged Muse auth file carries a usable Meta API key. */
export function checkStagedMuseCredentialReadiness(authBytes: Buffer): CredentialReadinessResult {
  if (authBytes.length === 0) return { ready: false, reason: "empty_credential" };
  if (authBytes.length > MAX_AUTH_JSON_BYTES) return { ready: false, reason: "oversized_credential" };
  return parseMuseAuthApiKey(authBytes.toString("utf8")) ? { ready: true } : { ready: false, reason: "no_usable_key" };
}

export type PromoteMuseDeviceLoginCredentialOutcome = "promoted" | "not_sole_owner" | "background_skipped";

export interface PromoteMuseDeviceLoginCredentialInput {
  authBytes: Buffer;
  companyId: string;
  userInitiated: boolean;
  isSoleActiveOwner: () => Promise<boolean> | boolean;
  log: (line: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Promotes a Muse device-login credential into the company scope. Order:
 * readiness, key extraction, user-initiated gate, sole-owner gate, atomic
 * write. A later user-initiated login replaces the key (last writer wins).
 */
export async function promoteMuseDeviceLoginCredential(
  input: PromoteMuseDeviceLoginCredentialInput,
): Promise<PromoteMuseDeviceLoginCredentialOutcome> {
  const env = input.env ?? process.env;
  const home = resolveManagedMuseHomeDir(env, input.companyId);
  const readiness = checkStagedMuseCredentialReadiness(input.authBytes);
  if (!readiness.ready) throw new Error(`muse device-login promotion: the credential is not ready (${readiness.reason})`);
  const key = parseMuseAuthApiKey(input.authBytes.toString("utf8"));
  if (!key) throw new Error("muse device-login promotion: the credential has no usable key");
  if (!input.userInitiated) {
    await input.log("[paperclip] Muse device-login promotion: skipped (an automatic background login never seeds a company slot).");
    return "background_skipped";
  }
  if (!(await input.isSoleActiveOwner())) {
    await input.log("[paperclip] Muse device-login promotion: skipped (the session no longer holds the sole active claim on the slot).");
    return "not_sole_owner";
  }
  await mkdir(home, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(home, PRIVATE_DIR_MODE);
  const target = path.join(home, KEY_FILE_NAME);
  const staged = path.join(home, `.api-key-${process.pid}-${randomUUID()}.tmp`);
  const handle = await open(staged, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(key);
    await handle.close();
    await rename(staged, target);
    await chmod(target, PRIVATE_FILE_MODE);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(staged, { force: true }).catch(() => undefined);
  }
  await input.log("[paperclip] Muse device-login promotion: wrote the company Muse key at mode 0600.");
  return "promoted";
}

/** The company's promoted Muse key, or null when none exists or it is unusable. */
export async function readCompanyMuseApiKey(env: NodeJS.ProcessEnv, companyId: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(resolveManagedMuseHomeDir(env, companyId), KEY_FILE_NAME), "utf8");
  } catch {
    return null;
  }
  const key = raw.trim();
  return /^LLM\|[A-Za-z0-9_\-|]{20,200}$/.test(key) ? key : null;
}
