import { Navigate, Outlet } from "@/lib/router";
import { useAppsEnabled } from "@/hooks/useAppsEnabled";

export function AppsExperimentalGate() {
  const { enabled, loaded } = useAppsEnabled();

  if (!loaded) return null;
  if (!enabled) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
