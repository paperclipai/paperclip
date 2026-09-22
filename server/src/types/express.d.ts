export {};

import type { AgentApiKeyScope, DeploymentMode } from "@paperclipai/shared";

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
        keyId?: string;
        keyScope?: AgentApiKeyScope;
        runId?: string;
        onBehalfOfUserId?: string | null;
        identityContextId?: string | null;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant" | "cloud_control" | "none";
        /**
         * The deployment this request arrived on, stamped by `actorMiddleware`
         * from its own configuration. It survives the actor replacement that
         * bearer credentials cause, so a route can read a deployment fact
         * without inferring it from `source`, which describes the credential
         * rather than the deployment.
         */
        deploymentMode?: DeploymentMode;
      };
    }
  }
}
