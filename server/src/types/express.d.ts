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
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "none";
      };
    }
    interface Response {
      /** Error context attached by the error handler for structured logging. */
      __errorContext?: {
        error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
        method: string;
        url: string;
        reqBody?: unknown;
        reqParams?: unknown;
        reqQuery?: unknown;
      };
      /** Raw error object attached by the error handler for pino-http access. */
      err?: Error;
    }
  }
}
