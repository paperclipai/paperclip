import type { HostFeatureKey } from "@paperclipai/shared";
import { Navigate, Outlet } from "@/lib/router";
import { useRuntimeFeatures } from "@/context/RuntimeFeaturesContext";

export function HostFeatureGate({
  feature,
  fallback = "/apps/connections",
}: {
  feature: HostFeatureKey;
  fallback?: string;
}) {
  const { hasFeature } = useRuntimeFeatures();
  return hasFeature(feature) ? <Outlet /> : <Navigate to={fallback} replace />;
}
