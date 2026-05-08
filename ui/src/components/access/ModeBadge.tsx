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
  const { t } = useTranslation("settings");
  if (!deploymentMode) return null;

  const label =
    deploymentMode === "local_trusted"
      ? t("mode_badge.local_trusted")
      : t("mode_badge.authenticated", { exposure: deploymentExposure ?? "private" });

  return <Badge variant="outline">{label}</Badge>;
}
