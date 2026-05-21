import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  buildRoutingEscalatedDomainEvent,
  buildRoutingEscalatedPayload,
  type RoutingEscalatedEventInput,
} from "../routing/build-routing-escalated-event.js";
import { resolveTier } from "../routing/resolve-tier.js";
import { escalateOneTier } from "../routing/escalate-tier.js";
import { resolveModel } from "../routing/model-menu.js";
import {
  publishPluginDomainEvent,
  setPluginEventBus,
} from "../services/activity-log.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

const FIXED_EVENT_ID = "11111111-2222-3333-4444-555555555555";
const FIXED_OCCURRED_AT = "2026-05-21T00:00:00.000Z";

function baseInput(
  overrides: Partial<RoutingEscalatedEventInput> = {},
): RoutingEscalatedEventInput {
  return {
    runId: "run-1",
    agentId: "agent-1",
    companyId: "company-1",
    issueId: "issue-1",
    fromTier: "fast",
    fromModel: "claude-haiku-4-5-20251001",
    toTier: "default",
    toModel: "claude-sonnet-4-6",
    toProvider: "anthropic",
    reason: "exit code 1",
    errorCode: null,
    errorFamily: null,
    eventId: FIXED_EVENT_ID,
    occurredAt: FIXED_OCCURRED_AT,
    ...overrides,
  };
}

describe("buildRoutingEscalatedPayload (Phase I — payload for logActivity.details)", () => {
  it("returns the exact 12-field shape subscribers see", () => {
    const payload = buildRoutingEscalatedPayload(baseInput());
    expect(payload).toEqual({
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      issueId: "issue-1",
      fromTier: "fast",
      fromModel: "claude-haiku-4-5-20251001",
      toTier: "default",
      toModel: "claude-sonnet-4-6",
      toProvider: "anthropic",
      reason: "exit code 1",
      errorCode: null,
      errorFamily: null,
    });
  });

  it("preserves null issueId (escalation can happen on issueless runs)", () => {
    const payload = buildRoutingEscalatedPayload(baseInput({ issueId: null }));
    expect(payload.issueId).toBeNull();
  });

  it("preserves errorCode and errorFamily when present", () => {
    const payload = buildRoutingEscalatedPayload(
      baseInput({ errorCode: "context_overflow", errorFamily: "input_size" }),
    );
    expect(payload.errorCode).toBe("context_overflow");
    expect(payload.errorFamily).toBe("input_size");
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = buildRoutingEscalatedPayload(baseInput());
    const b = buildRoutingEscalatedPayload(baseInput());
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("buildRoutingEscalatedDomainEvent (Phase E3 — full PluginEvent envelope, retained for non-logActivity callers)", () => {
  describe("event envelope shape", () => {
    it("returns a PluginEvent with eventType=agent.routing.escalated", () => {
      const event = buildRoutingEscalatedDomainEvent(baseInput());
      expect(event.eventType).toBe("agent.routing.escalated");
    });

    it("uses runId as entityId and heartbeat_run as entityType (subscribers correlate by run)", () => {
      const event = buildRoutingEscalatedDomainEvent(baseInput({ runId: "run-xyz" }));
      expect(event.entityId).toBe("run-xyz");
      expect(event.entityType).toBe("heartbeat_run");
    });

    it("uses agentId as actorId and agent as actorType (the escalation is the agent's behavior)", () => {
      const event = buildRoutingEscalatedDomainEvent(baseInput({ agentId: "agent-xyz" }));
      expect(event.actorId).toBe("agent-xyz");
      expect(event.actorType).toBe("agent");
    });

    it("companyId is on the envelope (per PluginEvent contract; required by event-bus filters)", () => {
      const event = buildRoutingEscalatedDomainEvent(baseInput({ companyId: "company-xyz" }));
      expect(event.companyId).toBe("company-xyz");
    });

    it("eventId + occurredAt default to fresh values when not injected", () => {
      const event = buildRoutingEscalatedDomainEvent({
        runId: "r",
        agentId: "a",
        companyId: "c",
        issueId: null,
        fromTier: "fast",
        fromModel: "m1",
        toTier: "default",
        toModel: "m2",
        toProvider: "anthropic",
        reason: "x",
        errorCode: null,
        errorFamily: null,
      });
      expect(typeof event.eventId).toBe("string");
      expect(event.eventId.length).toBeGreaterThan(10);
      expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("envelope payload mirrors the standalone payload builder", () => {
    it("event.payload === buildRoutingEscalatedPayload(input)", () => {
      const event = buildRoutingEscalatedDomainEvent(baseInput());
      const payload = buildRoutingEscalatedPayload(baseInput());
      expect(event.payload).toEqual(payload);
    });
  });
});

describe("Phase I + E3 dispatch-shape integration (resolver-driven escalation + capture)", () => {
  // This test models the dispatch site contract end-to-end without
  // standing up the full heartbeat machinery:
  //   1. The dispatcher resolves a tier for the issue.
  //   2. A stub adapter "fails" on that tier (i.e. the first call's
  //      exit code is non-zero).
  //   3. The dispatcher escalates one tier up.
  //   4. The dispatcher publishes the escalation event (via
  //      publishPluginDomainEvent in this test; the real dispatch
  //      site uses logActivity, which also publishes — but
  //      logActivity requires a real Db so we exercise the publish
  //      path directly here).
  //   5. The stub adapter "succeeds" on the escalated tier.

  let publishedEvents: PluginEvent[];

  beforeEach(() => {
    publishedEvents = [];
    setPluginEventBus({
      emit: vi.fn(async (event: PluginEvent) => {
        publishedEvents.push(event);
        return { errors: [] };
      }),
    } as unknown as Parameters<typeof setPluginEventBus>[0]);
  });

  afterEach(() => {
    setPluginEventBus({
      emit: vi.fn(async () => ({ errors: [] })),
    } as unknown as Parameters<typeof setPluginEventBus>[0]);
  });

  async function simulateDispatchWithEscalation(opts: {
    issueComplexity: Parameters<typeof resolveTier>[0]["issueComplexity"];
    agentTierPreference: Parameters<typeof resolveTier>[0]["agentTierPreference"];
    runId: string;
    agentId: string;
    companyId: string;
    issueId: string | null;
    adapter: {
      execute: (args: { tier: string; model: string }) => Promise<{ exitCode: number }>;
    };
  }) {
    const initial = resolveTier({
      issueComplexity: opts.issueComplexity,
      agentTierPreference: opts.agentTierPreference,
    });

    const firstResult = await opts.adapter.execute({
      tier: initial.tier,
      model: initial.entry.model,
    });

    const escalateCandidate = escalateOneTier(initial.tier);
    if (firstResult.exitCode === 0 || escalateCandidate === null) {
      return { escalated: false, finalTier: initial.tier };
    }

    const escalatedEntry = resolveModel(escalateCandidate);

    publishPluginDomainEvent(
      buildRoutingEscalatedDomainEvent({
        runId: opts.runId,
        agentId: opts.agentId,
        companyId: opts.companyId,
        issueId: opts.issueId,
        fromTier: initial.tier,
        fromModel: initial.entry.model,
        toTier: escalateCandidate,
        toModel: escalatedEntry.model,
        toProvider: escalatedEntry.provider,
        reason: `exit code ${firstResult.exitCode}`,
        errorCode: null,
        errorFamily: null,
      }),
    );

    await opts.adapter.execute({
      tier: escalateCandidate,
      model: escalatedEntry.model,
    });

    return { escalated: true, finalTier: escalateCandidate };
  }

  it("publishes agent.routing.escalated when fast fails and dispatcher escalates to default", async () => {
    const adapter = {
      execute: vi
        .fn()
        .mockImplementationOnce(async ({ tier }: { tier: string; model: string }) => {
          expect(tier).toBe("fast");
          return { exitCode: 1 };
        })
        .mockImplementationOnce(async ({ tier }: { tier: string; model: string }) => {
          expect(tier).toBe("default");
          return { exitCode: 0 };
        }),
    };

    const result = await simulateDispatchWithEscalation({
      issueComplexity: "trivial",
      agentTierPreference: null,
      runId: "run-e3",
      agentId: "agent-e3",
      companyId: "company-e3",
      issueId: "issue-e3",
      adapter,
    });

    expect(result.escalated).toBe(true);
    expect(result.finalTier).toBe("default");
    expect(adapter.execute).toHaveBeenCalledTimes(2);

    const escalationEvents = publishedEvents.filter(
      (event) => event.eventType === "agent.routing.escalated",
    );
    expect(escalationEvents).toHaveLength(1);

    const [event] = escalationEvents;
    expect(event.companyId).toBe("company-e3");
    expect(event.entityId).toBe("run-e3");
    expect(event.entityType).toBe("heartbeat_run");
    expect(event.actorId).toBe("agent-e3");
    expect(event.actorType).toBe("agent");

    expect(event.payload).toMatchObject({
      runId: "run-e3",
      agentId: "agent-e3",
      companyId: "company-e3",
      issueId: "issue-e3",
      fromTier: "fast",
      fromModel: "claude-haiku-4-5-20251001",
      toTier: "default",
      toModel: "claude-sonnet-4-6",
      toProvider: "anthropic",
      reason: "exit code 1",
    });
  });

  it("does not publish when the first call succeeds (no escalation)", async () => {
    const adapter = {
      execute: vi.fn(async () => ({ exitCode: 0 })),
    };

    await simulateDispatchWithEscalation({
      issueComplexity: "trivial",
      agentTierPreference: null,
      runId: "run-ok",
      agentId: "agent-ok",
      companyId: "company-ok",
      issueId: null,
      adapter,
    });

    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(
      publishedEvents.filter((event) => event.eventType === "agent.routing.escalated"),
    ).toHaveLength(0);
  });

  it("does not publish when the failing tier is heavy (no next tier to escalate to)", async () => {
    const adapter = {
      execute: vi.fn(async () => ({ exitCode: 1 })),
    };

    const result = await simulateDispatchWithEscalation({
      issueComplexity: "hard",
      agentTierPreference: null,
      runId: "run-cap",
      agentId: "agent-cap",
      companyId: "company-cap",
      issueId: "issue-cap",
      adapter,
    });

    expect(result.escalated).toBe(false);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(
      publishedEvents.filter((event) => event.eventType === "agent.routing.escalated"),
    ).toHaveLength(0);
  });
});
