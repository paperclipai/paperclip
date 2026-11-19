import { heartbeatRunEvents, heartbeatRuns, toolInvocations, type Db } from "@paperclipai/db";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { parseObject } from "../adapters/utils.js";

const mutatingItems = new Set(["command_execution", "commandExecution", "file_change", "fileChange", "collabAgentToolCall", "subAgentActivity"]);

/** Known host/provider actions need outcome receipts before a fresh conversation. */
export async function legacyRunHasUnsettledActions(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "resultJson">): Promise<boolean> {
  const [pending] = await db.select({ id: toolInvocations.id }).from(toolInvocations).where(and(
    eq(toolInvocations.companyId, run.companyId), eq(toolInvocations.runId, run.id),
    or(ne(toolInvocations.status, "succeeded"), isNull(toolInvocations.completedAt), isNull(toolInvocations.resultHash), eq(toolInvocations.resultHash, "")),
  )).limit(1);
  if (pending) return true;
  if (Object.values(parseObject(run.resultJson?.apiToolReceipts)).some(receipt => {
    const value = parseObject(receipt);
    return typeof value.operationId !== "string" || !("result" in value);
  })) return true;
  const events = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    inArray(heartbeatRunEvents.eventType, ["semantic_tool.input", "semantic_tool.result", "tool.execution.started", "tool.execution.completed", "item.started", "item.completed"]),
  ));
  const completed = new Map<string, number>();
  const starts: Array<{ key: string | null; seq: number }> = [];
  for (const event of events) {
    const envelope = parseObject(event.payload), prp = parseObject(envelope.prpEvent);
    const payload = Object.keys(prp).length ? parseObject(prp.payload) : envelope;
    const source = event.sourceInstanceId ?? (typeof prp.sourceInstanceId === "string" ? prp.sourceInstanceId : null);
    const key = (kind: string, ...identity: unknown[]) => identity.every(value => typeof value === "string" && value.length > 0)
      ? JSON.stringify([kind, source, ...identity]) : null;
    let identity: string | null = null;
    let finished = false;
    if (event.eventType.startsWith("semantic_tool.")) {
      identity = key("semantic", payload.callId, payload.toolId, payload.operationId);
      finished = event.eventType === "semantic_tool.result" && payload.outcome === "succeeded";
    } else if (event.eventType.startsWith("tool.execution.")) {
      identity = key("provider", payload.executionId, payload.name);
      finished = event.eventType === "tool.execution.completed" && ["succeeded", "completed"].includes(String(payload.status));
    } else {
      identity = key("item", prp.itemId ?? payload.itemId);
      finished = event.eventType === "item.completed" && payload.status === "completed";
      if (event.eventType === "item.started" && !mutatingItems.has(String(payload.kind ?? payload.type))) continue;
    }
    if (finished && identity) completed.set(identity, Math.max(completed.get(identity) ?? 0, event.seq));
    if (["semantic_tool.input", "tool.execution.started", "item.started"].includes(event.eventType)) starts.push({ key: identity, seq: event.seq });
  }
  return starts.some(start => !start.key || (completed.get(start.key) ?? 0) <= start.seq);
}
