import type { RequestHandler } from "express";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";

export interface RunJwtClaim {
  runId: string;
  companyId: string;
  connectionIds: string[];
}

declare global {
  namespace Express {
    interface Request {
      runJwt?: RunJwtClaim;
    }
  }
}

export function runJwtMiddleware(): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return next();
    const claims = verifyLocalAgentJwt(header.slice(7));
    if (claims?.oauth?.connectionIds) {
      req.runJwt = {
        runId: claims.run_id,
        companyId: claims.company_id,
        connectionIds: claims.oauth.connectionIds,
      };
    }
    next();
  };
}
