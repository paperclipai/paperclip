import { t as finalPagesT } from "@/i18n";
import { t as translateShell, useTranslation } from "@/i18n";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { agentsApi } from "@/api/agents";
import { InlineEntitySelector, type InlineEntityOption } from "@/components/InlineEntitySelector";
import { isAgentTaskTarget } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Picker for the agent that runs a card's updates. `value` is the override
 * agent id, or "" for the company's built-in Summarizer (the default).
 */
export function SummarizerAgentSelect({
  companyId,
  value,
  onChange,
  enabled = true,
}: {
  companyId: string | null | undefined;
  value: string;
  onChange: (agentId: string) => void;
  enabled?: boolean;
}) {
  const { t: translateShell } = useTranslation("shell");
  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId) && enabled,
  });
  const agentById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent])),
    [agentsQuery.data, translateShell],
  );
  const agentOptions = useMemo<InlineEntityOption[]>(
    () =>
      (agentsQuery.data ?? [])
        .filter(isAgentTaskTarget)
        .map((agent) => ({
          id: `agent:${agent.id}`,
          label: agent.name,
          searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
        })),
    [agentsQuery.data, translateShell],
  );

  const renderAgent = (option: InlineEntityOption | null) => {
    if (!option || !option.id) return <span>{translateShell("shell:summarizer_default")}</span>;
    const agent = option.id.startsWith("agent:") ? agentById.get(option.id.slice("agent:".length)) : null;
    return (
      <>
        {agent ? <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
        <span className="truncate">{option.label}</span>
      </>
    );
  };

  return (
    <InlineEntitySelector
      value={value ? `agent:${value}` : ""}
      options={agentOptions}
      placeholder={translateShell("shell:summarizer_default")}
      noneLabel={finalPagesT("final-pages:Summarizer_default_8302e6")}
      searchPlaceholder={translateShell("shell:search_agents")}
      emptyMessage={translateShell("shell:extra_45_no_agents_found_")}
      onChange={(next) => onChange(next.startsWith("agent:") ? next.slice("agent:".length) : "")}
      className="h-8 text-sm"
      renderTriggerValue={renderAgent}
      renderOption={(option) => renderAgent(option)}
    />
  );
}
