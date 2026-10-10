import { describe, expect, it } from "vitest";
import { buildActorSecretContext } from "../routes/authz.js";

function makeReq(actor: Express.Request["actor"]) {
  return { method: "POST", actor } as Express.Request;
}

describe("buildActorSecretContext", () => {
  it("responsibleUserId resolves to req.actor.userId for a user actor", () => {
    const req = makeReq({
      type: "board",
      userId: "user-1",
      source: "session",
    });

    const context = buildActorSecretContext(req, {
      consumerType: "agent",
      consumerId: "agent-1",
    });

    expect(context.responsibleUserId).toBe("user-1");
    expect(context.actorType).toBe("user");
    expect(context.actorId).toBe("user-1");
    expect(context.actorSource).toBe("session");
  });

  it("responsibleUserId falls back to onBehalfOfUserId for an agent actor", () => {
    const req = makeReq({
      type: "agent",
      agentId: "agent-7",
      onBehalfOfUserId: "user-42",
      source: "agent_key",
    });

    const context = buildActorSecretContext(req, {
      consumerType: "agent",
      consumerId: "agent-7",
    });

    expect(context.responsibleUserId).toBe("user-42");
    expect(context.actorType).toBe("agent");
    expect(context.actorId).toBe("agent-7");
    expect(context.actorSource).toBe("agent_key");
  });

  it("prefers userId over onBehalfOfUserId when both are present", () => {
    const req = makeReq({
      type: "board",
      userId: "user-1",
      onBehalfOfUserId: "user-99",
      source: "board_key",
    });

    const context = buildActorSecretContext(req, {
      consumerType: "agent",
      consumerId: "agent-1",
    });

    expect(context.responsibleUserId).toBe("user-1");
  });

  it("responsibleUserId is null when neither userId nor onBehalfOfUserId is present", () => {
    const req = makeReq({
      type: "agent",
      agentId: "agent-3",
      source: "agent_key",
    });

    const context = buildActorSecretContext(req, {
      consumerType: "system",
      consumerId: "adapter_test",
    });

    expect(context.responsibleUserId).toBeNull();
  });

  it("carries the passed consumerType/consumerId params (agent, environment, and system all accepted) and never sets configPath or allowedBindingIds", () => {
    const req = makeReq({
      type: "board",
      userId: "user-1",
      source: "session",
    });

    for (const params of [
      { consumerType: "agent" as const, consumerId: "agent-1" },
      { consumerType: "environment" as const, consumerId: "env-9" },
      { consumerType: "system" as const, consumerId: "adapter_test" },
    ]) {
      const context = buildActorSecretContext(req, params);
      expect(context.consumerType).toBe(params.consumerType);
      expect(context.consumerId).toBe(params.consumerId);
      // Never carries a config path (the resolver injects it) or a binding allowlist.
      expect(context).not.toHaveProperty("configPath");
      expect(context).not.toHaveProperty("allowedBindingIds");
    }
  });
});
