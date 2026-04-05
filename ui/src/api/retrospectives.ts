import { api } from "./client";

export interface RetroSection {
  title: string;
  items: string[];
}

export interface RetrospectiveResult {
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  sections: {
    whatWorked: RetroSection;
    whatDidntWork: RetroSection;
    actionItems: RetroSection;
  };
  actionItemIssueIds: string[];
  knowledgePageId: string | null;
  markdown: string;
}

export interface LatestRetrospective {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export const retrospectivesApi = {
  generate: (companyId: string, periodDays = 14) =>
    api.post<RetrospectiveResult>(
      `/companies/${encodeURIComponent(companyId)}/retrospectives/generate`,
      { periodDays },
    ),

  latest: (companyId: string) =>
    api.get<LatestRetrospective | null>(
      `/companies/${encodeURIComponent(companyId)}/retrospectives/latest`,
    ),
};
