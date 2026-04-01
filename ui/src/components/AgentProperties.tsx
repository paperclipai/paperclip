import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { AGENT_ROLE_LABELS, type Agent, type AgentRuntimeState } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { Identity } from "./Identity";
import { formatDate, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";

interface AgentPropertiesProps {
  agent: Agent;
  runtimeState?: AgentRuntimeState;
}

const adapterLabelKeys: Record<string, string> = {
  claude_local: "agents:adapterLabels.claude_local",
  codex_local: "agents:adapterLabels.codex_local",
  gemini_local: "agents:adapterLabels.gemini_local",
  opencode_local: "agents:adapterLabels.opencode_local",
  openclaw_gateway: "agents:adapterLabels.openclaw_gateway",
  cursor: "agents:adapterLabels.cursor",
  process: "agents:adapterLabels.process",
  http: "agents:adapterLabels.http",
};

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
}

export function AgentProperties({ agent, runtimeState }: AgentPropertiesProps) {
  const { t } = useTranslation(["agents", "common"]);
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
        <PropertyRow label={t("common:labels.status")}>
          <StatusBadge status={agent.status} />
        </PropertyRow>
        <PropertyRow label={t("agents:properties.role")}>
          <span className="text-sm">{roleLabels[agent.role] ?? agent.role}</span>
        </PropertyRow>
        {agent.title && (
          <PropertyRow label={t("common:labels.title")}>
            <span className="text-sm">{agent.title}</span>
          </PropertyRow>
        )}
        <PropertyRow label={t("agents:properties.adapter")}>
          <span className="text-sm font-mono">{adapterLabelKeys[agent.adapterType] ? t(adapterLabelKeys[agent.adapterType]) : agent.adapterType}</span>
        </PropertyRow>
      </div>

      <Separator />

      <div className="space-y-1">
        {(runtimeState?.sessionDisplayId ?? runtimeState?.sessionId) && (
          <PropertyRow label={t("agents:properties.session")}>
            <span className="text-xs font-mono">
              {String(runtimeState.sessionDisplayId ?? runtimeState.sessionId).slice(0, 12)}...
            </span>
          </PropertyRow>
        )}
        {runtimeState?.lastError && (
          <PropertyRow label={t("agents:properties.lastError")}>
            <span className="text-xs text-red-600 dark:text-red-400 truncate max-w-[160px]">{runtimeState.lastError}</span>
          </PropertyRow>
        )}
        {agent.lastHeartbeatAt && (
          <PropertyRow label={t("agents:properties.lastHeartbeat")}>
            <span className="text-sm">{formatDate(agent.lastHeartbeatAt)}</span>
          </PropertyRow>
        )}
        {agent.reportsTo && (
          <PropertyRow label={t("agents:properties.reportsTo")}>
            {reportsToAgent ? (
              <Link to={agentUrl(reportsToAgent)} className="hover:underline">
                <Identity name={reportsToAgent.name} size="sm" />
              </Link>
            ) : (
              <span className="text-sm font-mono">{agent.reportsTo.slice(0, 8)}</span>
            )}
          </PropertyRow>
        )}
        <PropertyRow label={t("agents:properties.created")}>
          <span className="text-sm">{formatDate(agent.createdAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
