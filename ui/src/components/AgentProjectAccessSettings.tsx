import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isUuidLike } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { Link, useSearchParams } from "../lib/router";
import { AllowedProjectsEditor } from "./AllowedProjectsEditor";
import { Button } from "./ui/button";

export function AgentProjectAccessSettings({ agent }: { agent: { id: string; companyId: string; name: string; urlKey?: string } }) {
  const client = useQueryClient();
  const [params] = useSearchParams();
  const fromTask = params.get("fromTask");
  const access = useQuery({ queryKey: queryKeys.agents.projectAccess(agent.id), queryFn: () => agentsApi.projectAccess(agent.id) });
  const projects = useQuery({ queryKey: queryKeys.projects.list(agent.companyId), queryFn: () => projectsApi.list(agent.companyId) });
  if (access.error || projects.error) return <div role="alert" className="space-y-2 text-sm">
    <p>Couldn’t load project access.</p><Button variant="outline" size="sm" onClick={() => { void access.refetch(); void projects.refetch(); }}>Try again</Button>
  </div>;
  if (!access.data || !projects.data) return <p role="status" className="text-sm text-muted-foreground">Loading project access…</p>;
  return <div className="space-y-4">
    <AllowedProjectsEditor key={agent.id} agentName={agent.name} projects={projects.data} projectIds={access.data.projectIds} canManage={access.data.canManage}
      onSave={async projectIds => {
        const saved = await agentsApi.addProjectAccess(agent.id, projectIds);
        client.setQueryData(queryKeys.agents.projectAccess(agent.id), saved);
        await Promise.all([
          client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
          ...(agent.urlKey ? [client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) })] : []),
          client.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) }),
          client.invalidateQueries({ queryKey: ["issues"] }),
        ]);
      }} />
    {fromTask && isUuidLike(fromTask) && <Button variant="outline" size="sm" asChild><Link to={`/issues/${fromTask}`}>Return to task</Link></Button>}
  </div>;
}
