// The descriptor-bound credential read for the Codex device login.
//
// The login pseudo-terminal (PTY) runs `codex login --device-auth` and writes
// `auth.json` into the server-controlled session home. The service reads that
// file after the command exits with code zero. The read must close the
// time-of-check-to-time-of-use (TOCTOU) window: a pathname check and a later
// `cat` on the same pathname let an attacker swap the file between the two steps.
//
// This module runs one fixed, server-controlled operation inside the sandbox
// instead. The operation opens the filesystem root, then walks each path
// component of the session home with no symlink follow. `O_NOFOLLOW` protects
// only the final component of one open, so the operation opens every intermediate
// component with a separate no-follow open. A symlink at any ancestor fails the
// walk. The operation then opens `auth.json` relative to the final directory
// descriptor without a symlink follow, runs `fstat` on the opened descriptor, and
// reads only from that same descriptor. The `fstat` check requires a regular
// file, login-user ownership, exact mode `0600`, and a bounded size. A missing
// file, a symlink at any component, a non-regular file, a wrong owner, a wrong
// mode, or an oversize file returns one fixed, non-secret error.
//
// The provider exposes no descriptor application programming interface (API), so
// this module runs a fixed helper program in the sandbox through the environment
// runtime `execute` seam. The helper is node, because the sandbox already runs
// node for the Paperclip bridge. The helper never re-opens the pathname after the
// check: the `fstat` and the read bind to the one opened descriptor.
//
// Security: the helper prints only the base64 of the credential bytes on the
// fully validated success path. It prints one fixed error token on every failed
// path. It never prints the pathname, the raw bytes, or any other detail. This
// module converts any failure to one fixed, non-secret error and reads no bytes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { validateLoginSessionHome } from "./login-command.js";

/**
 * The bounded size for the credential payload. A real subscription `auth.json` is
 * a few kilobytes. The read rejects a larger payload before it returns any bytes.
 * The value matches the adapter export bound.
 */
export const MAX_AUTH_JSON_BYTES = 64 * 1024;

/** The fixed credential file name inside the session home. No caller controls it. */
export const AUTH_JSON_FILE_NAME = "auth.json";

/**
 * The fixed, non-secret error the read returns on every failed path. The message
 * carries no pathname, no byte, and no other secret detail.
 */
export const DEVICE_LOGIN_AUTH_READ_ERROR =
  "device login failed: the sandbox credential read errored.";

/**
 * The fixed helper program. The server reads the helper from its own script file
 * and runs it in the sandbox as `node -e <script> <sessionHome> <maxBytes>
 * [<expectedUid>]`. The sandbox already runs node for the Paperclip bridge, so the
 * helper needs no extra runtime. The helper source lives in
 * `scripts/codex-auth-read.cjs`, so no large script stays as a string literal in
 * this module.
 *
 * The helper opens the filesystem root, then opens each session-home path
 * component in turn with a no-follow, directory-only open, relative to the
 * previous directory descriptor, so a symlink at any component fails. It opens
 * `auth.json` relative to the final directory descriptor with `O_NOFOLLOW`, runs
 * `fstat` on the opened descriptor, and requires a regular file, the expected
 * owner, exact mode `0600`, and a size at or below the bound. It reads only from
 * that same descriptor. The `expectedUid` argument is optional; the server omits
 * it, so the helper uses the login user's own id.
 */
export const DEVICE_LOGIN_AUTH_READ_SCRIPT = readFileSync(
  fileURLToPath(new URL("./scripts/codex-auth-read.cjs", import.meta.url)),
  "utf8",
);

/** A strict base64 token: standard alphabet, correct padding, length a multiple
 *  of four. The read rejects any other stdout, so malformed helper output never
 *  decodes to partial bytes. */
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes the helper stdout to the credential bytes. It accepts only strict
 * base64 with correct padding, so a truncated or corrupt line returns the fixed
 * error instead of partial bytes. It rejects a decoded payload over the bound.
 */
export function decodeAuthReadOutput(stdout: string): Buffer {
  const encoded = stdout.trim();
  if (encoded.length % 4 !== 0 || !STRICT_BASE64_RE.test(encoded)) {
    throw new Error(DEVICE_LOGIN_AUTH_READ_ERROR);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_AUTH_JSON_BYTES) {
    throw new Error(DEVICE_LOGIN_AUTH_READ_ERROR);
  }
  return bytes;
}

/** The environment-runtime surface the descriptor-bound read needs. */
export interface DescriptorBoundAuthReadDeps {
  environmentRuntime: Pick<EnvironmentRuntimeService, "execute">;
  environment: Environment;
  lease: EnvironmentLease;
  /** The verified, server-controlled session home. */
  sessionHome: string;
  /** The host timeout for the read command. */
  timeoutMs: number;
}

/**
 * Runs the descriptor-bound credential read once and returns the bytes. It
 * revalidates the session-home shape, then runs the fixed helper as a one-shot,
 * non-session command. It converts a non-zero exit, an empty or malformed stdout,
 * or an oversize payload to the one fixed, non-secret error. It reads no bytes on
 * any failed path.
 */
export async function runDescriptorBoundAuthRead(
  deps: DescriptorBoundAuthReadDeps,
): Promise<Buffer> {
  // Revalidate the home shape before the sandbox command. The server derived and
  // validated it earlier; this second check keeps the helper argument fixed.
  validateLoginSessionHome(deps.sessionHome);
  let result: { exitCode: number | null; stdout?: string };
  try {
    result = await deps.environmentRuntime.execute({
      environment: deps.environment,
      lease: deps.lease,
      command: "node",
      args: ["-e", DEVICE_LOGIN_AUTH_READ_SCRIPT, deps.sessionHome, String(MAX_AUTH_JSON_BYTES)],
      timeoutMs: deps.timeoutMs,
      // The read is one fixed, non-session operation. It must not open or reuse
      // the login session.
      bypassSession: true,
    });
  } catch {
    // A driver error may embed sandbox text. Convert it to the fixed error.
    throw new Error(DEVICE_LOGIN_AUTH_READ_ERROR);
  }
  if (result.exitCode !== 0) {
    throw new Error(DEVICE_LOGIN_AUTH_READ_ERROR);
  }
  return decodeAuthReadOutput(result.stdout ?? "");
}
