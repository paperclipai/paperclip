import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";

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
      ? t("instanceSettings.general.modeLocalTrusted")
      : t("instanceSettings.general.modeAuthenticated", { exposure: t(`instanceSettings.general.exposure_${deploymentExposure ?? "private"}` as any, { defaultValue: deploymentExposure ?? "private" }) });

  return <Badge variant="outline">{label}</Badge>;
}
