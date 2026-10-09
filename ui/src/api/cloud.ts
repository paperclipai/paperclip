import { api } from "./client";

/**
 * One entry of the Paperclip Cloud stack portfolio, proxied by
 * `GET /api/cloud/stacks`. The payload deliberately carries no icon URL, so
 * stack rows render the same deterministic monogram treatment companies use.
 */
export type CloudStackSummary = {
  displayName: string;
  stackSlug: string;
  primaryHost: string | null;
  lifecycleState: string;
  sleepState: string;
  role: string;
  isCurrent: boolean;
};

export type CloudStackPortfolio = {
  stacks: CloudStackSummary[];
};

export const cloudApi = {
  /** Cloud-managed instances only; self-hosted servers answer 404. */
  listStacks: () => api.get<CloudStackPortfolio>("/cloud/stacks"),
};
