import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Copy } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent, type AgentRuntimeState } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "../lib/clipboard";
import { AgentStatusBadge } from "./StatusBadge";
import { Identity } from "./Identity";
import { formatDate, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";

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
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToastActions();
  const lastErrorIsActive = agent.status === "error";

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!agent.reportsTo,
  });

  const reportsToAgent = agent.reportsTo ? agents?.find((a) => a.id === agent.reportsTo) : null;

  const copyErrorReason = async (text: string) => {
    try {
      await copyTextToClipboard(text);
      pushToast({ title: "Error reason copied", tone: "success" });
    } catch {
      pushToast({ title: "Could not copy error reason", tone: "error" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          <AgentStatusBadge status={agent.status} />
        </PropertyRow>
        {agent.errorReason && (
          <PropertyRow label={lastErrorIsActive ? "Error reason" : "Residual error reason"}>
            <span className="text-xs text-red-600 dark:text-red-400 break-words min-w-0">
              {agent.errorReason}
            </span>
            <button
              type="button"
              onClick={() => void copyErrorReason(agent.errorReason!)}
              className="ml-1 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Copy error reason"
            >
              <Copy className="h-3 w-3" />
            </button>
          </PropertyRow>
        )}
        <PropertyRow label="Role">
          <span className="text-sm">{roleLabels[agent.role] ?? agent.role}</span>
        </PropertyRow>
        {agent.title && (
          <PropertyRow label="Title">
            <span className="text-sm">{agent.title}</span>
          </PropertyRow>
        )}
        <PropertyRow label="Adapter">
          <span className="text-sm font-mono">{getAdapterLabel(agent.adapterType)}</span>
        </PropertyRow>
      </div>

      <Separator />

      <div className="space-y-1">
        {(runtimeState?.sessionDisplayId ?? runtimeState?.sessionId) && (
          <PropertyRow label="Session">
            <span className="text-xs font-mono">
              {String(runtimeState.sessionDisplayId ?? runtimeState.sessionId).slice(0, 12)}...
            </span>
          </PropertyRow>
        )}
        {runtimeState?.lastError && (
          <PropertyRow label={lastErrorIsActive ? "Last error" : "Last run error"}>
            <span
              className={
                lastErrorIsActive
                  ? "text-xs text-red-600 dark:text-red-400 break-words min-w-0"
                  : "text-xs text-muted-foreground break-words min-w-0"
              }
            >
              {runtimeState.lastError}
            </span>
          </PropertyRow>
        )}
        {agent.lastHeartbeatAt && (
          <PropertyRow label="Last Heartbeat">
            <span className="text-sm">{formatDate(agent.lastHeartbeatAt)}</span>
          </PropertyRow>
        )}
        {agent.reportsTo && (
          <PropertyRow label="Reports To">
            {reportsToAgent ? (
              <Link to={agentUrl(reportsToAgent)} className="hover:underline">
                <Identity name={reportsToAgent.name} size="sm" />
              </Link>
            ) : (
              <span className="text-sm font-mono">{agent.reportsTo.slice(0, 8)}</span>
            )}
          </PropertyRow>
        )}
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(agent.createdAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
