import { isAbsolute, resolve } from "node:path";

export const VERIFIED_RUNTIME_EXECUTABLE_ENV =
  "PAPERCLIP_VERIFIED_RUNTIME_EXECUTABLE";

export interface VerifiedRuntimeExecutableHandoff {
  executable: string;
  environmentValue: string | undefined;
  sourceFd: number | null;
}

/**
 * Recover the runner-authenticated executable inherited by a descriptor-loaded
 * sidecar. Linux descendants must explicitly inherit this descriptor: Node
 * resolves process.execPath and /proc/self/exe to a deleted memfd alias that a
 * later exec cannot reopen.
 */
export function verifiedRuntimeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  _currentPid: number = process.pid,
  fallback: string = process.execPath,
): string {
  const configured = environment[VERIFIED_RUNTIME_EXECUTABLE_ENV];
  if (configured === undefined) return fallback;

  if (platform === "linux") {
    if (/^\/proc\/self\/fd\/[0-9]+$/.test(configured)) return configured;
    throw new Error("Verified runtime executable descriptor is invalid");
  }

  if (platform === "darwin") {
    if (
      !isAbsolute(fallback) ||
      resolve(fallback) !== fallback ||
      configured !== fallback
    ) {
      throw new Error("Verified runtime executable path is invalid");
    }
    // The Rust supervisor materializes the authenticated runtime as a private,
    // read-only executable and starts this process from that exact pathname.
    // Descendants may inherit the handoff variable, but they cannot nominate a
    // different absolute path and have it treated as verified.
    return fallback;
  }

  throw new Error(
    "Verified runtime executable is unsupported on this platform",
  );
}

/**
 * Project the current verified runtime into a chosen child descriptor. The
 * caller must place sourceFd at child targetFd in its stdio table.
 */
export function verifiedRuntimeExecutableHandoff(
  targetFd: number,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  currentPid: number = process.pid,
  fallback: string = process.execPath,
): VerifiedRuntimeExecutableHandoff {
  if (!Number.isSafeInteger(targetFd) || targetFd < 3) {
    throw new Error("Verified runtime executable target descriptor is invalid");
  }
  const executable = verifiedRuntimeExecutable(
    environment,
    platform,
    currentPid,
    fallback,
  );
  const configured = environment[VERIFIED_RUNTIME_EXECUTABLE_ENV];
  if (platform !== "linux" || configured === undefined) {
    return {
      executable,
      environmentValue: configured === undefined ? undefined : executable,
      sourceFd: null,
    };
  }
  const match = /^\/proc\/self\/fd\/([0-9]+)$/.exec(configured);
  if (match === null) {
    throw new Error("Verified runtime executable descriptor is invalid");
  }
  const sourceFd = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(sourceFd) || sourceFd < 3) {
    throw new Error("Verified runtime executable descriptor is invalid");
  }
  const childExecutable = `/proc/self/fd/${targetFd}`;
  return {
    executable: childExecutable,
    environmentValue: childExecutable,
    sourceFd,
  };
}
