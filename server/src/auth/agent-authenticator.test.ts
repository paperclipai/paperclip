import { describe, expect, it } from "bun:test";
import { HttpError } from "../errors.js";
import type { HttpActor } from "../http/actor-context.js";
import {
  authenticateAgentBearer,
  type AgentAuthDependencies,
  type AgentJwtClaims,
} from "./agent-authenticator.js";

const baseClaims: AgentJwtClaims = {
  sub: "agent-1",
  company_id: "company-a",
  adapter_type: "claude_local",
  run_id: "run-1",
  responsible_user_id: "user-1",
  key_scope: { kind: "standard" },
  iat: 1,
  exp: 2,
};

function makeDependencies(
  overrides: Partial<AgentAuthDependencies> = {},
): AgentAuthDependencies {
  return {
    findApiKey: async () => null,
    touchApiKey: async () => {},
    findAgent: async (id) => ({ id, companyId: "company-a", status: "active" }),
    resolveLegacyResponsibleUserId: async () => null,
    loadResponsibleUserMemberships: async () => [
      { companyId: "company-a", membershipRole: "member", status: "active" },
    ],
    auditRunMismatch: async () => {},
    auditMissingResponsibleUser: async () => {},
    verifyJwt: () => baseClaims,
    invalidTokenMessage: () => "Agent token did not verify; obtain fresh credentials and retry",
    normalizeScope: (scope) => scope ?? { kind: "standard" },
    ...overrides,
  };
}

describe("agent bearer authenticator", () => {
  it("returns a complete agent JWT actor without Express types", async () => {
    const actor = await authenticateAgentBearer({
      token: "jwt-token",
      runIdHeader: "run-1",
      method: "GET",
      url: "/api/issues",
    }, makeDependencies());

    expect(actor).toEqual({
      type: "agent",
      source: "agent_jwt",
      agentId: "agent-1",
      companyId: "company-a",
      keyId: undefined,
      keyScope: { kind: "standard" },
      runId: "run-1",
      onBehalfOfUserId: "user-1",
      onBehalfOfMemberships: [
        { companyId: "company-a", membershipRole: "member", status: "active" },
      ],
    } satisfies HttpActor);
  });

  it("preserves the exact JWT run-id mismatch error and audit callback", async () => {
    let audited: unknown;
    const result = await authenticateAgentBearer({
      token: "jwt-token",
      runIdHeader: "run-2",
      method: "POST",
      url: "/api/issues",
    }, makeDependencies({
      auditRunMismatch: async (input) => {
        audited = input;
      },
    })).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(HttpError);
    expect(result).toMatchObject({
      status: 422,
      message: "X-Paperclip-Run-Id does not match signed agent JWT run_id",
      details: {
        code: "agent_jwt_run_id_mismatch",
        claimRunId: "run-1",
        headerRunId: "run-2",
      },
    });
    expect(audited).toEqual({
      companyId: "company-a",
      agentId: "agent-1",
      claimRunId: "run-1",
      headerRunId: "run-2",
      method: "POST",
      url: "/api/issues",
    });
  });

  it("maps a revoked or missing agent key to the exact invalid-token error", async () => {
    const result = await authenticateAgentBearer({
      token: "invalid-token",
      method: "GET",
      url: "/api/issues",
    }, makeDependencies({ verifyJwt: () => null })).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(HttpError);
    expect(result).toMatchObject({
      status: 401,
      message: "Agent token did not verify; obtain fresh credentials and retry",
    });
  });

  it("does not invent a run id when an agent key request has no run header", async () => {
    const result = await authenticateAgentBearer({
      token: "agent-key",
      method: "GET",
      url: "/actor",
    }, makeDependencies({
      findApiKey: async () => ({
        id: "key-1",
        agentId: "agent-1",
        companyId: "company-a",
        responsibleUserId: "user-2",
        scopeConfig: null,
      }),
    }));

    expect(result.runId).toBeUndefined();
  });

  it("preserves agent-key scope and responsible-user data", async () => {
    let touchedKey: string | undefined;
    const result = await authenticateAgentBearer({
      token: "agent-key",
      runIdHeader: "header-run",
      method: "GET",
      url: "/actor",
    }, makeDependencies({
      findApiKey: async () => ({
        id: "key-1",
        agentId: "agent-1",
        companyId: "company-a",
        responsibleUserId: "user-2",
        scopeConfig: { kind: "skill_test", issueId: "issue-1" },
      }),
      touchApiKey: async (id) => {
        touchedKey = id;
      },
      normalizeScope: (scope) => scope as { kind: "skill_test"; issueId: string },
    }));

    expect(touchedKey).toBe("key-1");
    expect(result).toMatchObject({
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId: "company-a",
      keyId: "key-1",
      keyScope: { kind: "skill_test", issueId: "issue-1" },
      runId: "header-run",
      onBehalfOfUserId: "user-2",
    });
  });

  it("rejects terminated agents before touching an API key", async () => {
    let touched = false;
    const result = await authenticateAgentBearer({
      token: "agent-key",
      method: "GET",
      url: "/api/issues",
    }, makeDependencies({
      findApiKey: async () => ({
        id: "key-1",
        agentId: "agent-1",
        companyId: "company-a",
        responsibleUserId: "user-1",
      }),
      findAgent: async () => ({ id: "agent-1", companyId: "company-a", status: "terminated" }),
      touchApiKey: async () => {
        touched = true;
      },
    })).catch((error: unknown) => error);

    expect(result).toMatchObject({
      status: 401,
      message: "Agent is terminated and cannot authenticate",
    });
    expect(touched).toBe(false);
  });

  it("rejects agents whose credential record crosses company boundaries", async () => {
    const result = await authenticateAgentBearer({
      token: "agent-key",
      method: "GET",
      url: "/api/issues",
    }, makeDependencies({
      findApiKey: async () => ({
        id: "key-1",
        agentId: "agent-1",
        companyId: "company-a",
        responsibleUserId: "user-1",
      }),
      findAgent: async () => ({ id: "agent-1", companyId: "company-b", status: "active" }),
    })).catch((error: unknown) => error);

    expect(result).toMatchObject({
      status: 401,
      message: "Agent record is missing or belongs to another company; obtain fresh credentials and retry",
    });
  });

  it("audits and rejects an agent key without a responsible user", async () => {
    let audited: unknown;
    const result = await authenticateAgentBearer({
      token: "agent-key",
      method: "GET",
      url: "/api/issues",
    }, makeDependencies({
      findApiKey: async () => ({
        id: "key-1",
        agentId: "agent-1",
        companyId: "company-a",
        responsibleUserId: null,
        scopeConfig: null,
      }),
      auditMissingResponsibleUser: async (input) => {
        audited = input;
      },
    })).catch((error: unknown) => error);

    expect(result).toMatchObject({
      status: 403,
      message: "Responsible user is unavailable for this agent key",
      details: { code: "RESPONSIBLE_USER_UNAVAILABLE" },
    });
    expect(audited).toEqual({
      companyId: "company-a",
      agentId: "agent-1",
      keyId: "key-1",
      method: "GET",
      url: "/api/issues",
    });
  });
});
