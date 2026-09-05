import type { AgentApiKeyScope } from "@paperclipai/shared";
import { normalizeAgentApiKeyScope } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import type { HttpActor, HttpMembership } from "../http/actor-context.js";

export type AgentJwtClaims = {
  sub: string;
  company_id: string;
  adapter_type: string;
  run_id: string;
  responsible_user_id?: string | null;
  key_scope?: AgentApiKeyScope | null;
  iat: number;
  exp: number;
};

export type AgentApiKeyRecord = {
  id: string;
  agentId: string;
  companyId: string;
  responsibleUserId?: string | null;
  scopeConfig?: unknown;
};

export type AgentRecord = {
  id: string;
  companyId: string;
  status: string;
};

export type AgentAuthDependencies = {
  findApiKey(token: string): Promise<AgentApiKeyRecord | null>;
  touchApiKey(id: string): Promise<void>;
  findAgent(id: string): Promise<AgentRecord | null>;
  verifyJwt(token: string): AgentJwtClaims | null;
  invalidTokenMessage(token: string): string;
  normalizeScope(scope: unknown): AgentApiKeyScope;
  resolveLegacyResponsibleUserId(input: {
    companyId: string;
    agentId: string;
    runId: string;
  }): Promise<string | null>;
  loadResponsibleUserMemberships(input: {
    companyId: string;
    userId: string | null;
  }): Promise<HttpMembership[]>;
  auditRunMismatch(input: {
    companyId: string;
    agentId: string;
    claimRunId: string;
    headerRunId: string;
    method: string;
    url: string;
  }): Promise<void>;
  auditMissingResponsibleUser(input: {
    companyId: string;
    agentId: string;
    keyId: string;
    method: string;
    url: string;
  }): Promise<void>;
};

export type AgentAuthInput = {
  token: string;
  runIdHeader?: string;
  method: string;
  url: string;
};

function normalizeOptionalString(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function invalidAgentStatus(status: string): HttpError | null {
  if (status === "terminated") {
    return new HttpError(401, "Agent is terminated and cannot authenticate");
  }
  if (status === "pending_approval") {
    return new HttpError(401, "Agent is pending approval and cannot authenticate");
  }
  return null;
}

function missingAgentRecord(): HttpError {
  return new HttpError(
    401,
    "Agent record is missing or belongs to another company; obtain fresh credentials and retry",
  );
}

async function buildAgentActor(
  input: {
    source: "agent_key" | "agent_jwt";
    agentId: string;
    companyId: string;
    keyId?: string;
    keyScope: AgentApiKeyScope;
    runId?: string;
    responsibleUserId: string | null;
  },
  dependencies: AgentAuthDependencies,
): Promise<HttpActor> {
  const memberships = await dependencies.loadResponsibleUserMemberships({
    companyId: input.companyId,
    userId: input.responsibleUserId,
  });
  return {
    type: "agent",
    source: input.source,
    agentId: input.agentId,
    companyId: input.companyId,
    keyId: input.keyId,
    keyScope: input.keyScope,
    runId: input.runId,
    onBehalfOfUserId: input.responsibleUserId,
    onBehalfOfMemberships: memberships,
  };
}

/**
 * Framework-neutral agent bearer authentication. Existing cryptographic and DB
 * authorities are injected so the Express and Web Request paths share one
 * implementation instead of drifting. The caller owns bearer classification;
 * this function receives only a credential token.
 */
export async function authenticateAgentBearer(
  input: AgentAuthInput,
  dependencies: AgentAuthDependencies,
): Promise<HttpActor> {
  const apiKey = await dependencies.findApiKey(input.token);
  if (apiKey) {
    const agent = await dependencies.findAgent(apiKey.agentId);
    if (!agent || agent.companyId !== apiKey.companyId) throw missingAgentRecord();
    const statusError = invalidAgentStatus(agent.status);
    if (statusError) throw statusError;

    await dependencies.touchApiKey(apiKey.id);
    const responsibleUserId = normalizeOptionalString(apiKey.responsibleUserId);
    if (!responsibleUserId) {
      await dependencies.auditMissingResponsibleUser({
        companyId: apiKey.companyId,
        agentId: apiKey.agentId,
        keyId: apiKey.id,
        method: input.method,
        url: input.url,
      });
      throw new HttpError(403, "Responsible user is unavailable for this agent key", {
        code: "RESPONSIBLE_USER_UNAVAILABLE",
      });
    }

    return buildAgentActor({
      source: "agent_key",
      agentId: apiKey.agentId,
      companyId: apiKey.companyId,
      keyId: apiKey.id,
      keyScope: dependencies.normalizeScope(apiKey.scopeConfig),
      runId: input.runIdHeader?.trim() || undefined,
      responsibleUserId,
    }, dependencies);
  }

  const claims = dependencies.verifyJwt(input.token);
  if (!claims) {
    throw new HttpError(401, dependencies.invalidTokenMessage(input.token));
  }

  const agent = await dependencies.findAgent(claims.sub);
  if (!agent || agent.companyId !== claims.company_id) throw missingAgentRecord();
  const statusError = invalidAgentStatus(agent.status);
  if (statusError) throw statusError;

  const headerRunId = normalizeOptionalString(input.runIdHeader);
  if (headerRunId && headerRunId !== claims.run_id) {
    await dependencies.auditRunMismatch({
      companyId: claims.company_id,
      agentId: claims.sub,
      claimRunId: claims.run_id,
      headerRunId,
      method: input.method,
      url: input.url,
    });
    throw new HttpError(
      422,
      "X-Paperclip-Run-Id does not match signed agent JWT run_id",
      {
        code: "agent_jwt_run_id_mismatch",
        claimRunId: claims.run_id,
        headerRunId,
      },
    );
  }

  const responsibleUserId = claims.responsible_user_id !== undefined
    ? normalizeOptionalString(claims.responsible_user_id)
    : await dependencies.resolveLegacyResponsibleUserId({
        companyId: claims.company_id,
        agentId: claims.sub,
        runId: claims.run_id,
      });

  return buildAgentActor({
    source: "agent_jwt",
    agentId: claims.sub,
    companyId: claims.company_id,
    keyScope: dependencies.normalizeScope(claims.key_scope),
    runId: claims.run_id,
    responsibleUserId,
  }, dependencies);
}
