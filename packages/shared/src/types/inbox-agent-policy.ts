export const INBOX_AGENT_POLICY_MODES = ["open", "allowlist", "disabled"] as const;

export type InboxAgentPolicyMode = (typeof INBOX_AGENT_POLICY_MODES)[number];

export interface InboxAgentPolicy {
  companyId: string;
  userId: string;
  mode: InboxAgentPolicyMode;
  allowedAgentIds: string[];
  materialized: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}
