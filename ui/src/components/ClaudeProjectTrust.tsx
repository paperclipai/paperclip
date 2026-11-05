import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import type { ProjectWorkspace } from "@paperclipai/shared";

export function ClaudeProjectTrust({ companyId, projectId, workspace, disabled, onSaved }: {
  companyId: string; projectId: string; workspace: ProjectWorkspace; disabled: boolean; onSaved: () => void;
}) {
  const workspaceId = workspace.id;
  const queryClient = useQueryClient();
  const key = ["claude-project-trust", companyId, projectId, workspaceId];
  const trust = useQuery({ queryKey: key, queryFn: () => projectsApi.getClaudeProjectTrust(projectId, workspaceId, companyId) });
  const agents = useQuery({ queryKey: ["claude-project-trust-agents", companyId], queryFn: () => agentsApi.list(companyId) });
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { if (trust.data) setSelected(trust.data.agentIds); }, [trust.data]);
  const save = useMutation({
    mutationFn: () => projectsApi.setClaudeProjectTrust(projectId, workspaceId, selected, new Date(workspace.updatedAt).toISOString(), {
      sourceType: workspace.sourceType, cwd: workspace.cwd, repoUrl: workspace.repoUrl, repoRef: workspace.repoRef,
      defaultRef: workspace.defaultRef, remoteProvider: workspace.remoteProvider, remoteWorkspaceRef: workspace.remoteWorkspaceRef,
    }, companyId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: key }); onSaved(); },
  });
  return <Card className="block space-y-3 p-5">
    <h2 className="text-lg font-semibold">Claude project settings</h2>
    <p className="text-sm text-muted-foreground">Allow selected agents to load this workspace's Claude project settings, including skills and hooks. Hooks can execute commands with the agent's access. Changing the workspace source removes this trust.</p>
    <p className="text-sm text-muted-foreground">Applies to managed Claude CLI and legacy ACP runs using this exact local workspace. Remote environments, Runner, and worktrees are not covered. Changes apply to subsequent runs.</p>
    {trust.isError || agents.isError ? <p className="text-sm text-destructive">Could not load Claude trust settings or agents.</p> : null}
    {agents.data?.filter((agent) => agent.adapterType === "claude_local").map((agent) =>
      <label className="flex items-center gap-2 text-sm" key={agent.id}>
        <Checkbox disabled={disabled} checked={selected.includes(agent.id)} onCheckedChange={(checked) => setSelected((current) =>
          checked === true ? [...new Set([...current, agent.id])] : current.filter((id) => id !== agent.id))} />
        {agent.name}
      </label>)}
    <Button disabled={disabled || trust.isLoading || agents.isLoading || trust.isError || agents.isError || save.isPending} onClick={() => save.mutate()}>Save Claude trust</Button>
    {save.isError ? <p className="text-sm text-destructive">{save.error instanceof Error ? save.error.message : "Could not save Claude trust settings."}</p> : null}
    {save.isSuccess ? <p className="text-sm text-muted-foreground">Claude trust settings saved.</p> : null}
  </Card>;
}
