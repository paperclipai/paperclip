import { api } from "./client";

export interface BugReportPayload {
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  pageUrl: string;
  userAgent: string;
}

export interface BugReportResult {
  success: boolean;
  issueIdentifier: string | null;
  issueUrl: string | null;
}

export const bugReportsApi = {
  submit: (data: BugReportPayload) =>
    api.post<BugReportResult>("/bug-reports", data),
};
