import { Navigate, Outlet } from "@/lib/router";
import { useResponsibilitiesEnabled } from "@/hooks/useResponsibilitiesEnabled";
import { DASHBOARD_HOME_PATH } from "@/lib/company-home";

/**
 * Layout route guard for the Responsibilities surfaces.
 *
 * The routes stay registered; with the experimental flag off they redirect to
 * Dashboard (which is home whenever this flag is off). Nothing renders while
 * the flag loads, so an enabled user is not bounced away early.
 */
export function ResponsibilitiesGate() {
  const { enabled, loaded } = useResponsibilitiesEnabled();
  if (!loaded) return null;
  if (!enabled) return <Navigate to={DASHBOARD_HOME_PATH} replace />;
  return <Outlet />;
}
