/**
 * WebAuthn binds a passkey to the server's relying-party origin, so a page on
 * any other allowed hostname (a LAN name, loopback) cannot register or use one.
 */
export function isPasskeyOriginCurrent(passkeyOrigin: string | null | undefined): boolean {
  return typeof passkeyOrigin === "string" && passkeyOrigin === window.location.origin;
}

export function passkeyErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if ((error as { code?: unknown }).code === "PASSKEY_USER_VERIFICATION_REQUIRED") {
    return "This passkey must verify you with a PIN, fingerprint, or face. Set one up on the key or device, then try again.";
  }
  if ((error as { code?: unknown }).code === "SESSION_NOT_FRESH") {
    return "For your security, sign out and sign in again before adding a passkey.";
  }
  if (error.name === "NotAllowedError" || error.name === "AbortError") {
    return "The passkey request was cancelled or timed out.";
  }
  if (error.name === "InvalidStateError") {
    return "This device already has a passkey for your account.";
  }
  if (error.name === "SecurityError" || error.name === "NotSupportedError") {
    return "This browser cannot use passkeys for this address.";
  }
  return error.message || fallback;
}
