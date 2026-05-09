export {};

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "operator" | "agent" | "none";
        userId?: string;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        isInstanceAdmin?: boolean;
        keyId?: string;
        runId?: string;
        source?: "local_implicit" | "session" | "operator_key" | "agent_key" | "agent_jwt" | "none";
      };
    }
  }
}
