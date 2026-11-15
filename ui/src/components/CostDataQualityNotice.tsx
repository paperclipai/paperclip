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
    label: "Billing category unknown",
    description: "This run did not identify API or subscription billing. Any recorded charges are included in the inference ledger. For future runs, select an AI connection in the agent’s configuration so Paperclip can identify its billing.",
  },
  missing_model: {
    label: "Model not reported",
    description: "Token usage was recorded without a model, so Paperclip cannot estimate its cost. Select an explicit model in the agent’s configuration for future runs. Changing settings will not reprice this past run.",
  },
  missing_price: {
    label: "Cost unavailable",
    description: "The provider did not supply a reliable price for this usage. There is no action required for this past entry. New API runs with complete usage and a supported model are estimated automatically.",
  },
  waiting_for_receipt: {
    label: "Receiving usage",
    description: "This run has stopped. Paperclip is waiting for its final usage data and will record it automatically. You do not need to rerun the agent.",
  },
  receipt_unavailable: {
    label: "Final usage unavailable",
    description: "This run stopped without final usage data. Its cost remains unresolved for budget checks. Paperclip will record a late receipt if one arrives; rerunning the agent will not recover this usage.",
  },
  retryable: {
    label: "Ready to record",
    description: "Saved usage data is ready to be recorded. Paperclip retries automatically, or you can retry now. This records costs only; it does not rerun the agent.",
  },
};

export function CostDataQualityNotice({ companyId, from, to, reportKey, unpricedCount, pendingCount, unknownBillingCount }: {
  companyId: string; from?: string; to?: string; reportKey: readonly unknown[];
  unpricedCount: number; pendingCount: number; unknownBillingCount: number;
}) {
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
      pushToast({
        title: result.accounted ? "Costs recorded." : "No new cost data is available.",
        body: "The agent was not rerun.",
        tone: result.accounted ? "success" : "info",
      });
      client.invalidateQueries({ queryKey: ["costs", companyId] });
      client.invalidateQueries({ queryKey: key });
      client.invalidateQueries({ queryKey: ["cost-subscriptions", companyId] });
    },
  });
  const label = unavailableCount > 0
    ? `${unavailableCount} run ${unavailableCount === 1 ? "cost" : "costs"} unavailable`
    : `${unknownBillingCount} billing ${unknownBillingCount === 1 ? "type" : "types"} unknown`;

  const groups = new Map<string | null, {
    agent: { id?: string; name: string; appearance?: CostDataQualityItem["agentAppearance"] };
    items: { item: CostDataQualityItem; source: "event" | "run" }[];
  }>();
  for (const [source, items] of [["event", data?.events ?? []], ["run", data?.runs ?? []]] as const) {
    for (const item of items) {
      let group = groups.get(item.agentId);
      if (!group) {
        group = { agent: { id: item.agentId ?? undefined, name: item.agentName ?? (item.agentId ? "Unknown agent" : "Paperclip services"), appearance: item.agentAppearance }, items: [] };
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
          {item.runId && item.agentId && <Link className="text-primary underline underline-offset-4 hover:text-primary/80" to={`/agents/${item.agentId}/runs/${item.runId}`}>View run</Link>}
          {item.reason === "retryable" && item.runId && data?.canRetry && <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs font-normal underline hover:text-primary/80" disabled={retry.isPending}
            onClick={() => { retry.reset(); retry.mutate(item.runId!); }}>Retry cost recording</Button>}
        </div>
      </div>
      <p>{explanation.description}</p>
      {retry.variables === item.runId && retry.isPending && <p role="status">Recording saved costs…</p>}
      {retry.variables === item.runId && retry.error && <p role="status">Cost recording failed. Try again shortly.</p>}
    </li>;
  }

  return <div className="space-y-2 text-sm text-muted-foreground">
    <Button type="button" variant="ghost" size="sm" className="h-auto justify-start gap-1 px-0 py-1 font-normal has-[>svg]:px-0" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}>
      {open ? <ChevronDown className="size-3" aria-hidden="true" /> : <ChevronRight className="size-3" aria-hidden="true" />}
      {label}
    </Button>
    {open && <div id={detailsId} className="space-y-2">
      {hasCostGaps && isPending && <p role="status">Loading affected runs…</p>}
      {hasCostGaps && error && !data && <div className="flex flex-wrap items-center gap-2"><p role="status">Cost details could not be loaded.</p><Button variant="outline" size="sm" onClick={() => refetch()}>Retry loading</Button></div>}
      {hasCostGaps && data && <>
        {error && <p role="status">Showing the last loaded cost details. Updates will resume automatically.</p>}
        {data.events.length === 0 && data.runs.length === 0 && <p role="status">No cost gaps remain in this period.</p>}
        <ul aria-label="Cost details by agent" className="space-y-4">
          {sortedGroups.map(group => <li key={group.agent.id ?? "services"}>
            <h3 className="flex items-center gap-2 font-medium text-foreground">
              <AgentAvatar agent={group.agent} size={20} />
              {group.agent.id ? <Link className="text-primary underline underline-offset-4 hover:text-primary/80" to={`/agents/${group.agent.id}/configuration`}>{group.agent.name}</Link> : group.agent.name}
            </h3>
            <ul aria-label={`${group.agent.name} cost details`}>{group.items.map(({ item, source }) => itemRow(item, source))}</ul>
          </li>)}
        </ul>
        {(data.hasMoreEvents || data.hasMoreRuns) && <p className="text-xs">Showing the 25 most recent entries in each category. Select a shorter date range to inspect more.</p>}
      </>}
    </div>}
  </div>;
}
