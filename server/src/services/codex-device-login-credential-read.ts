// The descriptor-bound credential read for the Codex device login.
//
// The login pseudo-terminal (PTY) runs `codex login --device-auth` and writes
// `auth.json` into the server-controlled session home. The service reads that
// file after the command exits with code zero. The read must close the
// time-of-check-to-time-of-use (TOCTOU) window: a pathname check and a later
// `cat` on the same pathname let an attacker swap the file between the two steps.
//
// This module runs one fixed, server-controlled operation inside the sandbox
// instead. The operation opens the verified session home without a symlink
// follow, opens `auth.json` relative to that directory descriptor without a
// symlink follow, runs `fstat` on the opened descriptor, and reads only from that
// same descriptor. The `fstat` check requires a regular file, login-user
// ownership, exact mode `0600`, and a bounded size. A missing file, a symlink, a
// non-regular file, a wrong owner, a wrong mode, or an oversize file returns one
// fixed, non-secret error.
//
// The provider exposes no descriptor application programming interface (API), so
// this module runs a fixed helper program in the sandbox through the environment
// runtime `execute` seam. The helper never re-opens the pathname after the check:
// the `fstat` and the read bind to the one opened descriptor.
//
// Security: the helper prints only the base64 of the credential bytes on the
// fully validated success path. It prints one fixed error token on every failed
// path. It never prints the pathname, the raw bytes, or any other detail. This
// module converts any failure to one fixed, non-secret error and reads no bytes.

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
 * The fixed helper program. The server runs it in the sandbox as
 * `python3 -c <script> <sessionHome> [expectedUid]`. The Python runtime is
 * present in the login sandbox image. The script:
 *
 * - opens the session home with `O_NOFOLLOW` and `O_DIRECTORY`, so a symlink home
 *   or a non-directory home fails;
 * - opens `auth.json` relative to that directory descriptor with `O_NOFOLLOW`, so
 *   a symlink credential fails and a missing credential fails;
 * - runs `fstat` on the opened descriptor and requires a regular file, the
 *   expected owner, exact mode `0600`, and a size at or below the bound;
 * - reads only from that same descriptor and stops if the byte count passes the
 *   bound.
 *
 * The `expectedUid` argument is optional. The server omits it, so the helper uses
 * the login user's own id (the helper runs as the login user in the sandbox). A
 * test passes an explicit id to force a wrong-owner path. The script prints the
 * base64 of the bytes on success and one fixed token on every failure.
 */
export const DEVICE_LOGIN_AUTH_READ_SCRIPT = `import base64, os, stat, sys

MAX = ${MAX_AUTH_JSON_BYTES}
home = sys.argv[1]
name = ${JSON.stringify(AUTH_JSON_FILE_NAME)}
expected_uid = int(sys.argv[2]) if len(sys.argv) > 2 else os.getuid()

def fail():
    sys.stderr.write("AUTH_READ_FAILED\\n")
    raise SystemExit(1)

dfd = -1
ffd = -1
try:
    try:
        dfd = os.open(home, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC)
    except OSError:
        fail()
    try:
        ffd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dfd)
    except OSError:
        fail()
    st = os.fstat(ffd)
    if not stat.S_ISREG(st.st_mode):
        fail()
    if st.st_uid != expected_uid:
        fail()
    if stat.S_IMODE(st.st_mode) != 0o600:
        fail()
    if st.st_size > MAX:
        fail()
    data = b""
    while True:
        chunk = os.read(ffd, 65536)
        if not chunk:
            break
        data += chunk
        if len(data) > MAX:
            fail()
    sys.stdout.write(base64.b64encode(data).decode("ascii"))
finally:
    if ffd >= 0:
        try:
            os.close(ffd)
        except OSError:
            pass
    if dfd >= 0:
        try:
            os.close(dfd)
        except OSError:
            pass
`;

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
      command: "python3",
      args: ["-c", DEVICE_LOGIN_AUTH_READ_SCRIPT, deps.sessionHome],
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
