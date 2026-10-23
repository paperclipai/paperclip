import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { aiConnectionsApi } from "../api/ai-connections";
import { useCompany } from "../context/CompanyContext";
import {
  clearStaleAiHealthDismissal,
  readAiHealthDismissal,
  subscribeAiHealthDismissal,
  summarizeAiHealth,
  writeAiHealthDismissal,
} from "../lib/ai-health";

/** Broken AI accounts of the selected company and the hiding of their warning, shared by the bar and the top-bar pill. */
export function useAiAccountHealth() {
  const { selectedCompanyId } = useCompany();
  const query = useQuery({
    queryKey: ["ai-connections", selectedCompanyId ?? "", "health"],
    queryFn: () => aiConnectionsApi.health(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 60_000,
  });
  const problems = summarizeAiHealth(query.data);
  const loaded = query.isSuccess;
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((version) => version + 1);
  useEffect(() => subscribeAiHealthDismissal(rerender), []);
  useEffect(() => {
    if (loaded && selectedCompanyId) clearStaleAiHealthDismissal(selectedCompanyId, problems.signature);
  }, [loaded, selectedCompanyId, problems.signature]);
  const hiddenUntil = selectedCompanyId && problems.signature ? readAiHealthDismissal(selectedCompanyId, problems.signature) : null;
  useEffect(() => {
    if (!hiddenUntil) return;
    const timeout = window.setTimeout(rerender, hiddenUntil - Date.now());
    return () => window.clearTimeout(timeout);
  }, [hiddenUntil]);
  return {
    problems,
    checkFailed: query.isError && !query.data,
    retrying: query.isFetching,
    retry: () => void query.refetch(),
    dismissed: hiddenUntil !== null,
    dismiss: () => {
      if (selectedCompanyId) writeAiHealthDismissal(selectedCompanyId, problems.signature);
    },
    reopen: () => {
      if (selectedCompanyId) writeAiHealthDismissal(selectedCompanyId, null);
    },
  };
}
