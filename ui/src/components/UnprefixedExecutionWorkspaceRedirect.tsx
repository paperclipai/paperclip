import { useQuery } from "@tanstack/react-query";
import { executionWorkspacesApi } from "@/api/execution-workspaces";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Navigate, Outlet, useLocation, useParams } from "@/lib/router";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";
import { QueryErrorState, useQueryView, type QueryViewState } from "./QueryView";
import { NotFoundPage } from "../pages/NotFound";

/**
 * A workspace lookup decides where a URL goes. An outage must not look like a
 * missing workspace: keep the loading screen while reconnecting, show "not
 * found" only for a real 404 (or a denial, which must not leak existence),
 * and readable copy for anything else.
 */
function useWorkspaceLookup(workspaceId: string | undefined) {
  const query = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId ?? "__missing__"),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  return { workspace: query.data, view: useQueryView(query) };
}

function workspaceLookupGate(view: QueryViewState<unknown>, companiesLoading: boolean) {
  if (companiesLoading || view.kind === "loading" || view.kind === "reconnecting") return <PaperclipLoading />;
  if (view.kind === "error") {
    if (view.errorKind === "not_found" || view.errorKind === "forbidden" || view.errorKind === "auth") {
      return <NotFoundPage scope="global" />;
    }
    return (
      <QueryErrorState
        size="page"
        error={view.error}
        action="open this workspace"
        onRetry={view.retry}
        retrying={view.isFetching}
      />
    );
  }
  return null;
}

/** Resolve a prefix-free workspace URL from the resource, not browsing state. */
export function UnprefixedExecutionWorkspaceRedirect() {
  const location = useLocation();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { companies, loading: companiesLoading } = useCompany();
  const { workspace, view } = useWorkspaceLookup(workspaceId);

  if (!workspaceId) return <NotFoundPage scope="global" />;
  const gate = workspaceLookupGate(view, companiesLoading);
  if (gate) return gate;
  if (!workspace) return <PaperclipLoading />;

  const targetCompany = companies.find(
    (company) => company.id === workspace.companyId,
  );
  if (!targetCompany) return <NotFoundPage scope="global" />;

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

/** Reject a prefixed URL when its prefix and workspace belong to different companies. */
export function ExecutionWorkspaceCompanyGate() {
  const { companyPrefix, workspaceId } = useParams<{
    companyPrefix?: string;
    workspaceId?: string;
  }>();
  const { companies, loading: companiesLoading } = useCompany();
  const { workspace, view } = useWorkspaceLookup(workspaceId);

  if (!workspaceId || !companyPrefix) return <NotFoundPage scope="global" />;
  const gate = workspaceLookupGate(view, companiesLoading);
  if (gate) return gate;
  if (!workspace) return <PaperclipLoading />;

  const routeCompany = companies.find(
    (company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
  );
  if (!routeCompany || routeCompany.id !== workspace.companyId) {
    return <NotFoundPage scope="global" />;
  }

  return <Outlet />;
}
