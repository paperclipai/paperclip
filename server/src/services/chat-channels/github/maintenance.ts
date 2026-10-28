import type { Db } from "@paperclipai/db";
import { githubReviewCheckService } from "../../chat-github-checks.js";

export function createGitHubMaintenance(db: Db, fetchImpl: typeof globalThis.fetch, options: {
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  isShuttingDown: () => boolean;
}) {
  let githubMaintenancePending = false;
  function scheduleGitHubMaintenance() {
    if (githubMaintenancePending || options.isShuttingDown()) return;
    githubMaintenancePending = true;
    options.scheduleMessageProcessing(async () => {
      try {
        // Provider I/O must not block Slack, Teams, or ordinary message receipts.
        await githubReviewCheckService(db, fetchImpl).repairSupersededReviews();
      } finally {
        githubMaintenancePending = false;
      }
    });
  }

  return { scheduleGitHubMaintenance };
}
