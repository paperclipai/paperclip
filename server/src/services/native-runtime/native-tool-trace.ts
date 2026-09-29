import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../../vendor/paperclip-runner/index.js";
import type { NativeRunTrace } from "./native-run-trace.js";

const SAFE_OPERATIONS = new Set<string>(CAPABILITY_SEMANTIC_TOOL_CATALOG.map((tool) => tool.operationId));
function operation(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/^mcp__paperclip__/, "") : "";
  return SAFE_OPERATIONS.has(name) ? name : "other";
}

/** Provider stream IDs and MCP request IDs are separate namespaces. Never join by name or order. */
export function createNativeToolTrace(trace: NativeRunTrace, now = Date.now) {
  const announced = new Map<string, { startedAtMs: number; lastInputAtMs?: number; operation: string }>();
  return {
    observe(event: { eventType: string; emittedAt: string; payload: unknown }): void | Promise<void> {
      if (["turn.started", "turn.completed", "turn.failed", "turn.cancelled"].includes(event.eventType)) {
        announced.clear();
        return;
      }
      if (!event.eventType.startsWith("tool.execution.")) return;
      const payload = event.payload as { executionId?: unknown; name?: unknown; inputUpdated?: unknown } | null;
      const id = payload?.executionId;
      const time = Date.parse(event.emittedAt);
      if (typeof id !== "string" || !id || !Number.isFinite(time)) return;
      if (event.eventType === "tool.execution.started") {
        if (announced.has(id)) return;
        if (announced.size >= 512) announced.delete(announced.keys().next().value!);
        announced.set(id, { startedAtMs: time, operation: operation(payload?.name) });
        return;
      }
      const pending = announced.get(id);
      if (!pending) return;
      if (payload?.inputUpdated === true && time >= pending.startedAtMs) {
        pending.lastInputAtMs = Math.max(pending.lastInputAtMs ?? pending.startedAtMs, time);
      }
      if (event.eventType !== "tool.execution.completed") return;
      announced.delete(id);
      if (pending.lastInputAtMs === undefined) return;
      // Measures observed argument streaming, not an inferred execution-start boundary.
      return trace.record({
        name: "tool.request.input_stream", parentName: "agent.turn",
        startedAtMs: pending.startedAtMs, endedAtMs: pending.lastInputAtMs,
        attributes: { operation: pending.operation },
      });
    },
    async execute<T>(call: { callId: string; tool: string }, work: () => Promise<T>): Promise<T> {
      const scope = trace.start("tool.execute", {
        parentName: "agent.turn", startedAtMs: now(), attributes: { operation: operation(call.tool) },
      });
      let outcome: "ok" | "failed" = "ok";
      try {
        return await trace.run(scope, work);
      } catch (error) {
        outcome = "failed";
        throw error;
      } finally {
        await trace.end(scope, { endedAtMs: now(), outcome });
      }
    },
  };
}
export type NativeToolTrace = ReturnType<typeof createNativeToolTrace>;
