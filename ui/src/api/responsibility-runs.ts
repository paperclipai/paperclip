import type { ResponsibilityRecentRuns } from "@paperclipai/shared";
import { api } from "./client";

/** The recent agent runs on the work under a responsibility (experimental `enableResponsibilities`). */
export const responsibilityRunsApi = {
  recent: (responsibilityId: string, limit?: number) =>
    api.get<ResponsibilityRecentRuns>(
      `/responsibilities/${encodeURIComponent(responsibilityId)}/runs${limit ? `?limit=${limit}` : ""}`,
    ),
};
