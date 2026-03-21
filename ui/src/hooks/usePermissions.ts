import { useQuery } from "@tanstack/react-query";
import type { PermissionKey } from "@paperclipai/shared";
import { api } from "../api/client";

type MeResponse = {
  authenticated: boolean;
  type?: "board" | "agent";
  userId?: string | null;
  isInstanceAdmin?: boolean;
  source?: string;
  companies?: string[];
  permissions?: Record<string, string[]>;
  agentId?: string | null;
  companyId?: string | null;
};

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<MeResponse>("/me"),
    staleTime: 60_000,
    retry: false,
  });
}

export function useIsInstanceAdmin() {
  const { data } = useMe();
  if (!data?.authenticated) return false;
  return data.isInstanceAdmin === true || data.source === "local_implicit";
}

export function useHasPermission(companyId: string | undefined, permissionKey: PermissionKey): boolean {
  const { data } = useMe();
  if (!data?.authenticated) return false;
  if (data.isInstanceAdmin || data.source === "local_implicit") return true;
  if (!companyId || !data.permissions) return false;
  const companyPerms = data.permissions[companyId];
  return Array.isArray(companyPerms) && companyPerms.includes(permissionKey);
}
