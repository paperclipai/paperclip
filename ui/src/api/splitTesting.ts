import type { SplitTestRun } from "@paperclipai/shared";
import { api } from "./client";

export const splitTestingApi = {
  shadowRuns: (runId: string) =>
    api.get<SplitTestRun[]>(`/heartbeat-runs/${runId}/shadow-runs`),

  analyze: (runId: string, judgeModel: string) =>
    api.post<{ status: string }>(`/heartbeat-runs/${runId}/analyze`, { judgeModel }),
};
