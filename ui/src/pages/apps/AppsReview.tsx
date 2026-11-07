import { useTranslation } from "@/i18n";
import { useEffect } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { ReviewQueueCard } from "./ReviewQueueCard";

/**
 * Review — the "decisions waiting on you" inbox (PAP-12371, Finding B).
 *
 * Ask-first approvals used to live only inside the "Needs attention" page,
 * folded together with health/error triage. That buried the one thing a user
 * must act on for their agents to proceed. This is the explicit, top-level
 * home for those approvals, aligned with the Inbox "waiting for your OK"
 * language from the approved PAP-11178 gateway UX. Health issues stay on
 * "Needs attention"; decisions live here.
 */
export function AppsReview() {
  const { t } = useTranslation("connections");
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: t("connectors_4b1e950"), href: "/apps" },
      { label: t("review_e29a79f") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">{t("select_an_organization_to_review_approvals_0786e7d")}</div>;
  }

  return (
    <div className="max-w-3xl space-y-6 pb-12">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t("review_e29a79f")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("actions_your_agents_want_to_run_that_5910e60")}</p>
      </header>

      <ReviewQueueCard emptyState="reassure" heading={t("waiting_for_your_ok_9911c4f")} />
    </div>
  );
}
