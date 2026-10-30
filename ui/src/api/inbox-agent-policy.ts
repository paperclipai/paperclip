import type { InboxAgentPolicy, UpdateInboxAgentPolicy } from "@paperclipai/shared";
import { api } from "./client";

/**
 * "Let agents tidy my inbox" policy. Backed by per-user endpoints: `open`
 * lets any of my agents archive from my inbox,
 * `allowlist` restricts to the named agents, `disabled` turns it off.
 */
export const inboxAgentPolicyApi = {
  getMine: (companyId: string) =>
    api.get<InboxAgentPolicy>(`/companies/${companyId}/users/me/inbox-agent-policy`),
  updateMine: (companyId: string, input: UpdateInboxAgentPolicy) =>
    api.put<InboxAgentPolicy>(`/companies/${companyId}/users/me/inbox-agent-policy`, input),
};
