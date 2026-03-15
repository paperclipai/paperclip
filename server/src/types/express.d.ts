import "express-serve-static-core";

declare module "express-serve-static-core" {
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
      source?:
        | "local_implicit"
        | "session"
        | "agent_key"
        | "agent_jwt"
        | "none";
    };
  }
}
