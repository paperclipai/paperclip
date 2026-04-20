import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
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
      ? "Local trusted"
      : `Authenticated ${deploymentExposure ?? "private"}`;

  return <Badge variant="outline">{label}</Badge>;
}
