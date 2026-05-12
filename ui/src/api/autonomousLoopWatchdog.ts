import { api } from "./client";

export type AutonomousLoopWatchdogCandidate = {
  id: string;
  kind: string;
  severity: "low" | "medium" | "high" | "critical" | string;
  owner: "operator" | "user" | "none" | string;
  issueId: string;
  identifier: string | null;
  title: string | null;
  status: string | null;
  reason: string;
  recoveryAction: string | null;
  recommendedAction: string;
  userVisible: boolean;
  generatedAt: string;
};

export type AutonomousLoopWatchdogPreview = {
  companyId: string;
  mode: "preview" | string;
  readOnly: boolean;
  generatedAt: string;
  totalIssuesScanned: number;
  candidates: AutonomousLoopWatchdogCandidate[];
};

export const autonomousLoopWatchdogApi = {
  preview: (companyId: string, options: { limit?: number } = {}) => {
    const limit = options.limit ?? 25;
    return api.get<AutonomousLoopWatchdogPreview>(
      `/companies/${companyId}/autonomous-loop-watchdog/preview?limit=${limit}`,
    );
  },
};
