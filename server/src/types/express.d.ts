export {};

import type { AgentApiKeyScope } from "@paperclipai/shared";

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        sessionId?: string | null;
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        onBehalfOfMemberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        canManageExperimentalSettings?: boolean;
        keyId?: string;
        keyScope?: AgentApiKeyScope;
        runId?: string;
        onBehalfOfUserId?: string | null;
        authorizingUserId?: string;
        identityContextId?: string | null;
        /**
         * The accepted execution identity's cause. `company_default` means the
         * responsible user is a company fallback rather than an attribution, so
         * it must not be propagated to anything a later execution will read back
         * as settled human responsibility.
         */
        identityContextCause?: string | null;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "mcp_oauth" | "cloud_tenant" | "cloud_control" | "none";
      };
    }
  }
}
