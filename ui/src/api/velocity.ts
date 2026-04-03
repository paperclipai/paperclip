import { api } from "./client";

export interface VelocityWeek {
  weekStart: string;
  weekEnd: string;
  issuesCompleted: number;
  issuesCancelled: number;
  issuesCreated: number;
}

export const velocityApi = {
  get: (companyId: string, weeks = 12) =>
    api.get<VelocityWeek[]>(
      `/companies/${companyId}/velocity?weeks=${encodeURIComponent(weeks)}`,
    ),
};
