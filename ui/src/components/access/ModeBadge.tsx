import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "@/i18n";

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
      ? t("localizationFinalAudit.modeLocalTrusted")
      : t(`localizationFinalAudit.modeAuthenticated_${deploymentExposure ?? "private"}`, {
          defaultValue: `Authenticated ${deploymentExposure ?? "private"}`,
        });

  return <Badge variant="outline">{label}</Badge>;
}
