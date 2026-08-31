import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

// The Grok credential home. `GROK_HOME` replaces `~/.grok` and holds one file,
// `auth.json`. Unlike Codex, a Grok `auth.json` has no fixed top-level key: it
// holds exactly one key, and that key is a composite `<issuer>::<uuid>` value.
// This module resolves the company-scoped home path and reads its usable-auth
// shape. It never writes the file; {@link promoteGrokDeviceLoginCredential} in
// `adapter-auth-promotion.ts` owns the write.

const AUTH_FILE_NAME = "auth.json";

// Matches the composite `<issuer>::<uuid>` top-level key. The issuer is a
// non-empty string — an OIDC issuer URL such as `https://issuer.x.ai` holds
// colons of its own — so this anchors on the LAST `::` before a standard
// 8-4-4-4-12 hex UUID at the end of the string (the greedy `.+` backtracks
// to that last separator).
const GROK_IDENTITY_KEY_RE =
  /^.+::[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** One parsed Grok auth payload: the composite identity key and its value object. */
export interface GrokAuthPayload {
  identityKey: string;
  value: Record<string, unknown>;
}

/**
 * Parses a decoded JSON value into a {@link GrokAuthPayload}. Returns null when
 * the value is not an object, holds zero or more than one top-level key, or the
 * single key does not match the `<issuer>::<uuid>` shape, or its value is not an
 * object. Never assumes a fixed key name.
 */
export function parseGrokAuthPayload(raw: unknown): GrokAuthPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1) return null;
  const [identityKey] = keys as [string];
  if (!GROK_IDENTITY_KEY_RE.test(identityKey)) return null;
  const value = (raw as Record<string, unknown>)[identityKey];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return { identityKey, value: value as Record<string, unknown> };
}

/** True when the payload value holds the two fields a run needs to authenticate. */
export function hasUsableGrokAuthValue(value: Record<string, unknown>): boolean {
  const key = value.key;
  const refreshToken = value.refresh_token;
  return (
    typeof key === "string" &&
    key.trim().length > 0 &&
    typeof refreshToken === "string" &&
    refreshToken.trim().length > 0
  );
}

/**
 * True when `home` has a usable `auth.json`: a single `<issuer>::<uuid>`
 * top-level key whose value holds a non-empty `key` and `refresh_token`. A
 * missing file, invalid JSON, or an unusable shape all resolve false.
 */
export async function grokHomeHasUsableAuth(home: string): Promise<boolean> {
  const authPath = path.join(home, AUTH_FILE_NAME);
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = parseGrokAuthPayload(JSON.parse(raw));
    return parsed !== null && hasUsableGrokAuthValue(parsed.value);
  } catch {
    return false;
  }
}

/**
 * Resolves the managed Grok home directory. With a `companyId`, it resolves the
 * company-scoped home under the Paperclip instance tree, the same isolation
 * boundary `resolveManagedCodexHomeDir` uses. Without one, it resolves the
 * instance-global home, which a promotion must never write.
 */
export function resolveManagedGrokHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "grok-home")
    : path.resolve(instanceRoot, "grok-home");
}
