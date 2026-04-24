import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/context/LocaleContext";

export function ModeBadge({
  deploymentMode,
  deploymentExposure,
}: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
}) {
  const { t } = useI18n();
  if (!deploymentMode) return null;

  const label =
    deploymentMode === "local_trusted"
      ? t("modeBadge.localTrusted")
      : deploymentExposure === "public"
        ? t("modeBadge.authenticatedPublic")
        : t("modeBadge.authenticatedPrivate");

  return <Badge variant="outline">{label}</Badge>;
}
