import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Route gate for the isolated-workspace pages: the workspaces board, the
 * execution-workspace detail tabs, and the project-workspace detail page.
 *
 * The sidebar entry for these pages already reads `enableIsolatedWorkspaces`,
 * but the routes rendered for anyone who typed or bookmarked the URL, so the
 * whole workspace surface stayed reachable on an instance with the feature off.
 * The gate redirects to the dashboard instead, mirroring
 * {@link HiddenSettingsPageGate}.
 *
 * Nothing renders until the flag query settles, so an instance that has the
 * feature on never flashes a redirect on a hard load.
 */
export function IsolatedWorkspacesRouteGate() {
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (!isFetched) return null;
  if (experimentalSettings?.enableIsolatedWorkspaces !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <Outlet />;
}
