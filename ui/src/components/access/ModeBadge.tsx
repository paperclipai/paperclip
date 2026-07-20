import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

export function ModeBadge({
  deploymentMode,
  deploymentExposure,
}: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
}) {
  const { t } = useTranslation();
  if (!deploymentMode) return null;

  const label =
    deploymentMode === "local_trusted"
      ? t("settings.generalPage.localTrusted")
      : deploymentExposure === "public"
        ? t("settings.generalPage.authenticatedPublic")
        : t("settings.generalPage.authenticatedPrivate");

  return <Badge variant="outline">{label}</Badge>;
}
