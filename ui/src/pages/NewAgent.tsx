import { useTranslation } from "@/i18n";
import { useEffect } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { NewAgentSetup } from "../components/new-agent/NewAgentSetup";

export function NewAgent() {
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: t("agents.list.breadcrumb"), href: "/agents" },
      { label: t("agents.newAgent.breadcrumb") },
    ]);
  }, [setBreadcrumbs]);
  return <NewAgentSetup />;
}
