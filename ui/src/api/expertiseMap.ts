import { api } from "./client";

export interface AgentSkillEntry {
  labelId: string;
  labelName: string;
  labelColor: string;
  completed: number;
  total: number;
  blocked: number;
  completionRate: number;
  avgCompletionHours: number;
  effectivenessScore: number;
}

export interface AgentExpertiseProfile {
  agentId: string;
  agentName: string;
  agentRole: string;
  topSkills: AgentSkillEntry[];
  skillGaps: AgentSkillEntry[];
}

export interface ExpertiseMapResult {
  agents: AgentExpertiseProfile[];
}

export interface AssigneeSuggestion {
  agentId: string | null;
  agentName: string | null;
  score: number;
}

export const expertiseMapApi = {
  skills: (companyId: string) =>
    api.get<ExpertiseMapResult>(
      `/companies/${encodeURIComponent(companyId)}/expertise-map/skills`,
    ),

  suggest: (companyId: string, labels: string[]) =>
    api.get<AssigneeSuggestion>(
      `/companies/${encodeURIComponent(companyId)}/expertise-map/suggest?labels=${labels.map(encodeURIComponent).join(",")}`,
    ),
};
