import { useQuery } from "@tanstack/react-query";
import { executionWorkspacesApi } from "@/api/execution-workspaces";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Navigate, Outlet, useLocation, useParams } from "@/lib/router";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";
import { NotFoundPage } from "../pages/NotFound";

/** Resolve a prefix-free workspace URL from the resource, not browsing state. */
export function UnprefixedExecutionWorkspaceRedirect() {
  const location = useLocation();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { companies, loading: companiesLoading } = useCompany();
  const workspaceQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId ?? "__missing__"),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
    retry: false,
  });

  if (!workspaceId) return <NotFoundPage scope="global" />;
  if (companiesLoading || workspaceQuery.isPending) return <PaperclipLoading />;
  if (workspaceQuery.isError) return <NotFoundPage scope="global" />;

  const targetCompany = companies.find(
    (company) => company.id === workspaceQuery.data.companyId,
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
  const workspaceQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId ?? "__missing__"),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
    retry: false,
  });

  if (!workspaceId || !companyPrefix) return <NotFoundPage scope="global" />;
  if (companiesLoading || workspaceQuery.isPending) return <PaperclipLoading />;
  if (workspaceQuery.isError) return <NotFoundPage scope="global" />;

  const routeCompany = companies.find(
    (company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
  );
  if (!routeCompany || routeCompany.id !== workspaceQuery.data.companyId) {
    return <NotFoundPage scope="global" />;
  }

  return <Outlet />;
}
