import { useTranslation } from "react-i18next";
import { useEffect } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { NewAgentSetup } from "../components/new-agent/NewAgentSetup";

export function NewAgent() {
  const { t } = useTranslation("settings");
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: t("newAgent.agents"), href: "/agents" },
      { label: t("newAgent.new_agent") },
    ]);
  }, [t, setBreadcrumbs]);
  return <NewAgentSetup />;
}