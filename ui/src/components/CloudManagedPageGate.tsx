import { Navigate, Outlet } from "@/lib/router";
import { useCloudInstance } from "@/hooks/useCloudInstance";

/**
 * Route gate for pages that are floored on cloud-managed instances (the
 * server answers 403 `cloud_managed`), like company import. Cloud-managed
 * instances redirect to the settings root instead of rendering a dead-ended
 * page. Under
 * CloudAccessGate the health response is always cached before board routes
 * mount, so the cloud flag is already resolved when this renders.
 */
export function CloudManagedPageGate() {
  const isCloud = Boolean(useCloudInstance());

  if (isCloud) return <Navigate to="/company/settings" replace />;
  return <Outlet />;
}
