/**
 * Deterministic, shared port + URL derivation for the `tailscale_https`
 * exposure mode. Extracted so runtime allocation, server startup, the broker,
 * and tests all agree on the dedicated Paperclip runtime port range and the
 * app/HMR pairing (PAP-17049 plan, PAP-17050 verdict requirement #2).
 *
 * Pure functions only — no I/O, no process state.
 */

/**
 * Dedicated, allowlisted port range for managed Paperclip runtime APP
 * listeners. Ports outside this range are never eligible for exposure, which
 * bounds the SSRF blast radius: a compromised caller cannot ask the broker to
 * publish an arbitrary existing loopback service.
 */
export const RUNTIME_EXPOSURE_APP_PORT_MIN = 42000;
export const RUNTIME_EXPOSURE_APP_PORT_MAX = 42999;

/**
 * Fixed offset between an app port and its Paperclip Vite HMR companion port.
 * Matches Paperclip dev mode's `server port + offset` HMR convention and keeps
 * the two listeners deterministically paired.
 */
export const RUNTIME_EXPOSURE_HMR_PORT_OFFSET = 10000;

/** Derived HMR companion port range, kept in sync with the offset above. */
export const RUNTIME_EXPOSURE_HMR_PORT_MIN =
  RUNTIME_EXPOSURE_APP_PORT_MIN + RUNTIME_EXPOSURE_HMR_PORT_OFFSET;
export const RUNTIME_EXPOSURE_HMR_PORT_MAX =
  RUNTIME_EXPOSURE_APP_PORT_MAX + RUNTIME_EXPOSURE_HMR_PORT_OFFSET;

/** True only for integers strictly inside the dedicated app port range. */
export function isRuntimeExposureAppPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= RUNTIME_EXPOSURE_APP_PORT_MIN &&
    port <= RUNTIME_EXPOSURE_APP_PORT_MAX
  );
}

/** True only for integers strictly inside the derived HMR companion range. */
export function isRuntimeExposureHmrPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= RUNTIME_EXPOSURE_HMR_PORT_MIN &&
    port <= RUNTIME_EXPOSURE_HMR_PORT_MAX
  );
}

/**
 * True for any port the broker is allowed to expose (app OR HMR companion).
 * Everything else — privileged/reserved ports, `443`, ephemeral, unknown — is
 * deny-by-default.
 */
export function isAllowedRuntimeExposurePort(port: number): boolean {
  return isRuntimeExposureAppPort(port) || isRuntimeExposureHmrPort(port);
}

/**
 * Derive the Vite HMR companion port for an allocated app port. Throws if the
 * app port is not a valid dedicated app port so callers cannot silently pair a
 * port outside the allowlist.
 */
export function deriveViteHmrPort(appPort: number): number {
  if (!isRuntimeExposureAppPort(appPort)) {
    throw new RangeError(
      `app port ${appPort} is outside the dedicated runtime exposure range ` +
        `[${RUNTIME_EXPOSURE_APP_PORT_MIN}, ${RUNTIME_EXPOSURE_APP_PORT_MAX}]`,
    );
  }
  return derivePaperclipViteHmrPort(appPort);
}

/**
 * Derive Paperclip's Vite HMR companion port for any valid application port.
 *
 * Normal Paperclip instances can use ports outside the dedicated exposure
 * range, while exposed branch runtimes are deliberately constrained to it.
 * Keeping the generic derivation here prevents the app server and exposure
 * allocator from drifting while preserving the historical overflow fallback.
 */
export function derivePaperclipViteHmrPort(serverPort: number): number {
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
    throw new RangeError(`server port ${serverPort} is not a valid TCP port`);
  }
  if (serverPort <= 55_535) {
    return serverPort + RUNTIME_EXPOSURE_HMR_PORT_OFFSET;
  }
  return Math.max(1_024, serverPort - RUNTIME_EXPOSURE_HMR_PORT_OFFSET);
}

/**
 * Build the canonical browser URL for an exposed app port on a resolved
 * Tailscale node hostname. Uses the non-standard HTTPS port explicitly.
 */
export function buildRuntimeExposureUrl(hostname: string, appPort: number): string {
  const trimmed = hostname.trim();
  if (trimmed.length === 0) {
    throw new Error("hostname is required to build an exposure URL");
  }
  if (!isRuntimeExposureAppPort(appPort)) {
    throw new RangeError(`app port ${appPort} is outside the dedicated runtime exposure range`);
  }
  return `https://${trimmed}:${appPort}`;
}

/**
 * Build the external HTTPS health-probe URL used to verify normal certificate
 * validation before a runtime is reported healthy.
 */
export function buildRuntimeExposureHealthUrl(hostname: string, appPort: number): string {
  return `${buildRuntimeExposureUrl(hostname, appPort)}/api/health`;
}
