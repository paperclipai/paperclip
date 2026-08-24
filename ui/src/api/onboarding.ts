import type { Company, Agent, Goal, Project, Issue } from "@paperclipai/shared";
import { api } from "./client";

export interface OnboardingStartRequest {
  company: {
    name: string;
    industry?: string | null;
    budgetMonthlyCents?: number;
  };
  agents?: Array<{
    role: string;
    name?: string;
    adapterType?: string;
    adapterConfig?: Record<string, unknown>;
  }>;
}

export interface OnboardingStartResponse {
  company: Pick<Company, "id" | "name" | "issuePrefix" | "description" | "budgetMonthlyCents" | "status" | "createdAt">;
  agents: Array<Pick<Agent, "id" | "name" | "role" | "title" | "icon" | "status" | "adapterType" | "urlKey">>;
  goal: Pick<Goal, "id" | "title" | "description" | "level" | "status">;
  project: Pick<Project, "id" | "name" | "status"> | null;
  issue: {
    id: string;
    identifier: string;
    title: string;
    status: string;
    assigneeAgentId: string | null;
  } | null;
}

export const onboardingApi = {
  /**
   * Start the self-service onboarding flow.
   * Creates a company, hires default agents, and seeds a working board.
   */
  start: (data: OnboardingStartRequest) =>
    api.post<OnboardingStartResponse>("/onboarding/start", data),
};
