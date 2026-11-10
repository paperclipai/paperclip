import type { ReactNode } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The sign-in computer is independent of the account's ownership and grants. */
export function AgentLoginTarget({ companyId, environmentId, agentId, children }: {
  companyId: string; environmentId: string; agentId?: string;
  children: (targetAgentId: string) => ReactNode;
}) {
  const [selected, setSelected] = useState("");
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId), enabled: !agentId });
  const settings = useQuery({ queryKey: queryKeys.instance.settings, queryFn: instanceSettingsApi.get, enabled: !agentId });
  const views = [useQueryView(agents), useQueryView(settings)];
  if (agentId) return children(agentId);
  if (views.some(view => view.kind === "loading" || view.kind === "reconnecting")) return <p role="status" className="text-sm text-muted-foreground">Finding sign-in computers…</p>;
  const error = views.find(view => view.kind === "error");
  if (error) return <QueryErrorState size="inline" error={error.error} action="load sign-in computers" onRetry={error.retry} retrying={error.isFetching} />;
  if (!agents.data || !settings.data) return null;
  const eligible = agents.data.filter(agent => agent.adapterType === "paperclip_runner" &&
    (agent.lifecycleState === "ready" || agent.lifecycleState === "verifying") &&
    (agent.defaultEnvironmentId ?? settings.data.defaultEnvironmentId) === environmentId);
  const target = eligible.find(agent => agent.id === selected);
  return <div className="space-y-4">
    <Select value={target?.id ?? ""} onValueChange={setSelected}>
      <SelectTrigger aria-label="Sign-in computer"><SelectValue placeholder="Choose a sign-in computer" /></SelectTrigger>
      <SelectContent>{eligible.map(agent => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}</SelectContent>
    </Select>
    {!eligible.length && <p className="text-sm text-muted-foreground">An agent computer must finish setup before you can sign in.</p>}
    {target && children(target.id)}
  </div>;
}
