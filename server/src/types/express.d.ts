export {};

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
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        keyId?: string;
        runId?: string;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant" | "none";
        /**
         * For agent actors acting on behalf of a human user (e.g. chat-style
         * plugins minting an agent JWT with a `requested_by_user_id` claim),
         * this carries that user identity. Consumers use it to attribute
         * agent-created resources back to the human who triggered the work
         * (see `routes/issues.ts` `requestedByUserId` auto-set chain).
         */
        actingOnBehalfOfUserId?: string;
      };
    }
  }
}
