import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { organizationsApi, type Organization } from "../api/organizations";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

interface OrgContextValue {
  organizations: Organization[];
  selectedOrgId: string | null;
  selectedOrg: Organization | null;
  loading: boolean;
  error: Error | null;
  setSelectedOrgId: (orgId: string) => void;
  reloadOrganizations: () => Promise<void>;
  createOrganization: (data: { name: string }) => Promise<Organization>;
}

const STORAGE_KEY = "paperclip.selectedOrgId";

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [selectedOrgId, setSelectedOrgIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY),
  );

  const { data: organizations = [], isLoading, error } = useQuery({
    queryKey: queryKeys.organizations.list,
    queryFn: async () => {
      try {
        return await organizationsApi.list();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return [];
        }
        throw err;
      }
    },
    retry: false,
  });

  useEffect(() => {
    if (organizations.length === 0) return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && organizations.some((o) => o.id === stored)) return;
    if (selectedOrgId && organizations.some((o) => o.id === selectedOrgId)) return;
    const next = organizations[0]!.id;
    setSelectedOrgIdState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, [organizations, selectedOrgId]);

  const setSelectedOrgId = useCallback((orgId: string) => {
    setSelectedOrgIdState(orgId);
    localStorage.setItem(STORAGE_KEY, orgId);
  }, []);

  const reloadOrganizations = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.list });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (data: { name: string }) => organizationsApi.create(data),
    onSuccess: (org) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.list });
      setSelectedOrgId(org.id);
    },
  });

  const createOrganization = useCallback(
    async (data: { name: string }) => createMutation.mutateAsync(data),
    [createMutation],
  );

  const selectedOrg = useMemo(
    () => organizations.find((o) => o.id === selectedOrgId) ?? null,
    [organizations, selectedOrgId],
  );

  const value = useMemo(
    () => ({
      organizations,
      selectedOrgId,
      selectedOrg,
      loading: isLoading,
      error: error as Error | null,
      setSelectedOrgId,
      reloadOrganizations,
      createOrganization,
    }),
    [
      organizations,
      selectedOrgId,
      selectedOrg,
      isLoading,
      error,
      setSelectedOrgId,
      reloadOrganizations,
      createOrganization,
    ],
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) {
    throw new Error("useOrg must be used within OrgProvider");
  }
  return ctx;
}
