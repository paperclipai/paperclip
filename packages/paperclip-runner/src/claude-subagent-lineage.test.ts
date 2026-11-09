import { describe, expect, it } from "vitest";
import { acpxOpaqueToolItemId, createClaudeSubagentLineageTracker } from "./claude-subagent-lineage.js";
import {
  canonicalProviderEventsFromAcpxRuntimeEvent,
  createAcpxToolEventNormalizer,
  type AcpRuntimeEventShape,
} from "./provider-events.js";
import { validatePrpEvent } from "./protocol/replay-contract.js";

const SLASH_VECTOR = "acpx-tool-65b834e51b2f923abbb92966fc162e52736b1f0bc7675c8170cf08df837ec5d4";

function pipeline() {
  const normalize = createAcpxToolEventNormalizer<AcpRuntimeEventShape>();
  const track = createClaudeSubagentLineageTracker<AcpRuntimeEventShape>();
  return (event: AcpRuntimeEventShape) =>
    canonicalProviderEventsFromAcpxRuntimeEvent(track(normalize(event)), "fallback", "turn-1");
}

function valid(event: ReturnType<typeof canonicalProviderEventsFromAcpxRuntimeEvent>[number]) {
  return validatePrpEvent({
    schema: "paperclip.prp.event.v1",
    sourceEventId: "validation:1", sourceSeq: 1, sourceInstanceId: "validation",
    sourceKind: "runner", runId: "validation", normalizedSessionId: "validation",
    turnId: "turn-1", itemId: event.itemId, eventType: event.eventType,
    schemaVersion: 1, priority: 1, emittedAt: "2026-11-05T00:00:00.000Z", payload: event.payload,
  });
}

describe("Claude subagent lineage", () => {
  it("maps an Agent call to a delegation and links its child tools", () => {
    const map = pipeline();
    const started = map({
      type: "tool_call", tag: "tool_call", toolCallId: "toolu_agent", title: "Trace the retry path",
      status: "pending", kind: "think",
      rawInput: { subagent_type: "Explore", description: "Trace the retry path", prompt: "Find every retry." },
      _meta: { claudeCode: { toolName: "Agent" } },
    });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      eventType: "delegation.started",
      itemId: "toolu_agent",
      payload: {
        schema: "paperclip.delegation.v1",
        status: "running",
        children: [{ childId: "toolu_agent", role: "Explore", summary: "Trace the retry path", prompt: "Find every retry.", result: null }],
      },
    });
    expect(valid(started[0]!).ok).toBe(true);

    const progress = map({
      type: "tool_call", tag: "tool_call_update", toolCallId: "toolu_agent",
      _meta: { claudeCode: { subagentProgress: { summary: "Found scheduleRetry" } } },
    });
    expect(progress[0]).toMatchObject({
      eventType: "delegation.updated",
      payload: { children: [{ role: "Explore", prompt: "Find every retry.", activitySummary: "Found scheduleRetry" }] },
    });

    const child = map({
      type: "tool_call", tag: "tool_call", toolCallId: "toolu_child", title: "Read webhook-delivery.ts",
      status: "pending", kind: "read",
      _meta: { claudeCode: { toolName: "Read", parentToolUseId: "toolu_agent" } },
    });
    expect(child[0]).toMatchObject({ eventType: "tool.execution.started", payload: { parentItemId: "toolu_agent" } });
    expect(valid(child[0]!).ok).toBe(true);
    // A later frame without _meta keeps the parent link.
    const childDone = map({ type: "tool_call", tag: "tool_call_update", toolCallId: "toolu_child", status: "completed", rawOutput: "ok" });
    expect(childDone[0]).toMatchObject({ eventType: "tool.execution.completed", payload: { parentItemId: "toolu_agent" } });

    const done = map({
      type: "tool_call", tag: "tool_call_update", toolCallId: "toolu_agent", status: "completed",
      rawOutput: [{ type: "text", text: "Retries create a new row." }],
    });
    expect(done[0]).toMatchObject({
      eventType: "delegation.completed",
      payload: { status: "completed", children: [{ status: "completed", activitySummary: null, result: "Retries create a new row." }] },
    });
    expect(valid(done[0]!).ok).toBe(true);
  });

  it("keeps an async subagent running past its launch result until its own state settles", () => {
    const map = pipeline();
    map({
      type: "tool_call", tag: "tool_call", toolCallId: "toolu_async", status: "pending",
      rawInput: { subagent_type: "Explore", description: "Find tests", prompt: "List tests." },
      _meta: { claudeCode: { toolName: "Agent" } },
    });
    const launched = map({
      type: "tool_call", tag: "tool_call_update", toolCallId: "toolu_async", status: "completed",
      rawOutput: [{ type: "text", text: "Async agent launched successfully.\nagentId: a1 (internal ID)" }],
    });
    expect(launched[0]).toMatchObject({ eventType: "delegation.updated", payload: { status: "running", children: [{ status: "running", result: null }] } });
    const settled = map({
      type: "tool_call", tag: "tool_call_update", toolCallId: "toolu_async",
      _meta: { claudeCode: { subagentState: { status: "completed", summary: "Two suites cover delivery." } } },
    });
    expect(settled[0]).toMatchObject({
      eventType: "delegation.completed",
      payload: { status: "completed", children: [{ status: "completed", result: "Two suites cover delivery." }] },
    });
    expect(valid(settled[0]!).ok).toBe(true);
  });

  it("marks a result cut at the schema bound so it never reads as complete", () => {
    const map = pipeline();
    map({
      type: "tool_call", tag: "tool_call", toolCallId: "toolu_long", status: "pending",
      rawInput: { subagent_type: "Explore", description: "Long answer" },
      _meta: { claudeCode: { toolName: "Agent" } },
    });
    const done = map({ type: "tool_call", tag: "tool_call_update", toolCallId: "toolu_long", status: "completed", rawOutput: "x".repeat(9_000) });
    const result = (done[0]!.payload.children as Array<{ result: string }>)[0]!.result;
    expect(result.length).toBeLessThanOrEqual(4_000);
    expect(result.endsWith("[Result truncated]")).toBe(true);
    expect(valid(done[0]!).ok).toBe(true);
  });

  it("leaves top-level tools unchanged", () => {
    const [event] = pipeline()({
      type: "tool_call", tag: "tool_call", toolCallId: "toolu_top", title: "Read a.ts", status: "pending", kind: "read",
      _meta: { claudeCode: { toolName: "Read" } },
    });
    expect(event?.eventType).toBe("tool.execution.started");
    expect(event?.payload).not.toHaveProperty("parentItemId");
  });

  it("names tool calls exactly like runner-core acpx_opaque_item_id", () => {
    expect(acpxOpaqueToolItemId("toolu_01Abc")).toBe("toolu_01Abc");
    // Shared vector with provider_events.rs acpx_opaque_tool_ids_match_the_sidecar.
    expect(acpxOpaqueToolItemId("tool/with slash")).toBe(SLASH_VECTOR);
    expect(acpxOpaqueToolItemId("t".repeat(161))).toMatch(/^acpx-tool-[0-9a-f]{64}$/);
  });

  it("keeps a parent link for a 240-byte tool id", () => {
    const map = pipeline();
    const parent = "p".repeat(200);
    const [child] = map({
      type: "tool_call", tag: "tool_call", toolCallId: "toolu_child", status: "pending", title: "Read",
      _meta: { claudeCode: { toolName: "Read", parentToolUseId: parent } },
    });
    expect(child?.payload.parentItemId).toBeTruthy();
  });
});
