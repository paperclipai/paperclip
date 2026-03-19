import type { ReactNode } from "react";
import { useMe } from "../hooks/usePermissions";

interface PermissionGateProps {
  children: ReactNode;
  fallback?: ReactNode;
  requireAdmin?: boolean;
  requireAuth?: boolean;
}

export function PermissionGate({
  children,
  fallback = null,
  requireAdmin = false,
  requireAuth = true,
}: PermissionGateProps) {
  const { data, isLoading } = useMe();

  if (isLoading) return null;
  if (requireAuth && !data?.authenticated) return <>{fallback}</>;
  if (requireAdmin && !data?.isInstanceAdmin && data?.source !== "local_implicit") {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
