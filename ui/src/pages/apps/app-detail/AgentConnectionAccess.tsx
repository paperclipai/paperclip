import { useMemo, useState } from "react";
import type { Agent, ToolCatalogEntry, ToolPolicy, ToolProfileConfiguration } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { describeError } from "@/api/errors";
import { actionLabel } from "./action-permissions";

export function AgentConnectionAccess({ connectionId, profiles, policies, catalog, agents, canManage, onRemove }: {
  connectionId: string;
  profiles: ToolProfileConfiguration[];
  policies: ToolPolicy[];
  catalog: ToolCatalogEntry[];
  agents: Agent[];
  canManage: boolean;
  onRemove: (profileId: string) => Promise<unknown>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grants = useMemo(() => profiles.filter(profile => {
    const agentId = profile.metadata?.agentId;
    return profile.status === "active"
      && profile.metadata?.source === "connection_intent"
      && profile.metadata.connectionId === connectionId
      && typeof agentId === "string"
      && profile.profileKey === `connection-intent:${connectionId}:${agentId}`
      && profile.bindings.some(binding => binding.targetType === "agent" && binding.targetId === agentId);
  }), [profiles, connectionId]);
  const agentsById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const approvalKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const policy of policies) {
      if (policy.enabled && policy.policyType === "require_approval"
        && policy.config?.source === "connection_intent" && policy.config.connectionId === connectionId) {
        keys.add(`${policy.config.agentId}:${policy.selectors?.catalogEntryId}`);
      }
    }
    return keys;
  }, [policies, connectionId]);
  const toolsByProfileId = useMemo(() => {
    const byId = new Map(catalog.map((tool, index) => [tool.id, { tool, index }]));
    return new Map(grants.map(profile => {
      const ids = new Set(profile.entries.filter(entry => entry.effect === "include").map(entry => entry.catalogEntryId));
      const tools = [...ids].flatMap(id => {
        const entry = id ? byId.get(id) : undefined;
        return entry ? [entry] : [];
      }).sort((a, b) => a.index - b.index).map(entry => entry.tool);
      return [profile.id, tools];
    }));
  }, [grants, catalog]);
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
      <h2 className="text-sm font-semibold">Additional agent access</h2>
      <p className="text-sm text-muted-foreground">These agents can use the listed actions in addition to the permissions above. Removing a grant restores their other permissions.</p>
    </div>
    {grants.map(profile => {
      const agentId = profile.metadata!.agentId as string;
      const agent = agentsById.get(agentId);
      const tools = toolsByProfileId.get(profile.id) ?? [];
      return <div key={profile.id} className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AgentAvatar agent={agent ?? { id: agentId, name: "Agent" }} size={32} />
            <span className="text-sm font-medium">{agent?.name ?? "Agent"}</span>
          </div>
          {canManage && <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void remove(profile.id)}>
            {pending === profile.id ? "Removing…" : "Remove grant"}
          </Button>}
        </div>
        <ul className="space-y-2">
          {tools.map(tool => {
            const askFirst = approvalKeys.has(`${agentId}:${tool.id}`);
            return <li key={tool.id} className="flex items-center justify-between gap-4 text-sm">
              <span className="min-w-0 break-all">{actionLabel(tool)}</span>
              <span className="shrink-0 text-muted-foreground">{askFirst ? "Ask first" : "Allowed"}</span>
            </li>;
          })}
        </ul>
      </div>;
    })}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
