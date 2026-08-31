import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { agentsApi } from "@/api/agents";
import { AgentIcon } from "@/components/AgentIconPicker";
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
  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId) && enabled,
  });
  const agentById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent])),
    [agentsQuery.data],
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
    [agentsQuery.data],
  );

  const renderAgent = (option: InlineEntityOption | null) => {
    if (!option || !option.id) return <span>Summarizer (default)</span>;
    const agent = option.id.startsWith("agent:") ? agentById.get(option.id.slice("agent:".length)) : null;
    return (
      <>
        {agent ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
        <span className="truncate">{option.label}</span>
      </>
    );
  };

  return (
    <InlineEntitySelector
      value={value ? `agent:${value}` : ""}
      options={agentOptions}
      placeholder="Summarizer (default)"
      noneLabel="Summarizer (default)"
      searchPlaceholder="Search agents..."
      emptyMessage="No agents found."
      onChange={(next) => onChange(next.startsWith("agent:") ? next.slice("agent:".length) : "")}
      className="h-8 text-sm"
      renderTriggerValue={renderAgent}
      renderOption={(option) => renderAgent(option)}
    />
  );
}
