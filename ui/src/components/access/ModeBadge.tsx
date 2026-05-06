import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import i18n from "@/i18n";
import { Badge } from "@/components/ui/badge";

export function ModeBadge({
  deploymentMode,
  deploymentExposure,
}: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
}) {
  if (!deploymentMode) return null;

  const label =
    deploymentMode === "local_trusted"
      ? i18n.t("components.access.ModeBadge.conditional")
      : `Authenticated ${deploymentExposure ?? "private"}`;

  return <Badge variant="outline">{label}</Badge>;
}
