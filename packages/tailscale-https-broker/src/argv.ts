/**
 * Tailscale CLI argv construction. Every command is a fixed token vector with a
 * single validated integer interpolated; there is never a shell, an arbitrary
 * target URL, a path handler, Funnel, cert, Service, reset, or set-config
 * operation (PAP-17049 plan; PAP-17050 verdict requirement #4 + invariants).
 *
 * The caller must pass an absolute, root-owned tailscale binary path. Callers
 * spawn with shell:false and a minimal environment.
 */
import { assertCanonicalPort } from "./integers.js";
import { PROTECTED_PRIMARY_PORT } from "./types.js";

/** The loopback target is always same-number and always plain-http loopback. */
export function loopbackTarget(port: number): string {
  assertCanonicalPort(port);
  return `http://127.0.0.1:${port}`;
}

function assertMutablePort(port: number, protectedPorts: readonly number[] = []): number {
  const p = assertCanonicalPort(port);
  if (p === PROTECTED_PRIMARY_PORT) {
    throw new Error("refusing to operate on the protected primary port 443");
  }
  if (p < 1024) {
    throw new Error("refusing to operate on a privileged/reserved port (<1024)");
  }
  // Innermost refusal for operator-declared protected ports (PAP-17285). Higher
  // layers deny first with a typed code; this exists so no caller can construct
  // a mutating argv for a protected port even by mistake, and so the guarantee
  // does not depend on every future call site remembering to check.
  if (protectedPorts.includes(p)) {
    throw new Error(`refusing to operate on operator-protected port ${p}`);
  }
  return p;
}

/** `tailscale serve status --json` — read-only. */
export function buildStatusArgv(binPath: string): string[] {
  assertAbsolute(binPath);
  return [binPath, "serve", "status", "--json"];
}

/**
 * Add one same-number HTTPS-to-loopback listener in the background without
 * disturbing other Serve entries.
 */
export function buildExposeArgv(
  binPath: string,
  port: number,
  protectedPorts: readonly number[] = [],
): string[] {
  assertAbsolute(binPath);
  const p = assertMutablePort(port, protectedPorts);
  return [binPath, "serve", "--bg", `--https=${p}`, loopbackTarget(p)];
}

/** Remove exactly one HTTPS listener by port. Never `reset`, never `off` all. */
export function buildRemoveArgv(
  binPath: string,
  port: number,
  protectedPorts: readonly number[] = [],
): string[] {
  assertAbsolute(binPath);
  const p = assertMutablePort(port, protectedPorts);
  return [binPath, "serve", `--https=${p}`, "off"];
}

function assertAbsolute(binPath: string): void {
  if (typeof binPath !== "string" || !binPath.startsWith("/")) {
    throw new Error("tailscale binary path must be absolute");
  }
  // No shell metacharacters, whitespace, or NUL in the pinned binary path.
  if (/[\s;&|`$<>(){}\\"'*?\0]/.test(binPath)) {
    throw new Error("tailscale binary path contains disallowed characters");
  }
}
