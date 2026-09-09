import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchSolarisAlerts,
  fetchSolarisOrgs,
  createSolarisAlert,
  createSolarisOrg,
  updateSolarisOrg,
  deleteSolarisOrg,
  type CreateAlertInput,
  type CreateOrgInput,
  type UpdateOrgInput,
} from "../api/solaris-alerts";

export type { SolarisOrg, SolarisAlert, AlertSeverity, AlertDispatchStatus, SupportedLanguage } from "../api/solaris-alerts";
export { LANGUAGE_LABELS, LOCALE_BADGES } from "../api/solaris-alerts";

export function useSolarisOrgs(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ["solaris-orgs", companyId],
    queryFn: () => fetchSolarisOrgs(companyId!),
    enabled: !!companyId,
    staleTime: 30_000,
  });
}

export function useSolarisAlerts(companyId: string | null | undefined, orgId?: string) {
  return useQuery({
    queryKey: ["solaris-alerts", companyId, orgId],
    queryFn: () => fetchSolarisAlerts(companyId!, orgId),
    enabled: !!companyId,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useCreateSolarisAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAlertInput) => createSolarisAlert(input),
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["solaris-alerts", input.companyId] });
    },
  });
}

export function useCreateSolarisOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrgInput) => createSolarisOrg(input),
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["solaris-orgs", input.companyId] });
    },
  });
}

export function useUpdateSolarisOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orgId, updates, companyId }: { orgId: string; updates: UpdateOrgInput; companyId: string }) =>
      updateSolarisOrg(orgId, updates),
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["solaris-orgs", companyId] });
    },
  });
}

export function useDeleteSolarisOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orgId }: { orgId: string; companyId: string }) => deleteSolarisOrg(orgId),
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["solaris-orgs", companyId] });
    },
  });
}
