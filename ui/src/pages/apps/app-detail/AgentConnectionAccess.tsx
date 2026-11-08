import { useTranslation } from "@/i18n";
import { useState } from "react";
import type { Agent, ToolCatalogEntry, ToolPolicy, ToolProfileConfiguration } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { describeError } from "@/api/errors";

export function AgentConnectionAccess({ connectionId, profiles, policies, catalog, agents, canManage, onRemove }: {
  connectionId: string;
  profiles: ToolProfileConfiguration[];
  policies: ToolPolicy[];
  catalog: ToolCatalogEntry[];
  agents: Agent[];
  canManage: boolean;
  onRemove: (profileId: string) => Promise<unknown>;
}) {
  const { t } = useTranslation("connections");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grants = profiles.filter(profile => {
    const agentId = profile.metadata?.agentId;
    return profile.status === "active"
      && profile.metadata?.source === "connection_intent"
      && profile.metadata.connectionId === connectionId
      && typeof agentId === "string"
      && profile.profileKey === `connection-intent:${connectionId}:${agentId}`
      && profile.bindings.some(binding => binding.targetType === "agent" && binding.targetId === agentId);
  });
  if (grants.length === 0) return null;

  async function remove(profileId: string) {
    setPending(profileId);
    setError(null);
    try {
      await onRemove(profileId);
    } catch (cause) {
      setError(describeError(cause).body);
    } finally {
      setPending(null);
    }
  }

  return <section className="space-y-4 border-t border-border pt-8">
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">{t("additional_agent_access_ef797b6")}</h2>
      <p className="text-sm text-muted-foreground">{t("these_agents_can_use_the_listed_actions_60cd2a1")}</p>
    </div>
    {grants.map(profile => {
      const agentId = profile.metadata!.agentId as string;
      const agent = agents.find(candidate => candidate.id === agentId);
      const tools = catalog.filter(tool => profile.entries.some(entry => entry.effect === "include" && entry.catalogEntryId === tool.id));
      return <div key={profile.id} className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AgentAvatar agent={agent ?? { id: agentId, name: "Agent" }} size={32} />
            <span className="text-sm font-medium">{agent?.name ?? t("agent_5ce2e6f")}</span>
          </div>
          {canManage && <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void remove(profile.id)}>
            {pending === profile.id ? t("removing_579d7e7") : t("remove_grant_af3be1b")}
          </Button>}
        </div>
        <ul className="space-y-2">
          {tools.map(tool => {
            const askFirst = policies.some(policy => policy.enabled && policy.policyType === "require_approval"
              && policy.config?.source === "connection_intent"
              && policy.config.connectionId === connectionId && policy.config.agentId === agentId
              && policy.selectors?.catalogEntryId === tool.id);
            return <li key={tool.id} className="flex items-center justify-between gap-4 text-sm">
              <span className="min-w-0 break-all">{tool.title || tool.toolName}</span>
              <span className="shrink-0 text-muted-foreground">{askFirst ? t("ask_first_1aeb84d") : t("allowed_77c7b49")}</span>
            </li>;
          })}
        </ul>
      </div>;
    })}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
