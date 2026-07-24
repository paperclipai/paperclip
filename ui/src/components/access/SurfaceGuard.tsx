import type { ReactNode } from "react";
import type { CompanySettingsSurface } from "@paperclipai/shared";
import { Navigate } from "@/lib/router";
import { useBoardCapabilities } from "@/hooks/useFeatures";

/**
 * Navigation-miss guard for company settings surfaces (PR-1). If the loaded
 * capabilities say the surface is hidden, redirect to the company settings
 * root instead of rendering a page whose API calls will 403 with
 * surface_not_exposed. While capabilities are loading or failed we render
 * the page (server-side enforcement remains authoritative).
 */
export function SurfaceGuard({
  surface,
  children,
}: {
  surface: CompanySettingsSurface;
  children: ReactNode;
}) {
  const { data: boardAccess } = useBoardCapabilities();
  if (boardAccess && !boardAccess.capabilities.exposedSurfaces.includes(surface)) {
    return <Navigate to="/company/settings" replace />;
  }
  return <>{children}</>;
}
