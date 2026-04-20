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
      ? i18n.t("settings:modeBadge.localTrusted", { defaultValue: "Local trusted" })
      : i18n.t("settings:modeBadge.authenticated", { defaultValue: "Authenticated {{exposure}}", exposure: deploymentExposure ?? "private" });

  return <Badge variant="outline">{label}</Badge>;
}
