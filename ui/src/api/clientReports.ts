import { api } from "./client";

export interface ClientReportMilestone {
  id: string;
  title: string;
  completedAt: string | null;
}

export interface ClientReportDeliverable {
  id: string;
  title: string;
  status: string;
  completedAt: string | null;
}

export interface ClientReportNextStep {
  id: string;
  title: string;
  priority: string;
  status: string;
}

export interface ClientReport {
  projectName: string;
  projectDescription: string | null;
  projectStatus: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  milestones: ClientReportMilestone[];
  deliverables: ClientReportDeliverable[];
  nextSteps: ClientReportNextStep[];
  totalCompleted: number;
  totalInProgress: number;
  totalPlanned: number;
  markdown: string;
}

export const clientReportsApi = {
  generate: (companyId: string, projectId: string, periodDays = 30) =>
    api.get<ClientReport>(
      `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/client-report?periodDays=${periodDays}`,
    ),
};
