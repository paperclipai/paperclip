import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { assertAgentFixedProcessTarget, assertNoAgentFixedProcessConfiguration } from "../middleware/fixed-process-configuration.js";

const actor = { type: "agent", agentId: "service" } as Request["actor"];
const target = { id: "service", adapterType: "process", adapterConfig: { fixedCommand: true } };
const req = (method: string, path: string, body: unknown = {}) => ({ actor, method, path, body, query: {} });

describe("administrative fixed process configuration", () => {
  it.each([
    { adapterConfig: { fixedCommand: true } },
    { agents: [{ adapterConfig: { watchdogService: { assigneeAgentId: "self" } } }] },
    { adapterConfig: { fixedCommand: false } },
  ])("rejects self-issued service configuration through nested payloads", (body) => {
    expect(() => assertNoAgentFixedProcessConfiguration({ actor, body })).toThrow();
    expect(() => assertNoAgentFixedProcessConfiguration({ actor: { type: "board" } as Request["actor"], body })).not.toThrow();
  });

  it.each([
    ["PATCH", "/api/agents/service", { adapterConfig: {}, replaceAdapterConfig: true }],
    ["PATCH", "/api/agents/service", { adapterType: "codex_local" }],
    ["POST", "/api/agents/service/config-revisions/old/rollback", {}],
    ["POST", "/api/agents/service/wakeup", { payload: { command: "arbitrary" } }],
    ["DELETE", "/api/agents/service", {}],
  ])("rejects mutation or bypass through %s %s", (method, path, body) => {
    expect(() => assertAgentFixedProcessTarget(req(method, path, body), target)).toThrow();
  });

  it("allows the fixed self-trigger but rejects another agent", () => {
    const wake = req("POST", "/api/agents/service/wakeup", { idempotencyKey: "tick" });
    expect(() => assertAgentFixedProcessTarget(wake, target)).not.toThrow();
    expect(() => assertAgentFixedProcessTarget({ ...wake, actor: { ...actor, agentId: "other" } as Request["actor"] }, target)).toThrow();
  });

  it.each(["codex_local", "claude_local", "process"])("preserves ordinary %s agent configuration", (adapterType) => {
    const ordinary = { ...target, adapterType, adapterConfig: {} };
    expect(() => assertAgentFixedProcessTarget(req("PATCH", "/api/agents/service", { name: "Updated" }), ordinary)).not.toThrow();
  });
});
