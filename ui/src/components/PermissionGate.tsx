import type { ReactNode } from "react";
import type { PermissionKey } from "@paperclipai/shared";
import { useMe } from "../hooks/usePermissions";

interface PermissionGateProps {
  children: ReactNode;
  fallback?: ReactNode;
  requireAdmin?: boolean;
  requireAuth?: boolean;
  companyId?: string;
  permission?: PermissionKey;
}

export function PermissionGate({
  children,
  fallback = null,
  requireAdmin = false,
  requireAuth = true,
  companyId,
  permission,
}: PermissionGateProps) {
  const { data, isLoading } = useMe();

  if (isLoading) return null;
  if (requireAuth && !data?.authenticated) return <>{fallback}</>;
  if (requireAdmin && !data?.isInstanceAdmin && data?.source !== "local_implicit") {
    return <>{fallback}</>;
  }
  if (permission && companyId) {
    if (data?.isInstanceAdmin || data?.source === "local_implicit") {
      return <>{children}</>;
    }
    const companyPerms = data?.permissions?.[companyId];
    if (!Array.isArray(companyPerms) || !companyPerms.includes(permission)) {
      return <>{fallback}</>;
    }
  }
  return <>{children}</>;
}
