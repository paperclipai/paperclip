import { useQuery } from "@tanstack/react-query";
import { billingApi } from "../api/billing";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

export type SubscriptionState = {
  status: string | null;
  canWrite: boolean;
  isLoading: boolean;
  trialDaysLeft: number | null;
};

export function useSubscription(): SubscriptionState {
  const { selectedCompany } = useCompany();

  const query = useQuery({
    queryKey: queryKeys.billing.subscription(selectedCompany?.id ?? ""),
    queryFn: () => billingApi.getSubscription(selectedCompany!.id),
    enabled: !!selectedCompany,
    staleTime: 30_000,
  });

  const sub = query.data;
  if (!sub) {
    return { status: null, canWrite: true, isLoading: query.isLoading, trialDaysLeft: null };
  }

  const canWrite = ["active", "trialing", "free", "past_due"].includes(sub.status);

  let trialDaysLeft: number | null = null;
  if (sub.status === "trialing" && sub.trialEndsAt) {
    const diff = new Date(sub.trialEndsAt).getTime() - Date.now();
    trialDaysLeft = diff > 0 ? Math.ceil(diff / (1000 * 60 * 60 * 24)) : 0;
  }

  return { status: sub.status, canWrite, isLoading: query.isLoading, trialDaysLeft };
}
