import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { whenPageSettles } from "@/lib/when-page-settles";
import {
  PRODUCT_ANALYTICS_LOAD_DEADLINE_MS,
  setProductAnalyticsUser,
  syncProductAnalytics,
} from "@/lib/analytics/product-analytics";
import {
  analyticsChoiceMadeOnThisPage,
  storeAnalyticsChoice,
  useAnalyticsConsent,
} from "@/lib/analytics/consent";
import { AnalyticsConsentBanner } from "./AnalyticsConsentBanner";

/**
 * Browser product analytics for hosted Paperclip Cloud.
 *
 * It reads the signed-in session, like `SentryGate` (same query, so no extra
 * request). The server sends `browserAnalytics` only for a cloud-managed
 * instance with PostHog browser analytics switched on, so self-hosted
 * installs, local development and tests never load posthog-js. Sign-out
 * clears the session, which resets the PostHog identity.
 */
export function ProductAnalyticsGate() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const config = session?.browserAnalytics ?? null;
  const configKey = config ? JSON.stringify(config) : null;
  // The authenticated actor's user id, verbatim (for example
  // "paperclip-id:..."): the server copies `req.actor.userId` into
  // `session.userId`, and server events use that same id as `distinct_id`,
  // so browser and server events land on one PostHog person.
  const userId = session?.session.userId ?? null;
  const email = session?.user.email ?? null;
  const name = session?.user.name ?? null;
  const consent = useAnalyticsConsent(config);

  useEffect(() => {
    if (!config || !consent) return;
    return syncProductAnalytics(config, consent, {
      immediate: analyticsChoiceMadeOnThisPage(),
      schedule: (start) => {
        const cancelSettle = whenPageSettles(queryClient, start);
        const deadline = window.setTimeout(start, PRODUCT_ANALYTICS_LOAD_DEADLINE_MS);
        return () => {
          cancelSettle();
          window.clearTimeout(deadline);
        };
      },
    });
    // Keyed by value: the config object identity changes on every session refetch.
  }, [configKey, consent, queryClient]);

  useEffect(() => {
    setProductAnalyticsUser(userId ? { id: userId, email, name } : null);
  }, [userId, email, name]);

  if (!config || consent !== "ask") return null;
  return (
    <AnalyticsConsentBanner
      recordings={config.replayEnabled}
      onAccept={() => storeAnalyticsChoice("granted")}
      onDecline={() => storeAnalyticsChoice("denied")}
    />
  );
}
