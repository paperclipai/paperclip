import { api } from "./client";

export interface BrabrixProjectContextPreview {
  projectId: string;
  name: string;
  description?: string | null;
}

export interface BrabrixTaskPreview {
  taskId: string;
  title: string;
  description?: string | null;
  priority?: "low" | "medium" | "high" | "critical" | null;
}

export interface BrabrixGoalPreview {
  source: "brabrix";
  sourceTaskId: string;
  sourceProjectId: string | null;
  title: string;
  description: string | null;
  level: "task";
  status: "planned";
  agentProfile: "backend" | "frontend" | "qa";
  metadata?: Record<string, unknown>;
}

export interface BrabrixContextPreview {
  profile: {
    key: "backend" | "frontend" | "qa";
    role: string;
    objective: string;
    allowedTools: string[];
    preferredModel: string;
  };
  sections: Array<{
    key: string;
    title: string;
    content: string;
    estimatedChars: number;
  }>;
  skillsApplied: string[];
  estimatedChars: number;
  estimatedTokens: number;
}

export interface BrabrixSyncNextTaskResponse {
  projectContext: BrabrixProjectContextPreview | null;
  task: BrabrixTaskPreview | null;
  goal: BrabrixGoalPreview | null;
  context: BrabrixContextPreview | null;
}

export const brabrixApi = {
  syncNextTask: (companyId: string) =>
    api.post<BrabrixSyncNextTaskResponse>(`/companies/${companyId}/brabrix/sync-next-task`, {}),
};
