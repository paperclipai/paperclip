import { useTranslation } from "@/i18n";
import { useEffect } from "react";
import { useParams, useSearchParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { advancedTabHref } from "../tool-tabs";
import { ToolsAdminGate } from "./ToolsAdminGate";
import { ProfileWizard } from "./ProfileWizard";
import { TEMPLATES, type TemplateKey } from "./profile-model";

/**
 * Full-page host for the access-profile create/resume wizard (PAP-10997 §B).
 * Mounted on its own routes so the three-step flow gets the whole page rather
 * than living inside the Advanced tab chrome. Guarded by the same admin gate as
 * the rest of the tool-access surface.
 */
export function ProfileWizardRoute({ mode }: { mode: "new" | "edit" }) {
  const { t: translateAgentPage } = useTranslation("agents");
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const params = useParams<{ profileId?: string }>();
  const [searchParams] = useSearchParams();

  const templateParam = searchParams.get("template");
  const stepParam = Number(searchParams.get("step"));
  const initialTemplate = TEMPLATES.some((t) => t.key === templateParam)
    ? (templateParam as TemplateKey)
    : undefined;
  const initialStep = stepParam === 2 || stepParam === 3 ? stepParam : undefined;

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? translateAgentPage("agents:organization"), href: "/dashboard" },
      { label: translateAgentPage("agents:apps_d9a368"), href: "/apps" },
      { label: translateAgentPage("agents:access_profiles"), href: advancedTabHref("profiles") },
      { label: mode === "edit" ? translateAgentPage("agents:resume_draft") : translateAgentPage("agents:new_profile") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name, mode, translateAgentPage]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">{translateAgentPage("agents:select_an_organization_to_create_a_profile")}</div>;
  }

  return (
    <ToolsAdminGate>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
        <header>
          <h1 className="text-xl font-bold text-foreground">
            {mode === "edit" ? translateAgentPage("agents:finish_your_profile") : translateAgentPage("agents:new_access_profile")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{translateAgentPage("agents:choose_which_tools_this_profile_allows_then_assign")}</p>
        </header>
        <ProfileWizard
          companyId={selectedCompanyId}
          profileId={mode === "edit" ? params.profileId : undefined}
          initialTemplate={initialTemplate}
          initialStep={initialStep}
        />
      </div>
    </ToolsAdminGate>
  );
}
