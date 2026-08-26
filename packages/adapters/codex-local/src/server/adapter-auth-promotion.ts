import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureCodexAuthCacheEntryDir,
  isCodexAuthCacheEnabled,
  readSubscriptionAccountId,
  writeCodexAuthCacheEntry,
} from "./codex-auth-cache.js";
import { writeCredentialSeedOrNewer } from "./codex-auth-seed-write.js";
import { codexHomeHasUsableAuth, resolveManagedCodexHomeDir } from "./codex-home.js";
import { assertUsableSubscriptionShape } from "./device-login-export.js";

// The device-login credential promotion. It runs after a successful device
// login, on the exact credential the login sandbox produced. It runs an
// independent readiness check first, then validates the credential with the
// export rules, then writes the credential into the company scope only.
//
// The helper never writes the instance-global host (`CODEX_HOME` or `~/.codex`),
// because that source has no `companyId`. It writes two company-scoped targets:
// the company credential home and the company per-identity cache slot. The
// company home write is the first-login host rule: the cache vend never seeds an
// empty host, so a first login must seed the company home directly.
//
// Two decisions gate the write:
//   - Decision C: only a user-initiated login seeds the company slot. An
//     automatic background path never seeds an empty slot.
//   - Decision H: the helper writes only while the session still holds the sole
//     active claim on `(company_id, adapter_type)`. This is defense in depth over
//     the partial unique index, so a second session cannot race the same slot.
//
// The helper preserves company scope, private modes, atomic rename, the
// directory lock, and redacted logs. It never logs token bytes or a raw
// `account_id`.

const AUTH_FILE_NAME = "auth.json";
// A private directory (owner rwx only). 0o700 has no group or other bits.
const PRIVATE_DIR_MODE = 0o700;

/** The independent readiness result for the exact staged credential. */
export interface CredentialReadinessResult {
  /** True when a run launched now with this exact credential would authenticate. */
  ready: boolean;
  /** An optional non-secret reason code for a non-ready result. */
  reason?: string;
}

/** Thrown when the independent readiness check does not return a ready result.
 *  The service maps this to a failed session and still deletes the sandbox. */
export class DeviceLoginReadinessError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`device-login promotion: the readiness check did not pass (${reason})`);
    this.name = "DeviceLoginReadinessError";
    this.reason = reason;
  }
}

// A private directory (owner rwx only) for the throwaway readiness home.
const READINESS_HOME_DIR_MODE = 0o700;
// A private file (owner rw only) for the throwaway readiness credential.
const READINESS_AUTH_FILE_MODE = 0o600;

/**
 * The independent readiness check for a staged device-login credential. It runs
 * on the exact staged bytes, before any promotion write. It writes the bytes to
 * a throwaway private home and runs the same usable-auth predicate the execute
 * path uses. It always removes the throwaway home before it returns.
 *
 * A ready result means a run launched now with this exact credential would
 * authenticate. A non-ready result rejects the promotion, and the caller writes
 * nothing. The function reads and writes no company scope and logs no bytes.
 */
export async function checkStagedCredentialReadiness(
  authBytes: Buffer,
): Promise<CredentialReadinessResult> {
  if (authBytes.length === 0) {
    return { ready: false, reason: "empty_credential" };
  }
  const scratchHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-login-readiness-"));
  try {
    await mkdir(scratchHome, { recursive: true, mode: READINESS_HOME_DIR_MODE });
    await writeFile(path.join(scratchHome, AUTH_FILE_NAME), authBytes, {
      mode: READINESS_AUTH_FILE_MODE,
    });
    const ready = await codexHomeHasUsableAuth(scratchHome);
    return ready ? { ready: true } : { ready: false, reason: "no_usable_auth" };
  } finally {
    await rm(scratchHome, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The promotion outcome.
 *
 * - `promoted`: the helper wrote the company home (a seed or a strictly-newer
 *   same-identity update). The helper then tries the per-identity cache slot when
 *   the cache is on. The cache write is best-effort: a cache failure keeps the
 *   `promoted` outcome, because the company home is already durable.
 * - `kept`: the login carried the SAME identity as the company home, and the home
 *   already held a newer same-identity credential, so the home was kept. This is a
 *   successful authentication: a later run vends and uses the same account. The
 *   helper still tries the best-effort cache write.
 * - `kept_foreign_identity`: the login carried a DIFFERENT identity than the
 *   company home. The helper never clobbers an occupied home, so it kept the other
 *   account and installed nothing durable for this login. The identity-anchored
 *   vend reads the home identity first, so a later run can never select this
 *   login. This is NOT a successful authentication; the caller must fail the
 *   session instead of a report of `authenticated`.
 * - `not_sole_owner`: Decision H rejected the write. Nothing was written.
 * - `background_skipped`: Decision C rejected the write (an automatic background
 *   path never seeds a company slot). Nothing was written.
 */
export type PromoteDeviceLoginCredentialOutcome =
  | "promoted"
  | "kept"
  | "kept_foreign_identity"
  | "not_sole_owner"
  | "background_skipped";

export interface PromoteDeviceLoginCredentialInput {
  /** The exact staged credential bytes the login sandbox produced. */
  authBytes: Buffer;
  /** The company that owns this login. It must be a single safe path segment. */
  companyId: string;
  /**
   * True when a user started this login. Decision C: only a user-initiated login
   * seeds the company slot. An automatic background path never seeds it.
   */
  userInitiated: boolean;
  /**
   * The independent, machine-readable readiness check. It runs on the exact
   * staged credential with the normal execution precedence, before any write. A
   * non-ready result rejects the promotion (the session fails), and the helper
   * writes nothing.
   */
  checkReadiness: (
    authBytes: Buffer,
  ) => Promise<CredentialReadinessResult> | CredentialReadinessResult;
  /**
   * Decision H: resolves true only while this session still holds the sole active
   * claim on `(company_id, adapter_type)` (the internal `promoting` state). The
   * helper writes only when it resolves true.
   */
  isSoleActiveOwner: () => Promise<boolean> | boolean;
  /** A non-leaking progress sink. It receives only fixed status lines. */
  log: (line: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** Rejects an empty or unsafe `companyId`, so a promotion can never resolve the
 *  instance-global home (`resolveManagedCodexHomeDir` with no `companyId`) or
 *  escape the company tree. */
function requireSafeCompanyId(companyId: string): string {
  const trimmed = typeof companyId === "string" ? companyId.trim() : "";
  if (trimmed.length === 0) {
    throw new Error("device-login promotion: companyId is empty");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("device-login promotion: companyId is a relative path segment");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("device-login promotion: companyId contains a path separator");
  }
  return trimmed;
}

/**
 * Promotes a device-login credential into the company scope. The order is fixed:
 * readiness check, credential validation, Decision C, Decision H, then the writes.
 * The readiness check and the writes run while the caller still holds the active
 * claim, so a second session cannot race the same slot.
 */
export async function promoteDeviceLoginCredential(
  input: PromoteDeviceLoginCredentialInput,
): Promise<PromoteDeviceLoginCredentialOutcome> {
  const { authBytes, userInitiated, checkReadiness, isSoleActiveOwner, log } = input;
  const env = input.env ?? process.env;
  const companyId = requireSafeCompanyId(input.companyId);

  // 1. Independent readiness check on the exact staged credential. A non-ready
  //    result rejects the promotion before any validation or write.
  const readiness = await checkReadiness(authBytes);
  if (!readiness.ready) {
    throw new DeviceLoginReadinessError(readiness.reason ?? "not_ready");
  }

  // 2. Validate the credential with the export rules. This rejects an empty, an
  //    oversized, an API-key, a non-subscription, and a malformed payload.
  assertUsableSubscriptionShape(authBytes);
  const accountId = readSubscriptionAccountId(authBytes);
  if (!accountId) {
    // The shape gate above already guarantees a subscription identity; this guard
    // keeps the account_id non-null for the cache key without a non-null cast.
    throw new Error("device-login promotion: the credential has no subscription identity");
  }

  // 3. Decision C: only a user-initiated login seeds the company slot.
  if (!userInitiated) {
    await log("[paperclip] Codex device-login promotion: skipped (an automatic background login never seeds a company slot).");
    return "background_skipped";
  }

  // 4. Decision H: write only while the session still owns the active slot.
  const soleOwner = await isSoleActiveOwner();
  if (!soleOwner) {
    await log("[paperclip] Codex device-login promotion: skipped (the session no longer holds the sole active claim on the slot).");
    return "not_sole_owner";
  }

  // 5a. First-login host rule: seed or update the company credential home. The
  //     shared writer seeds an empty home and applies a strictly-newer
  //     same-identity update; it keeps a newer same-identity or a different
  //     identity. It never touches the instance-global host.
  const companyHome = resolveManagedCodexHomeDir(env, companyId);
  await mkdir(companyHome, { recursive: true, mode: PRIVATE_DIR_MODE });
  const companyHomeAuthPath = path.join(companyHome, AUTH_FILE_NAME);
  const homeOutcome = await writeCredentialSeedOrNewer({
    sourceBytes: authBytes,
    destinationPath: companyHomeAuthPath,
    seedIfDestAbsent: true,
    log,
    writtenLine: "[paperclip] Codex device-login promotion: wrote the company credential home at mode 0600.",
    keptLine: "[paperclip] Codex device-login promotion: kept the company credential home (the login is not a seed or a strictly-newer same-identity credential).",
    tempPrefix: "auth.json.promotion-home",
    errorLabel: "codex device-login promotion",
    env,
  });

  // A kept home has two very different meanings. The writer keeps the home when
  // it already holds a newer SAME-identity credential (a genuine success: a later
  // run vends and uses the same account), and it also keeps the home when the home
  // holds a DIFFERENT identity (the writer never clobbers an occupied home). The
  // second case installed nothing durable for this login: the home still holds the
  // other account, and the identity-anchored vend reads the home identity first,
  // so it can never select this login. Compare the login identity with the kept
  // home identity, so the caller can fail the session instead of a report of
  // `authenticated`. A home that this helper cannot read as the same identity is
  // treated as a foreign identity; the caller fails closed.
  let foreignIdentityKeep = false;
  if (homeOutcome === "kept") {
    const homeBytes = await readFile(companyHomeAuthPath).catch(() => null);
    const homeAccountId = homeBytes ? readSubscriptionAccountId(homeBytes) : null;
    foreignIdentityKeep = homeAccountId !== accountId;
  }

  // 5b. Record the credential in its per-identity company cache slot, so a later
  //     run can vend a strictly-newer copy. The cache write respects the
  //     off-switch. It is company-scoped and per identity, so it never crosses a
  //     company boundary and never clobbers a different identity.
  //
  //     The company home write above already made the credential durable, so a
  //     later run authenticates from the home even when the cache slot is absent.
  //     The cache is only a vend optimization. So a cache write failure (a
  //     permission error, a full disk, or a lock timeout) must not fail the
  //     promotion, or the operator sees a failed login for a credential that is
  //     already usable. Log the failure and keep the home outcome; a later run
  //     re-seeds the cache slot from the durable home.
  if (isCodexAuthCacheEnabled(env)) {
    try {
      const cacheEntryPath = await ensureCodexAuthCacheEntryDir(env, accountId, companyId);
      await writeCodexAuthCacheEntry({ sandboxAuthBytes: authBytes, cacheEntryPath, log, env });
    } catch {
      await log(
        "[paperclip] Codex device-login promotion: the per-identity cache write failed; the company credential home is durable, so the login stays successful.",
      );
    }
  }

  if (homeOutcome === "written") {
    return "promoted";
  }
  return foreignIdentityKeep ? "kept_foreign_identity" : "kept";
}
