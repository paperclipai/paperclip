interface ProjectSnapshot {
  id: string;
  companyId: string;
  name: string;
  status: string;
  archivedAt: string | null;
  urlKey?: string | null;
}
interface TaskSnapshot {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  projectId: string | null;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  workMode: string;
  identifier?: string | null;
}
export interface ProjectContextObservation {
  companyId: string;
  userId: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  prompt: string;
  projectBeforeReload: ProjectSnapshot;
  projectAfterReload: ProjectSnapshot;
  taskBeforeReload: TaskSnapshot;
  taskAfterReload: TaskSnapshot;
  projectTasks: TaskSnapshot[];
  runsBeforeReload: unknown[];
  runsAfterReload: unknown[];
}

/** Compare independent saved reads against the submitted UI values, not the POST echo. */
export function projectContextEvidencePasses(observed: ProjectContextObservation): boolean {
  const { companyId, userId, projectId, projectName, taskId, taskTitle, prompt } = observed;
  if (![companyId, userId, projectId, projectName, taskId, taskTitle, prompt].every(value => typeof value === "string" && value.length)) return false;
  const projectMatches = (project: ProjectSnapshot) => project?.id === projectId && project.companyId === companyId
    && project.name === projectName && project.status === "planned" && project.archivedAt === null;
  const taskMatches = (task: TaskSnapshot) => task?.id === taskId && task.companyId === companyId && task.title === taskTitle
    && task.description === prompt && task.projectId === projectId && task.assigneeUserId === userId
    && task.assigneeAgentId === null && task.workMode === "standard";
  return projectMatches(observed.projectBeforeReload) && projectMatches(observed.projectAfterReload)
    && taskMatches(observed.taskBeforeReload) && taskMatches(observed.taskAfterReload)
    && Array.isArray(observed.projectTasks) && observed.projectTasks.length === 1 && taskMatches(observed.projectTasks[0]!)
    && Array.isArray(observed.runsBeforeReload) && observed.runsBeforeReload.length === 0
    && Array.isArray(observed.runsAfterReload) && observed.runsAfterReload.length === 0;
}
