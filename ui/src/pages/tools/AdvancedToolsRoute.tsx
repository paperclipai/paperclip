import { useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { accessApi } from "@/api/access";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { ToolsAccess } from "./ToolsAccess";

/**
 * Admin gate for the Advanced door (PAP-10862, plan D8). The developer surface
 * lives under `/apps/advanced` and requires `tools:admin` on the server.
 * This is a best-effort UX gate derived from role defaults: local boards,
 * instance admins, and active company owners/admins/operators pass.
 * The server is authoritative.
 *
 * An outage before the first load is a placeholder, never a denial: the
 * denial card is only for a loaded answer (or a real 403).
 */
export function AdvancedToolsRoute() {
  const { t: translateAgentPage } = useTranslation("agents");
  const { selectedCompanyId } = useCompany();
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const view = useQueryView(boardAccess);

  if (boardAccess.isLoading || view.kind === "reconnecting") {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{translateAgentPage("agents:loading")}</div>;
  }
  if (view.kind === "error" && view.errorKind !== "forbidden") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <QueryErrorState
          error={boardAccess.error}
          action={translateAgentPage("agents:check_your_access")}
          onRetry={view.retry}
          retrying={view.isFetching}
        />
      </div>
    );
  }

  const data = boardAccess.data;
  const membership = data?.memberships?.find((m) => m.companyId === selectedCompanyId && m.status === "active");
  const canManageTools =
    data?.source === "local_implicit" ||
    Boolean(data?.isInstanceAdmin) ||
    membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin" ||
    membership?.membershipRole === "operator" ||
    membership?.membershipRole === "member";

  if (!canManageTools) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-foreground">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{translateAgentPage("agents:advanced_setup_requires_editing_access")}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{translateAgentPage("agents:this_area_lets_company_editors_wire_up_tools")}{" "}
            <Link to="/apps" className="font-medium text-primary hover:underline">{translateAgentPage("agents:your_apps")}</Link>
            .
          </p>
        </div>
      </div>
    );
  }

  return <ToolsAccess />;
}
