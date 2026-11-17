import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const persistActivity = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../services/activity-log.js", () => ({ persistActivity }));

import { runnerCallOutcomeMiddleware } from "./runner-call-outcome.js";

const runId = "11111111-2222-4333-8444-555555555555";
const callKey = "d".repeat(64);
const agent = { type: "agent", source: "agent_jwt", agentId: "agent-a", companyId: "company-a", runId } as const;

function invoke(actor: unknown, options: { method?: string; key?: string | null } = {}) {
  const key = options.key === undefined ? callKey : options.key;
  const end = vi.fn();
  const req = { method: options.method ?? "PATCH", actor,
    header: (name: string) => (name.toLowerCase() === "x-paperclip-runner-call" ? key ?? undefined : undefined) } as unknown as Request;
  const res = { statusCode: 200, end } as unknown as Response;
  const next = vi.fn();
  runnerCallOutcomeMiddleware({} as Db)(req, res, next);
  return { res, end, next };
}

describe("runner call outcome", () => {
  beforeEach(() => persistActivity.mockClear());

  it.each([201, 422, 500])("records the final status %s of an agent run's keyed mutation once", (status) => {
    const { res, end, next } = invoke(agent);
    expect(next).toHaveBeenCalledOnce();
    res.statusCode = status;
    res.end();
    res.end();
    expect(end).toHaveBeenCalledTimes(2);
    expect(persistActivity).toHaveBeenCalledExactlyOnceWith({}, { companyId: "company-a", actorType: "agent", actorId: "agent-a",
      agentId: "agent-a", runId, action: "runner.api_completed", entityType: "heartbeat_run", entityId: runId,
      details: { callKey, status } });
  });

  it.each([
    ["a read", agent, { method: "GET" }],
    ["a missing call key", agent, { key: null }],
    ["a malformed call key", agent, { key: "not-a-key" }],
    ["an agent API key", { ...agent, source: "agent_key" }, {}],
    ["a board actor", { type: "board", source: "session", runId }, {}],
    ["a non-UUID run", { ...agent, runId: "run-a" }, {}],
  ] as const)("ignores %s", (_case, actor, options) => {
    const { res, end, next } = invoke(actor, options);
    expect(next).toHaveBeenCalledOnce();
    res.end();
    expect(end).toHaveBeenCalledOnce();
    expect(persistActivity).not.toHaveBeenCalled();
  });
});
