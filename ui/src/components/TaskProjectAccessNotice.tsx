import { useQuery } from "@tanstack/react-query";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useNavigate } from "../lib/router";
import { queryKeys } from "../lib/queryKeys";
import { ProjectAccessNotice } from "./ProjectAccessNotice";

export function TaskProjectAccessNotice({ access, issueId, agentName, projectName, ...props }: {
  access: NonNullable<TaskInterruptionPresentation["projectAccess"]>;
  issueId?: string;
  agentName?: string;
  projectName?: string;
  canRetry: boolean;
  onRetry: () => void;
  error?: Error | null;
  className?: string;
}) {
  const navigate = useNavigate();
  const permission = useQuery({ queryKey: queryKeys.agents.projectAccess(access.agentId), queryFn: () => agentsApi.projectAccess(access.agentId) });
  return <ProjectAccessNotice {...props} agentName={agentName} projectName={access.projectId ? projectName : undefined}
    ready={access.ready} canManage={permission.data?.canManage === true}
    onManage={() => navigate(`/agents/${access.agentId}/permissions${issueId ? `?fromTask=${encodeURIComponent(issueId)}` : ""}`)} />;
}
