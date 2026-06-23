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

  const exposure = deploymentExposure ?? "private";
  const exposureLabel =
    exposure === "public"
      ? t("components.modeBadge.exposurePublic", { defaultValue: "public" })
      : t("components.modeBadge.exposurePrivate", { defaultValue: "private" });

  const label =
    deploymentMode === "local_trusted"
      ? t("components.modeBadge.localTrusted", { defaultValue: "Local trusted" })
      : t("components.modeBadge.authenticatedExposure", {
          exposure: exposureLabel,
          defaultValue: "Authenticated {{exposure}}",
        });

  return <Badge variant="outline">{label}</Badge>;
}
