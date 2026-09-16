import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

// The Grok credential home. `GROK_HOME` replaces `~/.grok` and holds one file,
// `auth.json`. Unlike Codex, a Grok `auth.json` has no fixed top-level key: it
// holds exactly one key, and that key is a composite `<issuer>::<uuid>` value.
// This module resolves the company-scoped home path and reads its usable-auth
// shape. It never writes to the managed home itself; {@link
// promoteGrokDeviceLoginCredential} in `adapter-auth-promotion.ts` owns that
// write. {@link stageGrokHomeForSync} writes only to a fresh, private staging
// directory it creates for a sandbox run.

const AUTH_FILE_NAME = "auth.json";

/**
 * The allowlist of managed `GROK_HOME` entries that the grok-local adapter
 * stages into the sandbox `home` asset (see {@link stageGrokHomeForSync}).
 * Paperclip writes instructions and skills under the workspace, not under the
 * Grok home, so the credential file is the only entry a sandbox run needs.
 */
export const GROK_SYNC_ALLOWLIST = ["auth.json"] as const;

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

export interface StageGrokHomeForSyncOptions {
  /** Run id, used only to make the staged temp-dir name traceable in logs. */
  runId?: string;
}

/**
 * Reads `candidate` and dereferences a symlink to its target bytes. Returns
 * null for a missing file or a dangling symlink (both resolve to `ENOENT`);
 * any other read error propagates to the caller.
 */
async function readFileBytesIfPresent(candidate: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Stages exactly {@link GROK_SYNC_ALLOWLIST} from `effectiveGrokHome` into a
 * fresh private temp dir and returns its path, for registration as the sandbox
 * `home` asset. Mirrors `stageCodexHomeForSync` in the codex-local adapter.
 *
 * - **The symlink is dereferenced to bytes** — the single-use `auth.json`
 *   credential (a symlink into the shared source home) lands as a real file,
 *   never a dangling link.
 * - **A missing `auth.json` is not an error** — a company with no completed
 *   device login yet stages an empty directory.
 * - **`mkdtemp` guarantees the staged dir is `0700`** on POSIX, and the staged
 *   `auth.json` is written `0600` (least privilege).
 * - **Fail-closed** — any *unexpected* I/O error removes the partial temp dir
 *   and re-throws, so a run never proceeds with a partial staged home.
 *
 * The caller owns removing the returned dir on run teardown.
 */
export async function stageGrokHomeForSync(
  effectiveGrokHome: string,
  options: StageGrokHomeForSyncOptions = {},
): Promise<string> {
  const runIdPart = nonEmpty(options.runId ?? undefined);
  const stagedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), `paperclip-grok-home-sync-${runIdPart ? `${runIdPart}-` : ""}`),
  );
  try {
    for (const entry of GROK_SYNC_ALLOWLIST) {
      const bytes = await readFileBytesIfPresent(path.join(effectiveGrokHome, entry));
      if (bytes === null) continue;
      const target = path.join(stagedHome, entry);
      await fs.writeFile(target, bytes, { mode: 0o600 });
      // Explicit chmod so the mode is 0600 regardless of the process umask.
      await fs.chmod(target, 0o600);
    }
    return stagedHome;
  } catch (error) {
    // Fail-closed: never hand back a partial staged home. Remove the temp dir
    // we created before propagating the failure.
    await fs.rm(stagedHome, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
