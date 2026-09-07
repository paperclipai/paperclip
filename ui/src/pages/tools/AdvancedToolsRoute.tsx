import { useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { ToolsAccess } from "./ToolsAccess";

/**
 * Admin gate for the Advanced door (PAP-10862, plan D8). The developer surface
 * lives under `/apps/advanced` and is reserved for administrators (`tools:admin`
 * on the server). This is a best-effort UX gate — the server is authoritative —
 * derived from the caller's board access: instance admins and company
 * owners/admins pass. Non-admins get a friendly explanation rather than a 403.
 */
export function AdvancedToolsRoute() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });

  if (boardAccess.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("pages.secrets.status.loading")}</div>;
  }

  const data = boardAccess.data;
  const membership = data?.memberships?.find((m) => m.companyId === selectedCompanyId);
  const isAdmin =
    Boolean(data?.isInstanceAdmin) ||
    membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin";

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-foreground">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{t("localizationTools.advancedSetupIsForAdministrators398")}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            <Trans t={t} i18nKey="localizationTools.advancedAdminHint" components={{ apps: <Link to="/apps" className="font-medium text-primary hover:underline" /> }} />
          </p>
        </div>
      </div>
    );
  }

  return <ToolsAccess />;
}
