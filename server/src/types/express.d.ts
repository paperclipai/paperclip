export {};

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        isInstanceAdmin?: boolean;
        keyId?: string;
        runId?: string;
        source?: "local_implicit" | "session" | "agent_key" | "agent_jwt" | "agent_dpop" | "none";
        // AllCare: Agent Identity extensions
        scopes?: string[];
        dpopJkt?: string;
      };
    }
  }
}
