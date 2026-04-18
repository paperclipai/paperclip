import { tauriInvoke } from "./tauri-client";

export interface Routine {
  id: string;
  company_id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  assignee_agent_id: string | null;
  priority: string;
  status: string;
  concurrency_policy: string;
  catch_up_policy: string;
  variables: string;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoutineRun {
  id: string;
  routine_id: string;
  source: string;
  status: string;
  triggered_at: string;
  linked_issue_id: string | null;
  failure_reason: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Workflow {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  status: string;
  graph: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  status: string;
  current_node_id: string | null;
  state: string;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export const routinesApi = {
  list: (companyId: string) => tauriInvoke<Routine[]>("list_routines", { companyId }),
  get: (id: string) => tauriInvoke<Routine>("get_routine", { id }),
  create: (companyId: string, data: { title: string; description?: string; assignee_agent_id?: string }) =>
    tauriInvoke<Routine>("create_routine", { companyId, data }),
  update: (id: string, title?: string, status?: string) =>
    tauriInvoke<Routine>("update_routine", { id, title, status }),
  delete: (id: string) => tauriInvoke<void>("delete_routine", { id }),
  listRuns: (routineId: string) => tauriInvoke<RoutineRun[]>("list_routine_runs", { routineId }),
  trigger: (companyId: string, routineId: string) =>
    tauriInvoke<RoutineRun>("trigger_routine", { companyId, routineId }),
};

export const workflowsApi = {
  list: (companyId: string) => tauriInvoke<Workflow[]>("list_workflows", { companyId }),
  get: (id: string) => tauriInvoke<Workflow>("get_workflow", { id }),
  create: (companyId: string, data: { name: string; description?: string; graph?: string }) =>
    tauriInvoke<Workflow>("create_workflow", { companyId, data }),
  update: (id: string, name?: string, graph?: string, status?: string) =>
    tauriInvoke<Workflow>("update_workflow", { id, name, graph, status }),
  delete: (id: string) => tauriInvoke<void>("delete_workflow", { id }),
  run: (companyId: string, workflowId: string) =>
    tauriInvoke<WorkflowRun>("run_workflow", { companyId, workflowId }),
  getRun: (id: string) => tauriInvoke<WorkflowRun>("get_workflow_run", { id }),
};
