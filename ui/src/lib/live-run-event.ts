import type { HeartbeatRunEvent, LiveEvent } from "@paperclipai/shared";

export function liveRunEvent(event: LiveEvent): HeartbeatRunEvent | null {
  if (event.type !== "heartbeat.run.event") return null;
  const p = event.payload;
  if (typeof p.runId !== "string" || typeof p.agentId !== "string" || !Number.isSafeInteger(p.seq)
    || Number(p.seq) < 1 || typeof p.eventType !== "string") return null;
  return { id: Number(p.seq), runId: p.runId, companyId: event.companyId, agentId: p.agentId, seq: Number(p.seq),
    eventType: p.eventType, stream: p.stream === "stdout" || p.stream === "stderr" || p.stream === "system" ? p.stream : null,
    level: p.level === "info" || p.level === "warn" || p.level === "error" ? p.level : null, color: typeof p.color === "string" ? p.color : null,
    message: typeof p.message === "string" ? p.message : null,
    payload: p.payload && typeof p.payload === "object" && !Array.isArray(p.payload) ? p.payload as Record<string, unknown> : null,
    createdAt: new Date(event.createdAt) };
}
export function mergeRunEvents(previous: readonly HeartbeatRunEvent[], incoming: readonly HeartbeatRunEvent[]): HeartbeatRunEvent[] {
  const rows = new Map(previous.map(row => [row.seq, row]));
  for (const row of incoming) rows.set(row.seq, row);
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}
