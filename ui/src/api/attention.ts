import type { AttentionFeed } from "@paperclipai/shared";
import { api } from "./client";

export const attentionApi = {
  /**
   * Fetch the ranked Decisions attention feed for a company. The server
   * unions every attention source (approvals, interactions, recovery, reviews,
   * failures, budget…) into one ranked queue with the §0 contract.
   */
  list: (companyId: string, options: { includeDismissed?: boolean } = {}) =>
    api.get<AttentionFeed>(
      `/companies/${companyId}/attention${options.includeDismissed ? "?includeDismissed=true" : ""}`,
    ),
};
