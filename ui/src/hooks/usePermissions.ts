import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

type MeResponse = {
  authenticated: boolean;
  type?: "board" | "agent";
  userId?: string | null;
  isInstanceAdmin?: boolean;
  source?: string;
  companies?: string[];
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
