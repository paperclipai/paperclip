import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { initBrowserErrorMonitoring, teardownBrowserErrorMonitoring } from "@/lib/sentry";

/**
 * Opens the browser Sentry gate for an authorized board actor. Reads the
 * signed-in session and starts browser error monitoring only when the
 * session carries a Sentry DSN. Renders nothing.
 *
 * Sets no `enabled` option on the session query, so this also runs in
 * `local_trusted` mode — the actor middleware fabricates a board actor
 * there, so `/api/auth/get-session` still answers 200 with a session.
 *
 * Sign-out clears the session query (`useSignOut`), so `dsn` goes back to
 * falsy on the same render pass that drops the session. That change tears
 * down monitoring through the effect cleanup below, closing the running
 * client, so a signed-out browser sends Sentry no more events.
 */
export function SentryGate() {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const dsn = session?.sentryDsn;

  useEffect(() => {
    if (!dsn) return;
    void initBrowserErrorMonitoring(dsn);
    return () => {
      void teardownBrowserErrorMonitoring();
    };
  }, [dsn]);

  return null;
}
