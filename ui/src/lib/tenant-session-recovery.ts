const TENANT_SESSION_ERROR_CODES = new Set([
  "tenant_session_required",
  "tenant_session_invalid",
]);

export function isTenantSessionRecoveryError(status: number, body: unknown): boolean {
  if (status !== 401 || !body || typeof body !== "object") return false;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" && TENANT_SESSION_ERROR_CODES.has(error);
}

/**
 * An archived Cloud stack answers every tenant request — including the
 * SPA's own health probe — with a 423 archived status page. Left unhandled
 * this surfaces as a dead "Failed to load health" screen. The recovery is
 * the same top-level reload as an expired session: the Cloud harness
 * redirects a fresh browser navigation on an archived host to the
 * portfolio, so reloading leaves this document instead of dwelling on it.
 */
export function isArchivedStackRecoveryError(status: number, body: unknown): boolean {
  if (status !== 423 || !body || typeof body !== "object") return false;
  const statusPage = (body as Record<string, unknown>).statusPage;
  if (!statusPage || typeof statusPage !== "object") return false;
  return (statusPage as Record<string, unknown>).code === "archived";
}

/**
 * Conditions the browser recovers from by re-entering the Cloud harness on a
 * fresh top-level navigation: an expired/absent tenant session (the harness
 * re-runs the cookie/OIDC handoff) and an archived stack (the harness
 * redirects to the portfolio). Both are corrected by the same reload.
 */
export function isTenantDocumentRecoveryError(status: number, body: unknown): boolean {
  return isTenantSessionRecoveryError(status, body) || isArchivedStackRecoveryError(status, body);
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
      if (!isTenantDocumentRecoveryError(status, body)) return null;
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
  // A document navigation re-enters the Cloud harness, which corrects the
  // browser's state: an expired session re-runs the HttpOnly-cookie/OIDC
  // handoff (route and query preserved, no tokens exposed), and an archived
  // stack is redirected to the portfolio.
  const topLevelWindow = window.top ?? window;
  topLevelWindow.location.reload();
});
