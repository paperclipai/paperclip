import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toAccountHandle } from "@paperclipai/shared";
import {
  ensureCodexAuthCacheEntryDirExclusive,
  readSubscriptionAccountId,
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
// this account's own home, and — only as a fallback for an agent with no bound
// secret — the company default home.
//
// This account's own home is the durable result of a login: the write is fail
// loud, and the caller names it with a company secret so any agent can bind to
// it. The company default home is a best-effort fallback: it is seeded only the
// first time any account logs in for the company (while it holds no usable
// credential yet), and a write failure there never fails the login.
//
// Two decisions gate the write:
//   - Decision C: only a user-initiated login seeds a home. An automatic
//     background path never seeds one.
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
 * - `promoted`: the helper wrote this account's own home (a seed for a first
 *   login of this account, or a strictly-newer update for a repeat login). The
 *   helper also seeds the company default home when it holds no usable
 *   credential yet.
 * - `kept`: the login carried a credential that is not newer than what this
 *   account's own home already holds, so the home was kept as-is. This is
 *   still a successful authentication: a later run reads the same home.
 * - `not_sole_owner`: Decision H rejected the write. Nothing was written.
 * - `background_skipped`: Decision C rejected the write (an automatic background
 *   path never seeds a home). Nothing was written.
 */
export type PromoteDeviceLoginCredentialOutcome = "promoted" | "kept" | "not_sole_owner" | "background_skipped";

/**
 * The promotion result. `accountId` and `accountHomeDir` are set once the
 * credential's identity is known — every outcome below the handle-validation
 * step carries `accountId`; only `promoted` and `kept` reach the write step and
 * carry `accountHomeDir`.
 *
 * `accountHomeCreated` is true only when this account's own home directory was
 * absent right before this call created it. The check and the creation run
 * under one lock, so a concurrent promotion for the same account (a second
 * login for the same Codex account) never also reports `created: true` for a
 * directory the first call already made. A caller that must undo a later
 * failure (for example, a failed secret write) should remove the directory
 * only when `accountHomeCreated` is true, and should still re-check that no
 * company secret now names this account's home before it deletes: the
 * absence of a company secret at the time this call started is not proof
 * that this login is the only login that used the directory. A user can also
 * delete the secret and keep the account home, so a repeat login then reads
 * no secret. `accountHomeCreated` is false for every outcome that does not
 * reach the write step (`not_sole_owner`, `background_skipped`).
 */
export interface PromoteDeviceLoginCredentialResult {
  outcome: PromoteDeviceLoginCredentialOutcome;
  accountId: string | null;
  accountHomeDir: string | null;
  accountHomeCreated: boolean;
}

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
 * readiness check, credential validation, account-handle validation, Decision C,
 * Decision H, then the writes. The readiness check and the writes run while the
 * caller still holds the active claim, so a second session cannot race the same
 * slot.
 */
export async function promoteDeviceLoginCredential(
  input: PromoteDeviceLoginCredentialInput,
): Promise<PromoteDeviceLoginCredentialResult> {
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
    // keeps the account_id non-null for the handle conversion without a non-null
    // cast.
    throw new Error("device-login promotion: the credential has no subscription identity");
  }

  // 2b. Convert the identity into a safe account handle. The handle names both
  //     this account's own home directory and its company secret, so a login
  //     whose identity cannot form one must fail before any write.
  const accountHandle = toAccountHandle(accountId);
  if (!accountHandle) {
    throw new Error("device-login promotion: the account identifier cannot form a valid account handle");
  }

  // 3. Decision C: only a user-initiated login seeds a home.
  if (!userInitiated) {
    await log("[paperclip] Codex device-login promotion: skipped (an automatic background login never seeds a home).");
    return { outcome: "background_skipped", accountId, accountHomeDir: null, accountHomeCreated: false };
  }

  // 4. Decision H: write only while the session still owns the active slot.
  const soleOwner = await isSoleActiveOwner();
  if (!soleOwner) {
    await log("[paperclip] Codex device-login promotion: skipped (the session no longer holds the sole active claim on the slot).");
    return { outcome: "not_sole_owner", accountId, accountHomeDir: null, accountHomeCreated: false };
  }

  // 5a. This account's own home is the durable result of a login: each account
  //     handle addresses exactly one home, so this write can never collide with
  //     a different identity, and a write failure here fails the whole
  //     promotion (fail loud, unlike the company default home fallback below).
  //     Two different logins can promote the same account at the same time
  //     (each login owns its own promotion slot), so the absence check and the
  //     directory creation run inside one lock: only the caller that truly
  //     finds the directory absent gets `created: true`. A plain
  //     check-then-create sequence here would let two concurrent callers for
  //     the same account both see the directory as absent and both believe
  //     they created it.
  const { entryPath: accountHomeAuthPath, created: accountHomeCreated } =
    await ensureCodexAuthCacheEntryDirExclusive(env, accountHandle, companyId);
  const accountHomeDir = path.dirname(accountHomeAuthPath);
  const accountHomeOutcome = await writeCredentialSeedOrNewer({
    sourceBytes: authBytes,
    destinationPath: accountHomeAuthPath,
    seedIfDestAbsent: true,
    log,
    writtenLine: "[paperclip] Codex device-login promotion: wrote this account's own home at mode 0600.",
    keptLine: "[paperclip] Codex device-login promotion: kept this account's own home (the login is not a seed or a strictly-newer credential).",
    tempPrefix: "auth.json.promotion-account-home",
    errorLabel: "codex device-login promotion",
    env,
  });

  // 5b. Company default home fallback, for an agent with no bound secret. Seed
  //     it only the first time any account logs in for the company, i.e. only
  //     while it holds no usable credential yet; a login for a second account
  //     must never touch it once some account has claimed it. This write is
  //     best-effort: this account's own home above is already durable, so a
  //     failure here (a permission error, a full disk, a lock timeout) must not
  //     fail the promotion.
  const companyHome = resolveManagedCodexHomeDir(env, companyId);
  if (!(await codexHomeHasUsableAuth(companyHome))) {
    try {
      await mkdir(companyHome, { recursive: true, mode: PRIVATE_DIR_MODE });
      const companyHomeAuthPath = path.join(companyHome, AUTH_FILE_NAME);
      await writeCredentialSeedOrNewer({
        sourceBytes: authBytes,
        destinationPath: companyHomeAuthPath,
        seedIfDestAbsent: true,
        log,
        writtenLine: "[paperclip] Codex device-login promotion: seeded the company default home.",
        keptLine: "[paperclip] Codex device-login promotion: kept the company default home.",
        tempPrefix: "auth.json.promotion-home",
        errorLabel: "codex device-login promotion",
        env,
      });
    } catch {
      await log(
        "[paperclip] Codex device-login promotion: seeding the company default home failed; this account's own home is durable, so the login stays successful.",
      );
    }
  }

  return {
    outcome: accountHomeOutcome === "written" ? "promoted" : "kept",
    accountId,
    accountHomeDir,
    accountHomeCreated,
  };
}
