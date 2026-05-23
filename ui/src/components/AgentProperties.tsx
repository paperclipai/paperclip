import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { AGENT_ROLE_LABELS, type Agent, type AgentRuntimeState } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { Identity } from "./Identity";
import { formatDate, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import { useTranslation } from "@/i18n";

interface AgentPropertiesProps {
  agent: Agent;
  runtimeState?: AgentRuntimeState;
}

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
    </div>
  );
}

export function AgentProperties({ agent, runtimeState }: AgentPropertiesProps) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!agent.reportsTo,
  });

  const reportsToAgent = agent.reportsTo ? agents?.find((a) => a.id === agent.reportsTo) : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label={t("agentProperties.status", { defaultValue: "Status" })}>
          <StatusBadge status={agent.status} />
        </PropertyRow>
        <PropertyRow label={t("agentProperties.role", { defaultValue: "Role" })}>
          <span className="text-sm">{roleLabels[agent.role] ?? agent.role}</span>
        </PropertyRow>
        {agent.title && (
          <PropertyRow label={t("agentProperties.title", { defaultValue: "Title" })}>
            <span className="text-sm">{agent.title}</span>
          </PropertyRow>
        )}
        <PropertyRow label={t("agentProperties.adapter", { defaultValue: "Adapter" })}>
          <span className="text-sm font-mono">{getAdapterLabel(agent.adapterType)}</span>
        </PropertyRow>
      </div>

      <Separator />

      <div className="space-y-1">
        {(runtimeState?.sessionDisplayId ?? runtimeState?.sessionId) && (
          <PropertyRow label={t("agentProperties.session", { defaultValue: "Session" })}>
            <span className="text-xs font-mono">
              {String(runtimeState.sessionDisplayId ?? runtimeState.sessionId).slice(0, 12)}...
            </span>
          </PropertyRow>
        )}
        {runtimeState?.lastError && (
          <PropertyRow label={t("agentProperties.lastError", { defaultValue: "Last error" })}>
            <span className="text-xs text-red-600 dark:text-red-400 break-words min-w-0">{runtimeState.lastError}</span>
          </PropertyRow>
        )}
        {agent.lastHeartbeatAt && (
          <PropertyRow label={t("agentProperties.lastHeartbeat", { defaultValue: "Last Heartbeat" })}>
            <span className="text-sm">{formatDate(agent.lastHeartbeatAt)}</span>
          </PropertyRow>
        )}
        {agent.reportsTo && (
          <PropertyRow label={t("agentProperties.reportsTo", { defaultValue: "Reports To" })}>
            {reportsToAgent ? (
              <Link to={agentUrl(reportsToAgent)} className="hover:underline">
                <Identity name={reportsToAgent.name} size="sm" />
              </Link>
            ) : (
              <span className="text-sm font-mono">{agent.reportsTo.slice(0, 8)}</span>
            )}
          </PropertyRow>
        )}
        <PropertyRow label={t("agentProperties.created", { defaultValue: "Created" })}>
          <span className="text-sm">{formatDate(agent.createdAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
