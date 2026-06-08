import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Whether authenticated data queries (adapters, board/company data) are allowed
 * to run in the current context.
 *
 * Mirrors {@link CloudAccessGate}'s rule: auth is only enforced when the instance
 * is in `authenticated` deployment mode. In `local_trusted` mode no session is
 * required, so authed data calls are always allowed.
 *
 * It returns `false` until `/api/health` is known. That deliberately keeps the
 * gate CLOSED on the unauthenticated `/auth` page — where authed calls 401/403 —
 * even during the brief health-loading window, so /auth fires zero authed data
 * calls. `/api/health` itself is a public endpoint (Auth.tsx already reads it for
 * `googleAuthEnabled`), and both the health and session queries share the
 * app-wide query cache, so this adds no extra network cost.
 *
 * Behaviour:
 * - health unknown            -> false  (don't fire authed calls before we know)
 * - local_trusted mode        -> true   (no auth needed; also the default in tests)
 * - authenticated, no session -> false  (e.g. the /auth page)
 * - authenticated, signed in  -> true
 */
export function useAuthedDataEnabled(): boolean {
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    staleTime: 60_000,
  });

  const isAuthenticatedMode = health?.deploymentMode === "authenticated";

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (!health) return false;
  if (!isAuthenticatedMode) return true;
  return !!session;
}
