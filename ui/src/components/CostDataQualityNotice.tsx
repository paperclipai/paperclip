import { t, useTranslation } from "@/i18n";
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "../lib/router";
import type { CostDataQualityItem, CostDataQualityReason } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { formatDateTime } from "../lib/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { AgentAvatar } from "./AgentAvatar";
import { useToastActions } from "../context/ToastContext";

const explanations: Record<CostDataQualityReason, { label: string; description: string }> = {
  unknown_billing: {
    get label() { return t("task-components:billingCategoryUnknown_a545221d"); },
    get description() { return t("task-components:thisRunDidNotIdentifyApiOr_ddc82e55"); },
  },
  missing_model: {
    get label() { return t("task-components:modelNotReported_794a6374"); },
    get description() { return t("task-components:tokenUsageWasRecordedWithoutAModel_8a2f92f8"); },
  },
  missing_price: {
    get label() { return t("task-components:costUnavailable_b1e2387a"); },
    get description() { return t("task-components:theProviderDidNotSupplyAReliable_b3b4379f"); },
  },
  waiting_for_receipt: {
    get label() { return t("task-components:receivingUsage_52dce6c3"); },
    get description() { return t("task-components:thisRunHasStoppedPaperclipIsWaiting_f4bd2248"); },
  },
  receipt_unavailable: {
    get label() { return t("task-components:finalUsageUnavailable_0acba8cb"); },
    get description() { return t("task-components:thisRunStoppedWithoutFinalUsageData_099cacf8"); },
  },
  retryable: {
    get label() { return t("task-components:readyToRecord_faf7eee2"); },
    get description() { return t("task-components:savedUsageDataIsReadyToBe_0dbb47a6"); },
  },
};

export function CostDataQualityNotice({ companyId, from, to, reportKey, unpricedCount, pendingCount, unknownBillingCount }: {
  companyId: string; from?: string; to?: string; reportKey: readonly unknown[];
  unpricedCount: number; pendingCount: number; unknownBillingCount: number;
}) {
  useTranslation("task-components");
  const [open, setOpen] = useState(false);
  const unavailableCount = unpricedCount + pendingCount;
  const hasCostGaps = unavailableCount > 0 || unknownBillingCount > 0;
  const detailsId = useId();
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const key = [...reportKey, "data-quality"];
  const { data, error, isPending, refetch } = useQuery({
    queryKey: key,
    queryFn: () => costsApi.dataQuality(companyId, from, to),
    enabled: open && hasCostGaps,
    refetchInterval: open && hasCostGaps ? 30_000 : false,
  });
  const retry = useMutation({
    mutationFn: (runId: string) => costsApi.retryAccounting(companyId, runId),
    onSuccess: result => {
      pushToast({ presentation: { title: result.accounted ? { key: "final-components-a:costsRecorded_5968d6d6" } : { key: "final-components-a:noNewCostDataIs_dae05442" }, body: { key: "final-components-a:theAgentWasNotRerun_1cf192c0" } }, 
        title: result.accounted ? t("final-components-a:costsRecorded_5968d6d6") : t("final-components-a:noNewCostDataIs_dae05442"),
        body: t("final-components-a:theAgentWasNotRerun_1cf192c0"),
        tone: result.accounted ? "success" : "info",
      });
      client.invalidateQueries({ queryKey: ["costs", companyId] });
      client.invalidateQueries({ queryKey: key });
      client.invalidateQueries({ queryKey: ["cost-subscriptions", companyId] });
    },
  });
  const label = unavailableCount > 0
    ? t("final-components-a:runCostsUnavailable", { count: unavailableCount })
    : t("final-components-a:billingTypesUnknown", { count: unknownBillingCount });

  const groups = new Map<string | null, {
    agent: { id?: string; name: string; appearance?: CostDataQualityItem["agentAppearance"] };
    items: { item: CostDataQualityItem; source: "event" | "run" }[];
  }>();
  for (const [source, items] of [["event", data?.events ?? []], ["run", data?.runs ?? []]] as const) {
    for (const item of items) {
      let group = groups.get(item.agentId);
      if (!group) {
        group = { agent: { id: item.agentId ?? undefined, name: item.agentName ?? (item.agentId ? t("final-components-a:unknownAgent_342b4ab2") : t("final-components-a:paperclipServices_6485381e")), appearance: item.agentAppearance }, items: [] };
        groups.set(item.agentId, group);
      }
      group.items.push({ item, source });
    }
  }
  const sortedGroups = [...groups.values()].sort((a, b) =>
    a.agent.name.localeCompare(b.agent.name, "en", { sensitivity: "base", numeric: true })
    || (a.agent.id ?? "").localeCompare(b.agent.id ?? ""));
  for (const group of sortedGroups) group.items.sort((a, b) =>
    Date.parse(b.item.occurredAt) - Date.parse(a.item.occurredAt)
    || `${a.source}:${a.item.id}`.localeCompare(`${b.source}:${b.item.id}`));

  function itemRow(item: CostDataQualityItem, source: "event" | "run") {
    const explanation = explanations[item.reason];
    return <li key={`${source}:${item.id}`} className="space-y-2 border-b border-border py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-normal text-muted-foreground">{explanation.label}</Badge>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
          {item.runId && item.agentId && <Link className="text-primary underline underline-offset-4 hover:text-primary/80" to={`/agents/${item.agentId}/runs/${item.runId}`}>{t("task-components:viewRun_aaf7fccc")}</Link>}
          {item.reason === "retryable" && item.runId && data?.canRetry && <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs font-normal underline hover:text-primary/80" disabled={retry.isPending}
            onClick={() => { retry.reset(); retry.mutate(item.runId!); }}>{t("task-components:retryCostRecording_ba3ca963")}</Button>}
        </div>
      </div>
      <p>{explanation.description}</p>
      {retry.variables === item.runId && retry.isPending && <p role="status">{t("task-components:recordingSavedCosts_f6dcf9eb")}</p>}
      {retry.variables === item.runId && retry.error && <p role="status">{t("task-components:costRecordingFailedTryAgainShortly_a3e7c205")}</p>}
    </li>;
  }

  return <div className="space-y-2 text-sm text-muted-foreground">
    <Button type="button" variant="ghost" size="sm" className="h-auto justify-start gap-1 px-0 py-1 font-normal has-[>svg]:px-0" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}>
      {open ? <ChevronDown className="size-3" aria-hidden="true" /> : <ChevronRight className="size-3" aria-hidden="true" />}
      {label}
    </Button>
    {open && <div id={detailsId} className="space-y-2">
      {hasCostGaps && isPending && <p role="status">{t("task-components:loadingAffectedRuns_3dd744c7")}</p>}
      {hasCostGaps && error && !data && <div className="flex flex-wrap items-center gap-2"><p role="status">{t("task-components:costDetailsCouldNotBeLoaded_aadf8e23")}</p><Button variant="outline" size="sm" onClick={() => refetch()}>{t("task-components:retryLoading_a0f859bc")}</Button></div>}
      {hasCostGaps && data && <>
        {error && <p role="status">{t("task-components:showingTheLastLoadedCostDetailsUpdates_115d4a4e")}</p>}
        {data.events.length === 0 && data.runs.length === 0 && <p role="status">{t("task-components:noCostGapsRemainInThisPeriod_4349449b")}</p>}
        <ul aria-label={t("task-components:costDetailsByAgent_3be96e07")} className="space-y-4">
          {sortedGroups.map(group => <li key={group.agent.id ?? "services"}>
            <h3 className="flex items-center gap-2 font-medium text-foreground">
              <AgentAvatar agent={group.agent} size={20} />
              {group.agent.id ? <Link className="text-primary underline underline-offset-4 hover:text-primary/80" to={`/agents/${group.agent.id}/configuration`}>{group.agent.name}</Link> : group.agent.name}
            </h3>
            <ul aria-label={t("task-components:costDetails_80bc9850", { value1: group.agent.name })}>{group.items.map(({ item, source }) => itemRow(item, source))}</ul>
          </li>)}
        </ul>
        {(data.hasMoreEvents || data.hasMoreRuns) && <p className="text-xs">{t("task-components:showingThe25MostRecentEntriesIn_771282d2")}</p>}
      </>}
    </div>}
  </div>;
}
