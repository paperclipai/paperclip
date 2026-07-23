import { describe, expect, it } from "vitest";
import { createTestTelemetryCtx, createMockSpan, makeEvent } from "./helpers.js";
import { METRIC_NAMES } from "../src/constants.js";
import {
  handleActivityMetrics,
  handleActivityTraces,
  handleActivityLogs,
} from "../src/telemetry/activity-handlers.js";

// ---------------------------------------------------------------------------
// handleActivityMetrics
// ---------------------------------------------------------------------------

describe("handleActivityMetrics", () => {
  it("increments activity count with action, entity_type, actor_type, agent_id", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleActivityMetrics(
      makeEvent("activity.logged", {
        action: "file.edit",
        entityType: "file",
        actorType: "agent",
        agentId: "agent-1",
        companyId: "co-1",
      }),
      ctx,
    );

    const counter = meter._counters.get(METRIC_NAMES.activityCount);
    expect(counter).toBeDefined();
    expect(counter!.add).toHaveBeenCalledWith(1, {
      action: "file.edit",
      entity_type: "file",
      actor_type: "agent",
      agent_id: "agent-1",
      company_id: "co-1",
    });
  });

  it("increments actor count without actor_id (bounded cardinality)", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleActivityMetrics(
      makeEvent("activity.logged", {
        action: "tool.invoke",
        entityType: "tool",
        actorType: "agent",
        actorId: "actor-xyz",
        companyId: "co-1",
      }),
      ctx,
    );

    const actorCounter = meter._counters.get(METRIC_NAMES.activityActorCount);
    expect(actorCounter).toBeDefined();
    expect(actorCounter!.add).toHaveBeenCalledWith(1, {
      actor_type: "agent",
      company_id: "co-1",
    });
  });

  it("handles missing payload fields gracefully", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleActivityMetrics(makeEvent("activity.logged", {}), ctx);

    const counter = meter._counters.get(METRIC_NAMES.activityCount);
    expect(counter!.add).toHaveBeenCalledWith(1, {
      action: "activity.logged",
      entity_type: "unknown",
      actor_type: "unknown",
      agent_id: "",
      company_id: "company-test",
    });
  });
});

// ---------------------------------------------------------------------------
// handleActivityTraces
// ---------------------------------------------------------------------------

describe("handleActivityTraces", () => {
  it("creates child span for tool activity under active run span", async () => {
    const { ctx, tracer } = createTestTelemetryCtx();
    const runSpan = createMockSpan();
    ctx.activeRunSpans.set("run-1", runSpan);

    await handleActivityTraces(
      makeEvent("activity.logged", {
        runId: "run-1",
        agentId: "agent-1",
        action: "file.edit",
        entityType: "file",
        entityId: "src/main.ts",
        companyId: "co-1",
      }),
      ctx,
    );

    // Tool activities now create child spans, not span events
    expect(runSpan._events).toHaveLength(0);
    expect(tracer._lastSpan).toBeDefined();
    expect(tracer._lastSpan!._attributes).toMatchObject({
      "gen_ai.tool.name": "file.file.edit",
      "gen_ai.operation.name": "tool_call",
      "paperclip.activity.action": "file.edit",
      "paperclip.activity.entity_type": "file",
      "paperclip.activity.entity_id": "src/main.ts",
      "paperclip.agent.id": "agent-1",
      "paperclip.company.id": "co-1",
      "gen_ai.tool.call.id": "src/main.ts",
    });
    expect(tracer._lastSpan!._ended).toBe(true);
  });

  it("attaches gen_ai.tool.name for tool entity types as child span", async () => {
    const { ctx, tracer } = createTestTelemetryCtx();
    const runSpan = createMockSpan();
    ctx.activeRunSpans.set("run-1", runSpan);

    await handleActivityTraces(
      makeEvent("activity.logged", {
        runId: "run-1",
        agentId: "agent-1",
        action: "tool.read",
        entityType: "tool",
      }),
      ctx,
    );

    expect(tracer._lastSpan!._attributes["gen_ai.tool.name"]).toBe("read");
    expect(tracer._lastSpan!._ended).toBe(true);
  });

  it("attaches gen_ai.tool.name for file entity types as child span", async () => {
    const { ctx, tracer } = createTestTelemetryCtx();
    const runSpan = createMockSpan();
    ctx.activeRunSpans.set("run-1", runSpan);

    await handleActivityTraces(
      makeEvent("activity.logged", {
        runId: "run-1",
        action: "write",
        entityType: "file",
      }),
      ctx,
    );

    expect(tracer._lastSpan!._attributes["gen_ai.tool.name"]).toBe("file.write");
    expect(tracer._lastSpan!._ended).toBe(true);
  });

  it("creates standalone span when no active run span exists", async () => {
    const { ctx, tracer } = createTestTelemetryCtx();

    await handleActivityTraces(
      makeEvent("activity.logged", {
        agentId: "agent-1",
        agentName: "TestBot",
        action: "api_call",
        entityType: "api_call",
        entityId: "/v1/endpoint",
        companyId: "co-1",
      }),
      ctx,
    );

    expect(tracer._lastSpan).toBeDefined();
    expect(tracer._lastSpan!._attributes["paperclip.activity.action"]).toBe("api_call");
    expect(tracer._lastSpan!._attributes["gen_ai.tool.name"]).toBe("api_call.api_call");
    expect(tracer._lastSpan!._ended).toBe(true);
  });

  it("does not attach gen_ai.tool.name for non-tool entity types", async () => {
    const { ctx } = createTestTelemetryCtx();
    const runSpan = createMockSpan();
    ctx.activeRunSpans.set("run-1", runSpan);

    await handleActivityTraces(
      makeEvent("activity.logged", {
        runId: "run-1",
        action: "status_change",
        entityType: "issue",
      }),
      ctx,
    );

    expect(runSpan._events[0].attributes!["gen_ai.tool.name"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleActivityLogs
// ---------------------------------------------------------------------------

describe("handleActivityLogs", () => {
  it("emits structured log with expected attributes", async () => {
    const { ctx, otelLogger } = createTestTelemetryCtx();
    await handleActivityLogs(
      makeEvent("activity.logged", {
        action: "file.edit",
        entityType: "file",
        entityId: "src/main.ts",
        actorType: "agent",
        actorId: "actor-1",
        agentId: "agent-1",
        runId: "run-1",
        companyId: "co-1",
        message: "Agent edited src/main.ts",
      }),
      ctx,
    );

    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Agent edited src/main.ts",
      expect.objectContaining({
        "paperclip.event.type": "activity.logged",
        "paperclip.activity.action": "file.edit",
        "paperclip.activity.entity_type": "file",
        "paperclip.activity.entity_id": "src/main.ts",
        "paperclip.actor.type": "agent",
        "paperclip.actor.id": "actor-1",
        "paperclip.agent.id": "agent-1",
        "paperclip.run.id": "run-1",
        "paperclip.company.id": "co-1",
      }),
    );

    expect(otelLogger.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityText: "INFO",
        body: "Agent edited src/main.ts",
      }),
    );
  });

  it("constructs default message when message is absent", async () => {
    const { ctx } = createTestTelemetryCtx();
    await handleActivityLogs(
      makeEvent("activity.logged", {
        action: "write",
        entityType: "file",
        entityId: "foo.ts",
        actorType: "agent",
        actorId: "a-1",
      }),
      ctx,
    );

    expect(ctx.logger.info).toHaveBeenCalledWith(
      "agent a-1: write on file foo.ts",
      expect.any(Object),
    );
  });

  it("still logs via plugin logger when otelLogger is null", async () => {
    const { ctx } = createTestTelemetryCtx({ otelLogger: null });
    await handleActivityLogs(
      makeEvent("activity.logged", {
        action: "read",
        entityType: "file",
        message: "Read a file",
      }),
      ctx,
    );

    expect(ctx.logger.info).toHaveBeenCalledWith("Read a file", expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// resolveToolName (tested indirectly via handleActivityTraces)
// ---------------------------------------------------------------------------

describe("resolveToolName mapping", () => {
  it("strips tool. prefix from actions on tool entities", async () => {
    const { ctx, tracer } = createTestTelemetryCtx();
    const runSpan = createMockSpan();
    ctx.activeRunSpans.set("r", runSpan);

    await handleActivityTraces(
      makeEvent("activity.logged", { runId: "r", action: "tool.bash", entityType: "tool" }),
      ctx,
    );
    expect(tracer._lastSpan!._attributes["gen_ai.tool.name"]).toBe("bash");
    expect(tracer._lastSpan!._ended).toBe(true);
  });

  it("maps api_call entity type to entityType.action format", async () => {
    const { ctx, tracer } = createTestTelemetryCtx();
    const runSpan = createMockSpan();
    ctx.activeRunSpans.set("r", runSpan);

    await handleActivityTraces(
      makeEvent("activity.logged", { runId: "r", action: "fetch", entityType: "api_call" }),
      ctx,
    );
    expect(tracer._lastSpan!._attributes["gen_ai.tool.name"]).toBe("api_call.fetch");
    expect(tracer._lastSpan!._ended).toBe(true);
  });

  it("returns null for unknown entity types", async () => {
    const { ctx } = createTestTelemetryCtx();
    const span = createMockSpan();
    ctx.activeRunSpans.set("r", span);

    await handleActivityTraces(
      makeEvent("activity.logged", { runId: "r", action: "update", entityType: "issue" }),
      ctx,
    );
    expect(span._events[0].attributes!["gen_ai.tool.name"]).toBeUndefined();
  });
});
