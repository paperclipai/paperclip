import { api } from "./client";

export interface Playbook {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  body: string | null;
  icon: string | null;
  category: string;
  isSeeded: boolean;
  status: string;
  estimatedMinutes: number | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookStep {
  id: string;
  playbookId: string;
  stepOrder: number;
  title: string;
  instructions: string | null;
  assigneeRole: string | null;
  assigneeAgentId: string | null;
  dependsOn: number[];
  estimatedMinutes: number | null;
  requiresApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookWithSteps extends Playbook {
  steps: PlaybookStep[];
}

export interface PlaybookRun {
  id: string;
  companyId: string;
  playbookId: string;
  goalId: string | null;
  status: string;
  totalSteps: number;
  completedSteps: number;
  triggeredBy: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

export interface PlaybookRunStep {
  id: string;
  runId: string;
  stepOrder: number;
  title: string;
  issueId: string | null;
  assignedAgentId: string | null;
  status: string;
  dependsOn: number[];
  completedAt: string | null;
}

export interface PlaybookRunWithSteps extends PlaybookRun {
  steps: PlaybookRunStep[];
}

export interface RunPlaybookResult {
  run: PlaybookRun;
  goal: { id: string; title: string };
  stepsCreated: number;
}

export const playbooksApi = {
  list: (companyId: string) =>
    api.get<Playbook[]>(`/companies/${encodeURIComponent(companyId)}/playbooks`),

  detail: (companyId: string, playbookId: string) =>
    api.get<PlaybookWithSteps>(
      `/companies/${encodeURIComponent(companyId)}/playbooks/${encodeURIComponent(playbookId)}`,
    ),

  create: (companyId: string, payload: {
    name: string;
    description?: string;
    body?: string;
    icon?: string;
    category?: string;
    estimatedMinutes?: number;
    steps?: Array<{
      stepOrder: number;
      title: string;
      instructions?: string;
      assigneeRole?: string;
      dependsOn?: number[];
      estimatedMinutes?: number;
      requiresApproval?: boolean;
    }>;
  }) =>
    api.post<Playbook>(
      `/companies/${encodeURIComponent(companyId)}/playbooks`,
      payload,
    ),

  update: (companyId: string, playbookId: string, payload: Partial<Playbook>) =>
    api.patch<Playbook>(
      `/companies/${encodeURIComponent(companyId)}/playbooks/${encodeURIComponent(playbookId)}`,
      payload,
    ),

  delete: (companyId: string, playbookId: string) =>
    api.delete<void>(
      `/companies/${encodeURIComponent(companyId)}/playbooks/${encodeURIComponent(playbookId)}`,
    ),

  seed: (companyId: string) =>
    api.post<{ seeded: boolean; count: number }>(
      `/companies/${encodeURIComponent(companyId)}/playbooks/seed`,
      {},
    ),

  run: (companyId: string, playbookId: string, projectId?: string, name?: string, repoUrl?: string) =>
    api.post<RunPlaybookResult>(
      `/companies/${encodeURIComponent(companyId)}/playbooks/${encodeURIComponent(playbookId)}/run`,
      { projectId, name, repoUrl },
    ),

  listRuns: (companyId: string, playbookId?: string) =>
    api.get<PlaybookRun[]>(
      `/companies/${encodeURIComponent(companyId)}/playbook-runs${playbookId ? `?playbookId=${encodeURIComponent(playbookId)}` : ""}`,
    ),

  getRun: (companyId: string, runId: string) =>
    api.get<PlaybookRunWithSteps>(
      `/companies/${encodeURIComponent(companyId)}/playbook-runs/${encodeURIComponent(runId)}`,
    ),
};
