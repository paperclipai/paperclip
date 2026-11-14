import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
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
 * feature on never flashes a redirect on a hard load. The same holds when the
 * flag cannot be read at all: an outage waits quietly for the reconnect, and
 * a real failure shows readable copy with Retry, because with no settings
 * there is no flag to redirect on.
 */
export function IsolatedWorkspacesRouteGate() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const view = useQueryView(query);

  if (query.data === undefined) {
    if (view.kind === "error") {
      return (
        <QueryErrorState
          size="page"
          error={view.error}
          action="load workspaces"
          onRetry={view.retry}
          retrying={view.isFetching}
        />
      );
    }
    return null;
  }
  if (query.data.enableIsolatedWorkspaces !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <Outlet />;
}
