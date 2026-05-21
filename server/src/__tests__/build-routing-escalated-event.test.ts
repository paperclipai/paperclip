import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  buildRoutingEscalatedDomainEvent,
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

describe("buildRoutingEscalatedDomainEvent (Phase E3 notifier)", () => {
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
      // UUIDv4 shape — coarse check, just that it's a non-empty string.
      expect(typeof event.eventId).toBe("string");
      expect(event.eventId.length).toBeGreaterThan(10);
      // ISO8601 timestamp shape.
      expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("payload shape (must mirror routing.escalation run-event payload + identifiers)", () => {
    it("includes all routing.escalation fields plus run/agent/company/issue identifiers", () => {
      const event = buildRoutingEscalatedDomainEvent(baseInput());
      expect(event.payload).toEqual({
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
      const event = buildRoutingEscalatedDomainEvent(baseInput({ issueId: null }));
      expect(event.payload.issueId).toBeNull();
    });

    it("preserves errorCode and errorFamily when present", () => {
      const event = buildRoutingEscalatedDomainEvent(
        baseInput({ errorCode: "context_overflow", errorFamily: "input_size" }),
      );
      expect(event.payload.errorCode).toBe("context_overflow");
      expect(event.payload.errorFamily).toBe("input_size");
    });
  });
});

describe("Phase E3 dispatch-shape integration (resolver-driven escalation + capture)", () => {
  // This test models the dispatch site contract end-to-end without
  // standing up the full heartbeat machinery:
  //   1. The dispatcher resolves a tier for the issue.
  //   2. A stub adapter "fails" on that tier (i.e. the first call's
  //      exit code is non-zero).
  //   3. The dispatcher escalates one tier up.
  //   4. The dispatcher builds + publishes the agent.routing.escalated
  //      domain event so observability can react.
  //   5. The stub adapter "succeeds" on the escalated tier.
  // We capture published events via a fake PluginEventBus and assert
  // the escalation event is published with the resolver-derived
  // from/to tiers and models.

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
    // Reset the module-scoped bus so test bleed doesn't accumulate.
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
    // Step 1: dispatcher resolves the initial tier.
    const initial = resolveTier({
      issueComplexity: opts.issueComplexity,
      agentTierPreference: opts.agentTierPreference,
    });

    // Step 2: stub adapter call at the initial tier.
    const firstResult = await opts.adapter.execute({
      tier: initial.tier,
      model: initial.entry.model,
    });

    // Step 3: escalation backstop. Only escalate on failure with a
    // non-cap tier (matches Phase E2 contract in heartbeat.ts:7765).
    const escalateCandidate = escalateOneTier(initial.tier);
    if (firstResult.exitCode === 0 || escalateCandidate === null) {
      return { escalated: false, finalTier: initial.tier };
    }

    const escalatedEntry = resolveModel(escalateCandidate);

    // Step 4: build + publish the Phase E3 domain event.
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

    // Step 5: stub adapter call at the escalated tier.
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
          // First call (tier=fast) fails.
          expect(tier).toBe("fast");
          return { exitCode: 1 };
        })
        .mockImplementationOnce(async ({ tier }: { tier: string; model: string }) => {
          // Second call (tier=default after escalation) succeeds.
          expect(tier).toBe("default");
          return { exitCode: 0 };
        }),
    };

    const result = await simulateDispatchWithEscalation({
      issueComplexity: "trivial", // resolves to fast
      agentTierPreference: null,
      runId: "run-e3",
      agentId: "agent-e3",
      companyId: "company-e3",
      issueId: "issue-e3",
      adapter,
    });

    expect(result.escalated).toBe(true);
    expect(result.finalTier).toBe("default");

    // The adapter was called twice (initial + escalated).
    expect(adapter.execute).toHaveBeenCalledTimes(2);

    // Exactly one Phase E3 domain event was published.
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
      issueComplexity: "hard", // resolves to heavy (cap)
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
