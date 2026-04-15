import type { Db } from "@paperclipai/db";
import { boardBriefService } from "./board-brief.js";

export function dashboardService(db: Db) {
  const briefs = boardBriefService(db);

  return {
    summary: async (companyId: string, now: Date = new Date()) => briefs.buildDashboardSummary(companyId, now),
  };
}
