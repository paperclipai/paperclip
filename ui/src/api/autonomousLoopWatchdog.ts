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
  hasMore: boolean;
  nextCursor: string | null;
  candidates: AutonomousLoopWatchdogCandidate[];
};

export const autonomousLoopWatchdogApi = {
  preview: (companyId: string, options: { limit?: number; cursor?: string | null } = {}) => {
    const params = new URLSearchParams();
    params.set("limit", String(options.limit ?? 25));
    if (options.cursor) params.set("cursor", options.cursor);
    return api.get<AutonomousLoopWatchdogPreview>(
      `/companies/${companyId}/autonomous-loop-watchdog/preview?${params.toString()}`,
    );
  },
};
