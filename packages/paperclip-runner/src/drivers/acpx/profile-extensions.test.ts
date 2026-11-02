import { describe, expect, it, vi } from "vitest";
import { bindAcpxExtensionTurn, validateAcpxExtensionInput, validateAcpxRichEvent } from "./profile-extensions.js";
import type { CanonicalProviderEvent } from "../../provider-events.js";

const event: CanonicalProviderEvent = { eventType: "plan.updated", itemId: "plan-1", payload: {
  schema: "paperclip.plan.updated.v1", planId: "plan-1", revision: 1,
  steps: [{ stepId: "one", body: "Validate", status: "pending" }], complete: false, syncStatus: "not_applicable",
} };
const input = { method: "cursor/create_plan", questionSet: {
  schema: "paperclip.question_set.v1" as const, description: "complete plan".repeat(1000),
  questions: [{ id: "plan-revision", prompt: "Approve?", answerMode: "single_select" as const, required: true,
    options: [{ id: "accept", label: "Accept" }, { id: "cancel", label: "Cancel" }] }],
}, resolve: () => ({ outcome: "accepted" }), cancel: () => ({ outcome: "cancelled" }) };

describe("ACP extension turn binding", () => {
  it("preserves bounded full plans and rejects oversized documents", () => {
    expect(() => validateAcpxExtensionInput(input)).not.toThrow();
    expect(() => validateAcpxExtensionInput({ ...input, questionSet: { ...input.questionSet, description: "a".repeat(100001) } })).toThrow();
  });
  it("admits canonical activity but cannot mint a terminal or semantic mutation", () => {
    expect(() => validateAcpxRichEvent(event)).not.toThrow();
    expect(() => validateAcpxRichEvent({ ...event, eventType: "turn.completed" } as unknown as CanonicalProviderEvent)).toThrow();
    expect(() => validateAcpxRichEvent({ ...event, payload: { ...event.payload, extra: "unbounded" } })).toThrow();
  });
  it("waits for notification normalization before terminal settlement and preserves order", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const emitted: string[] = [];
    const binding = bindAcpxExtensionTurn({
      adapter: { request: async () => ({ events: [event], response: {} }),
        notification: async (method) => { if (method === "first") await gate; emitted.push(method); return [event]; } },
      sessionId: "session", active: () => true, waitForInput: vi.fn(), emit: vi.fn(),
    });
    binding.onExtensionNotification("first", { sessionId: "session" });
    binding.onExtensionNotification("second", { sessionId: "session" });
    let drained = false;
    const drain = binding.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release(); await drain;
    expect(emitted).toEqual(["first", "second"]);
  });
  it("retains request ID zero and rejects cross-session or stale events", async () => {
    let active = true;
    const waitForInput = vi.fn(async () => ({ outcome: "accepted" }));
    const binding = bindAcpxExtensionTurn({
      adapter: { request: async () => ({ input }), notification: async () => [event] },
      sessionId: "session", active: () => active, waitForInput, emit: vi.fn(),
    });
    const context = { requestId: 0, signal: new AbortController().signal };
    await binding.onExtensionRequest("cursor/create_plan", { sessionId: "session" }, context);
    expect(waitForInput).toHaveBeenCalledWith(input, context);
    await expect(binding.onExtensionRequest("cursor/create_plan", { sessionId: "another" }, context)).rejects.toThrow("mismatch");
    active = false;
    binding.onExtensionNotification("event", { sessionId: "session" });
    await expect(binding.drain()).rejects.toThrow("stale turn");
  });
});
