import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import {
  grokHomeHasUsableAuth,
  parseGrokAuthPayload,
  hasUsableGrokAuthValue,
  resolveManagedGrokHomeDir,
  type GrokAuthPayload,
} from "./grok-home.js";
import { USE_SOURCE_EXIT, decideGrokAuthMerge } from "./grok-auth-merge-decision.js";

// The Grok device-login credential promotion. It runs after a successful
// device login, on the exact credential the login sandbox produced. It mirrors
// the fixed order the Codex promotion uses (see
// `packages/adapters/codex-local/src/server/adapter-auth-promotion.ts`):
// readiness check, credential validation, a user-initiated gate, a
// sole-active-owner gate, then the write.
//
// Grok needs no per-identity cache, but it does need a "strictly newer" merge
// decision: a completed device login is NOT always the newest state for the
// account it logs in, because a teardown copy-back can install a fresher
// same-identity credential (see `grok-auth-copyback.ts`) while this session
// is still logging in. So the write step seeds an empty home, keeps the home
// untouched when a DIFFERENT account already occupies it, and for the SAME
// account runs the shared freshness predicate (`grok-auth-merge-decision.ts`)
// so it replaces the existing credential only when the login is strictly
// newer. The helper never writes the instance-global home, only the
// company-scoped one.
//
// The comparison-and-install step runs under `withDirectoryMergeLock` on the
// company Grok home, the same lock `copyBackGrokAuth` (see
// `grok-auth-copyback.ts`) takes on the same directory at teardown. Both
// resolve the lock key from the directory's canonical real path, so a
// promotion and a teardown copy-back for the same company can never
// interleave their read-decide-write sections.
//
// The helper treats the whole credential value as a secret: it never logs a
// token, a refresh token, or a personal field (email, name, user id).

const AUTH_FILE_NAME = "auth.json";
// A private directory (owner rwx only), reused from
// packages/adapters/codex-local/src/server/adapter-auth-promotion.ts:37-38.
const PRIVATE_DIR_MODE = 0o700;
// A private file (owner rw only). The write calls `chmod` after the write, so
// the process umask can never widen it — the same pattern
// packages/adapters/codex-local/src/server/codex-home.ts:524-526 uses for a
// staged credential file.
const PRIVATE_FILE_MODE = 0o600;

// A bounded size for the credential payload, mirroring
// packages/adapters/codex-local/src/server/device-login-export.ts's
// `MAX_AUTH_JSON_BYTES`. A real `auth.json` is a few kilobytes.
const MAX_AUTH_JSON_BYTES = 64 * 1024;

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
    super(`grok device-login promotion: the readiness check did not pass (${reason})`);
    this.name = "DeviceLoginReadinessError";
    this.reason = reason;
  }
}

// A private directory (owner rwx only) for the throwaway readiness home.
const READINESS_HOME_DIR_MODE = 0o700;
// A private file (owner rw only) for the throwaway readiness credential.
const READINESS_AUTH_FILE_MODE = 0o600;

/**
 * The independent readiness check for a staged Grok device-login credential. It
 * runs on the exact staged bytes, before any promotion write. It writes the
 * bytes to a throwaway private home and runs the same usable-auth predicate the
 * execute path uses. It always removes the throwaway home before it returns.
 *
 * It never uses the `grok models` exit code: that command exits `0` whether or
 * not the user is authenticated, so it is not a usable auth signal.
 */
export async function checkStagedGrokCredentialReadiness(
  authBytes: Buffer,
): Promise<CredentialReadinessResult> {
  if (authBytes.length === 0) {
    return { ready: false, reason: "empty_credential" };
  }
  const scratchHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-grok-login-readiness-"));
  try {
    await mkdir(scratchHome, { recursive: true, mode: READINESS_HOME_DIR_MODE });
    await writeFile(path.join(scratchHome, AUTH_FILE_NAME), authBytes, {
      mode: READINESS_AUTH_FILE_MODE,
    });
    const ready = await grokHomeHasUsableAuth(scratchHome);
    return ready ? { ready: true } : { ready: false, reason: "no_usable_auth" };
  } finally {
    await rm(scratchHome, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Validates the bounded-size, single-identity-key auth shape. Rejects an
 * empty, an oversized, an invalid-JSON, a no-key, a multi-key, and an
 * unusable-value payload. Never puts credential bytes into the thrown error.
 */
export function assertUsableGrokAuthShape(authBytes: Buffer): GrokAuthPayload {
  if (authBytes.length === 0) {
    throw new Error("grok device-login promotion: refused an empty auth payload");
  }
  if (authBytes.length > MAX_AUTH_JSON_BYTES) {
    throw new Error("grok device-login promotion: refused an oversized auth payload");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(authBytes.toString("utf8"));
  } catch {
    throw new Error("grok device-login promotion: refused invalid JSON");
  }
  const payload = parseGrokAuthPayload(parsedJson);
  if (!payload) {
    throw new Error(
      "grok device-login promotion: refused a payload with no single <issuer>::<uuid> key",
    );
  }
  if (!hasUsableGrokAuthValue(payload.value)) {
    throw new Error(
      "grok device-login promotion: refused a credential with no usable key and refresh_token",
    );
  }
  return payload;
}

/**
 * The promotion outcome.
 *
 * - `promoted`: the helper wrote the company home, either seeding an empty home
 *   or installing a strictly-newer same-account credential.
 * - `kept`: the login carried the SAME account as the company home, and the
 *   home already held a same-identity credential that is not older than the
 *   one this login produced (a tie, or the home credential is newer), so the
 *   helper kept the home. This IS a successful authentication: a later run
 *   vends and uses the same account.
 * - `kept_foreign_identity`: the company home is occupied and this step could
 *   not confirm it holds the same account — either a DIFFERENT account already
 *   occupies it, or the existing file is present but this step cannot read it
 *   as a usable Grok credential (an unreadable or unparseable file fails
 *   closed the same way). The helper never clobbers an occupied home, so it
 *   wrote nothing. This is NOT a successful authentication; the caller must
 *   fail the session.
 * - `not_sole_owner`: the sole-active-owner gate rejected the write. Nothing
 *   was written.
 * - `background_skipped`: the user-initiated gate rejected the write (an
 *   automatic background path never seeds a company slot). Nothing was written.
 */
export type PromoteGrokDeviceLoginCredentialOutcome =
  | "promoted"
  | "kept"
  | "kept_foreign_identity"
  | "not_sole_owner"
  | "background_skipped";

export interface PromoteGrokDeviceLoginCredentialInput {
  /** The exact staged credential bytes the login sandbox produced. */
  authBytes: Buffer;
  /** The company that owns this login. It must be a single safe path segment. */
  companyId: string;
  /**
   * True when a user started this login. Only a user-initiated login seeds the
   * company slot; an automatic background path never seeds it.
   */
  userInitiated: boolean;
  /**
   * The independent, machine-readable readiness check. It runs on the exact
   * staged credential before any write. A non-ready result rejects the
   * promotion (the session fails), and the helper writes nothing.
   */
  checkReadiness: (
    authBytes: Buffer,
  ) => Promise<CredentialReadinessResult> | CredentialReadinessResult;
  /**
   * Resolves true only while this session still holds the sole active claim on
   * `(company_id, adapter_type)`. The helper writes only when it resolves true.
   */
  isSoleActiveOwner: () => Promise<boolean> | boolean;
  /** A non-leaking progress sink. It receives only fixed status lines. */
  log: (line: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** Rejects an empty or unsafe `companyId`, so a promotion can never resolve the
 *  instance-global home (`resolveManagedGrokHomeDir` with no `companyId`) or
 *  escape the company tree. */
function requireSafeCompanyId(companyId: string): string {
  const trimmed = typeof companyId === "string" ? companyId.trim() : "";
  if (trimmed.length === 0) {
    throw new Error("grok device-login promotion: companyId is empty");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("grok device-login promotion: companyId is a relative path segment");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("grok device-login promotion: companyId contains a path separator");
  }
  return trimmed;
}

/**
 * The existing home's state, read before a write decision.
 *
 * - `absent`: no file at the path. This is an empty slot.
 * - `identity`: the file is present, readable, and holds a usable Grok
 *   payload. `identityKey` is that payload's composite key.
 * - `unreadable`: the file is present, but the read failed, the JSON parse
 *   failed, or the payload is not a usable Grok payload. The caller must
 *   treat this the same as an occupied home with an unknown account: it
 *   fails closed and never overwrites the file.
 */
type ExistingHomeState = { kind: "absent" } | { kind: "identity"; identityKey: string } | { kind: "unreadable" };

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Reads the existing home's state at `authPath`. A read failure other than
 *  a missing file, an invalid-JSON payload, or a non-Grok payload all
 *  resolve to `unreadable`, so the caller fails closed on any of them. Only
 *  a missing file resolves to `absent`. */
async function readExistingHomeState(authPath: string): Promise<ExistingHomeState> {
  let existingBytes: Buffer;
  try {
    existingBytes = await readFile(authPath);
  } catch (error) {
    return isEnoentError(error) ? { kind: "absent" } : { kind: "unreadable" };
  }
  let existingJson: unknown;
  try {
    existingJson = JSON.parse(existingBytes.toString("utf8"));
  } catch {
    return { kind: "unreadable" };
  }
  const payload = parseGrokAuthPayload(existingJson);
  return payload ? { kind: "identity", identityKey: payload.identityKey } : { kind: "unreadable" };
}

/**
 * Writes `authBytes` to `authPath` atomically. It stages the bytes into a
 * private (0600) temporary file in the same directory, then renames that
 * file over `authPath`. The rename is an atomic same-directory swap, so a
 * reader never observes a torn file, and a process that stops mid-write
 * leaves the destination untouched. The temporary file is always removed,
 * so a failed write never leaves stray bytes behind.
 */
async function writeAuthFileAtomically(authPath: string, authBytes: Buffer): Promise<void> {
  const stagedTempPath = path.join(
    path.dirname(authPath),
    `.auth-${process.pid}-${randomUUID()}.tmp`,
  );
  // `wx` + explicit mode create the temp file private (0600) and fail if it
  // already exists, so the write never goes through a pre-existing symlink.
  const handle = await open(stagedTempPath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(authBytes);
    await handle.close();
    await rename(stagedTempPath, authPath);
    await chmod(authPath, PRIVATE_FILE_MODE);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(stagedTempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Runs the shared freshness predicate (the same one `copyBackGrokAuth` uses)
 * and installs `authBytes` over `authPath` only on a use-source decision. It
 * stages `authBytes` into a private (0600) temporary file next to `authPath`,
 * so the predicate can compare both sides by path, then renames that file
 * over `authPath` on a use-source decision. The staged temp is always
 * removed: the rename consumes it on the write path, and the `finally`
 * removes it otherwise. Returns true when it wrote, false when it kept the
 * existing file.
 */
async function writeSameIdentityCredentialIfFresher(
  authBytes: Buffer,
  authPath: string,
): Promise<boolean> {
  const stagedTempPath = path.join(
    path.dirname(authPath),
    `.auth-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(stagedTempPath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(authBytes);
    await handle.close();
    const decision = await decideGrokAuthMerge(stagedTempPath, authPath, {
      errorLabel: "grok device-login promotion",
    });
    if (decision !== USE_SOURCE_EXIT) {
      return false;
    }
    await rename(stagedTempPath, authPath);
    await chmod(authPath, PRIVATE_FILE_MODE);
    return true;
  } finally {
    await handle.close().catch(() => undefined);
    await rm(stagedTempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Promotes a Grok device-login credential into the company scope. The order is
 * fixed: readiness check, credential validation, the user-initiated gate, the
 * sole-active-owner gate, then the write. The readiness check and the write run
 * while the caller still holds the active claim, so a second session cannot
 * race the same slot.
 */
export async function promoteGrokDeviceLoginCredential(
  input: PromoteGrokDeviceLoginCredentialInput,
): Promise<PromoteGrokDeviceLoginCredentialOutcome> {
  const { authBytes, userInitiated, checkReadiness, isSoleActiveOwner, log } = input;
  const env = input.env ?? process.env;
  const companyId = requireSafeCompanyId(input.companyId);

  // 1. Independent readiness check on the exact staged credential. A non-ready
  //    result rejects the promotion before any validation or write.
  const readiness = await checkReadiness(authBytes);
  if (!readiness.ready) {
    throw new DeviceLoginReadinessError(readiness.reason ?? "not_ready");
  }

  // 2. Validate the credential shape: the single `<issuer>::<uuid>` key, and a
  //    usable `key` and `refresh_token` in its value.
  const payload = assertUsableGrokAuthShape(authBytes);

  // 3. Only a user-initiated login seeds the company slot.
  if (!userInitiated) {
    await log(
      "[paperclip] Grok device-login promotion: skipped (an automatic background login never seeds a company slot).",
    );
    return "background_skipped";
  }

  // 4. Write only while the session still owns the active slot.
  const soleOwner = await isSoleActiveOwner();
  if (!soleOwner) {
    await log(
      "[paperclip] Grok device-login promotion: skipped (the session no longer holds the sole active claim on the slot).",
    );
    return "not_sole_owner";
  }

  // 5. Never clobber an occupied home. A present file that this step cannot
  //    read as the same identity — absent from a read failure, invalid JSON,
  //    or a non-Grok payload — is treated as a foreign identity, so the
  //    promotion fails closed and writes nothing.
  //
  // 6. Write the company credential home. `mkdir` applies `mode` only when it
  //    creates the directory, so an explicit `chmod` follows it. This keeps
  //    the directory mode exact both for a new home and for a home that
  //    already existed at a broader mode. An empty home is always seeded. A
  //    home that already holds the SAME identity is refreshed only when the
  //    login is strictly newer than the existing credential — the shared
  //    freshness predicate in `grok-auth-merge-decision.ts` decides this, the
  //    same predicate the teardown copy-back uses, so a fresher remote
  //    copy-back credential can never lose to an older device login. Every
  //    write is atomic: it stages the bytes into a private temporary file in
  //    the same directory, then renames that file over `auth.json`.
  //
  // Steps 5 and 6 run under `withDirectoryMergeLock` on the company home, the
  // same lock the teardown copy-back takes on the same directory (see
  // `grok-auth-copyback.ts`). The directory must exist before the lock can
  // resolve a canonical real path, so `mkdir` runs once, up front, at the
  // final private mode; a home that already exists keeps its current mode
  // until the write path below re-asserts it.
  const companyHome = resolveManagedGrokHomeDir(env, companyId);
  await mkdir(companyHome, { recursive: true, mode: PRIVATE_DIR_MODE });
  return await withDirectoryMergeLock(
    companyHome,
    async (canonicalCompanyHome) => {
      const authPath = path.join(canonicalCompanyHome, AUTH_FILE_NAME);
      const existingState = await readExistingHomeState(authPath);
      if (existingState.kind === "unreadable") {
        await log(
          "[paperclip] Grok device-login promotion: kept the company credential home (the existing file is present but this step cannot read it as a usable Grok credential).",
        );
        return "kept_foreign_identity";
      }
      if (existingState.kind === "identity" && existingState.identityKey !== payload.identityKey) {
        await log(
          "[paperclip] Grok device-login promotion: kept the company credential home (the login is a different account than the one already set for this company).",
        );
        return "kept_foreign_identity";
      }

      await chmod(canonicalCompanyHome, PRIVATE_DIR_MODE);

      if (existingState.kind === "identity") {
        const wrote = await writeSameIdentityCredentialIfFresher(authBytes, authPath);
        if (!wrote) {
          await log(
            "[paperclip] Grok device-login promotion: kept the company credential home (the existing same-identity credential is not older than the device-login credential).",
          );
          return "kept";
        }
        await log("[paperclip] Grok device-login promotion: wrote the company credential home at mode 0600.");
        return "promoted";
      }

      await writeAuthFileAtomically(authPath, authBytes);
      await log("[paperclip] Grok device-login promotion: wrote the company credential home at mode 0600.");
      return "promoted";
    },
    env,
  );
}
