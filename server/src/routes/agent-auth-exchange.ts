import type { BootstrapTokensService } from "../services/bootstrap-tokens.js";
import type { RunJwtService } from "../services/run-jwt.js";

export interface AgentAuthExchangeDeps {
  bootstrapTokens: BootstrapTokensService;
  runJwt: RunJwtService;
  runJwtTtlSeconds: number;
}

export interface ExchangeResponse {
  status: number;
  body: Record<string, unknown>;
}

export function createAgentAuthExchangeRoute(deps: AgentAuthExchangeDeps) {
  return async (body: { bootstrapToken?: string }): Promise<ExchangeResponse> => {
    if (!body || typeof body.bootstrapToken !== "string") {
      return { status: 400, body: { error: "missing_token" } };
    }
    const v = await deps.bootstrapTokens.validateAndConsume(body.bootstrapToken);
    if (!v.ok) {
      const errorCode =
        v.reason === "already_consumed" ? "token_already_consumed" :
        v.reason === "expired"          ? "token_expired"          : "invalid_token";
      return { status: 400, body: { error: errorCode } };
    }
    const runJwt = deps.runJwt.mint({
      runId: v.binding.runId,
      agentId: v.binding.agentId,
      companyId: v.binding.companyId,
      jobUid: v.binding.jobUid,
      ttlSeconds: deps.runJwtTtlSeconds,
    });
    const expiresAt = new Date(Date.now() + deps.runJwtTtlSeconds * 1000).toISOString();
    return { status: 200, body: { runJwt, expiresAt } };
  };
}
