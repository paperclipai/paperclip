const TENANT_SESSION_ERROR_CODES = new Set([
  "tenant_session_required",
  "tenant_session_invalid",
]);

export function isTenantSessionRecoveryError(status: number, body: unknown): boolean {
  if (status !== 401 || !body || typeof body !== "object") return false;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" && TENANT_SESSION_ERROR_CODES.has(error);
}

export interface TenantSessionRecoveryCoordinator {
  recoverIfNeeded: (status: number, body: unknown) => Promise<never> | null;
}

export function createTenantSessionRecoveryCoordinator(
  reloadTopLevelPage: () => void,
): TenantSessionRecoveryCoordinator {
  let recoveryPromise: Promise<never> | null = null;

  return {
    recoverIfNeeded(status, body) {
      if (!isTenantSessionRecoveryError(status, body)) return null;
      if (recoveryPromise) return recoveryPromise;

      // Keep every affected consumer pending while the browser leaves this
      // document. In particular, this avoids surfacing the internal Cloud code
      // or causing failed mutations to enter ordinary retry/error handling.
      recoveryPromise = new Promise<never>(() => {});
      try {
        reloadTopLevelPage();
      } catch (error) {
        recoveryPromise = null;
        throw error;
      }
      return recoveryPromise;
    },
  };
}

export const tenantSessionRecovery = createTenantSessionRecoveryCoordinator(() => {
  // A document navigation re-enters Cloud's existing HttpOnly-cookie/OIDC
  // handoff, preserving the current route and query without exposing tokens.
  const topLevelWindow = window.top ?? window;
  topLevelWindow.location.reload();
});
