import { Navigate, Outlet } from "@/lib/router";
import { QueryErrorState } from "@/components/QueryView";
import { useResponsibilitiesEnabled } from "@/hooks/useResponsibilitiesEnabled";
import { DASHBOARD_HOME_PATH } from "@/lib/company-home";

/**
 * Layout route guard for the Responsibilities surfaces.
 *
 * The routes stay registered; with the experimental flag off they redirect to
 * Dashboard (which is home whenever this flag is off). Nothing renders while
 * the flag loads, so an enabled user is not bounced away early, and a failed
 * settings read shows the failure with Retry rather than redirecting.
 */
export function ResponsibilitiesGate() {
  const { enabled, loaded, error, retry } = useResponsibilitiesEnabled();
  if (error) return <QueryErrorState error={error} size="page" action="load your settings" onRetry={retry} />;
  if (!loaded) return null;
  if (!enabled) return <Navigate to={DASHBOARD_HOME_PATH} replace />;
  return <Outlet />;
}
