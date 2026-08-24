import type {
  Company,
  Agent,
  Goal,
  Project,
  Issue,
  CompanyTemplate,
} from "@paperclipai/shared";
import { api } from "./client";

export interface CompanyTemplateDeployRequest {
  /** Override the default company name from the template. */
  name?: string;
  /** Monthly budget in cents. */
  budgetMonthlyCents?: number;
}

export interface CompanyTemplateDeployResponse {
  company: Pick<
    Company,
    "id" | "name" | "issuePrefix" | "description" | "status" | "createdAt"
  >;
  agents: Array<Pick<Agent, "id" | "name" | "role" | "title" | "status" | "urlKey">>;
  goal: Pick<Goal, "id" | "title" | "description" | "level" | "status"> | null;
  project: Pick<Project, "id" | "name" | "status"> | null;
  issue: {
    id: string;
    title: string;
    status: string;
    assigneeAgentId: string | null;
  } | null;
  warnings: string[];
}

export type CompanyTemplateListItem = Omit<
  CompanyTemplate,
  "agents" | "skills" | "goal" | "project" | "starterIssue"
>;

export const companyTemplatesApi = {
  /** List all available templates (metadata only). */
  list: () =>
    api.get<CompanyTemplateListItem[]>("/company-templates"),

  /** Get a single template by key, including full agent/goal/project data. */
  get: (key: string) =>
    api.get<CompanyTemplate>(`/company-templates/${encodeURIComponent(key)}`),

  /** Deploy a template: creates a new company with agents, skills, etc. */
  deploy: (key: string, data?: CompanyTemplateDeployRequest) =>
    api.post<CompanyTemplateDeployResponse>(
      `/company-templates/${encodeURIComponent(key)}/deploy`,
      data ?? {},
    ),
};