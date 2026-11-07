import { useTranslation } from "@/i18n";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";

export function ModeBadge({
  deploymentMode,
  deploymentExposure,
}: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
}) {
  const { t } = useTranslation("final-configuration");
  if (!deploymentMode) return null;

  const label =
    deploymentMode === "local_trusted"
      ? t("mode.local")
      : t("mode.authenticated", { exposure: deploymentExposure === "public" ? t("mode.public") : deploymentExposure === undefined || deploymentExposure === "private" ? t("mode.private") : deploymentExposure });

  return <Badge variant="outline">{label}</Badge>;
}
