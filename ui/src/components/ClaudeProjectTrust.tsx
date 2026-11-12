import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import type { ProjectWorkspace } from "@paperclipai/shared";
import { describeError } from "../api/errors";
import { QueryErrorState, useQueryView } from "./QueryView";

type ClaudeProjectTrustProps = {
  companyId: string; projectId: string; workspace: ProjectWorkspace; disabled: boolean; onSaved: () => void;
};

export function ClaudeProjectTrust(props: ClaudeProjectTrustProps) {
  const { workspace } = props;
  const sourceRevision = JSON.stringify([props.companyId, props.projectId, workspace.id, workspace.updatedAt,
    workspace.sourceType, workspace.cwd, workspace.repoUrl, workspace.repoRef, workspace.defaultRef,
    workspace.remoteProvider, workspace.remoteWorkspaceRef]);
  return <ClaudeProjectTrustForm key={sourceRevision} {...props} sourceRevision={sourceRevision} />;
}

function ClaudeProjectTrustForm({ companyId, projectId, workspace, disabled, onSaved, sourceRevision }: ClaudeProjectTrustProps & {
  sourceRevision: string;
}) {
  const workspaceId = workspace.id;
  const queryClient = useQueryClient();
  const key = ["claude-project-trust", companyId, projectId, workspaceId, sourceRevision];
  const trust = useQuery({ queryKey: key, queryFn: () => projectsApi.getClaudeProjectTrust(projectId, workspaceId, companyId) });
  const agents = useQuery({ queryKey: ["claude-project-trust-agents", companyId], queryFn: () => agentsApi.list(companyId) });
  const trustView = useQueryView(trust);
  const agentsView = useQueryView(agents);
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
    <h2 className="text-lg font-semibold">Trust this workspace for Claude</h2>
    <p className="text-sm text-muted-foreground">Allow selected agents to load this workspace's Claude project settings, including skills, permissions, environment and hooks. Paperclip pins managed connection settings, but hooks can execute commands and access credentials available to the agent. Grant trust only when you trust the workspace contents and the agent. Changing the workspace source removes this trust.</p>
    <p className="text-sm text-muted-foreground">Applies to managed Claude CLI and Legacy ACP runs using this exact local workspace. Native Runner execution, remote environments, and worktrees are not covered. Changes apply to subsequent runs.</p>
    <p className="text-sm text-muted-foreground">Trust is granted to an agent identity independently of its current harness or pool. It is checked only for supported Claude runs. Profile import and session retention belong in the Claude execution configuration's Advanced settings.</p>
    {trustView.kind === "error" ? <QueryErrorState size="inline" error={trustView.error} onRetry={trustView.retry} /> : null}
    {agentsView.kind === "error" ? <QueryErrorState size="inline" error={agentsView.error} onRetry={agentsView.retry} /> : null}
    {agents.data?.map((agent) =>
      <label className="flex items-center gap-2 text-sm" key={agent.id}>
        <Checkbox disabled={disabled} checked={selected.includes(agent.id)} onCheckedChange={(checked) => setSelected((current) =>
          checked === true ? [...new Set([...current, agent.id])] : current.filter((id) => id !== agent.id))} />
        {agent.name}
      </label>)}
    <Button disabled={disabled || !trust.data || !agents.data || trustView.kind === "error" || agentsView.kind === "error" || save.isPending} onClick={() => save.mutate()}>Save Claude trust</Button>
    {save.error ? <p className="text-sm text-destructive">{describeError(save.error, { action: "save Claude trust" }).body}</p> : null}
    {save.isSuccess ? <p className="text-sm text-muted-foreground">Claude trust settings saved.</p> : null}
  </Card>;
}
