import type { TaskChatMessage } from "./task-chat.js";

type Row = Record<string, any>;
const text = (value: unknown) => typeof value === "string" ? value : "";

/** Read only provider-neutral, explicitly public assistant progress. Completion
 * comments own final replies. Reasoning, tool payloads and runtime identities
 * never enter the conversation projection. */
export function taskChatProgress(runId: string, events: Row[], author: string): TaskChatMessage[] {
  const items = new Map<string, { kind: string; channel: string; body: string; at: string | null }>();
  const seen = new Set<string>();
  const ordered = events.flatMap<Row>(event => {
    const envelope = event.payload?.prpEvent;
    const tails = envelope?.payload?.outputTails;
    if (!Array.isArray(tails) || !/^(item|turn|session)\.(completed|failed|cancelled|interrupted|closed)$/.test(event.eventType)) return [event];
    // The runtime may hold a possible credential prefix until completion.
    // Preserve its redacted display tail, just as the task page does.
    return [...tails.flatMap((tail, index) => typeof tail?.payload?.text !== "string" ? [] : [{
      ...event, eventType: "item.delta", payload: { prpEvent: { ...envelope,
        eventType: "item.delta", itemId: tail.itemId, payload: tail.payload,
        sourceEventId: `${envelope.sourceEventId ?? event.seq}:tail:${index}`,
      } },
    }]), event];
  });
  for (const event of ordered) {
    const envelope = event.payload?.prpEvent;
    if (envelope?.schema !== "paperclip.prp.event.v1" || envelope.schemaVersion !== 1 ||
      envelope.runId !== runId || envelope.eventType !== event.eventType ||
      !["item.started", "item.delta", "item.completed"].includes(event.eventType)) continue;
    if (envelope.sourceEventId && seen.has(envelope.sourceEventId)) continue;
    if (envelope.sourceEventId) seen.add(envelope.sourceEventId);
    const p = envelope.payload ?? {}, item = p.item ?? p;
    const id = text(envelope.itemId) || text(p.itemId) || text(item.id);
    if (!id) continue;
    const previous = items.get(id);
    const body = text(p.text) || text(item.text);
    items.set(id, {
      kind: (text(p.kind) || text(item.kind) || text(item.type) || previous?.kind || "").replaceAll("_", "").toLowerCase(),
      channel: text(p.channel) || text(item.channel) || previous?.channel || "",
      body: event.eventType === "item.completed" && body ? body : (previous?.body ?? "") + body,
      at: previous?.at ?? (typeof event.createdAt === "string" && Number.isFinite(Date.parse(event.createdAt)) ? event.createdAt : null),
    });
  }
  return [...items].filter(([, item]) => ["agentmessage", "assistantmessage"].includes(item.kind) && item.channel === "progress" && item.body)
    .map(([, item], index) => ({ id: `progress:${runId}:${index + 1}`, at: item.at, role: "agent", author,
      kind: "progress", body: item.body }));
}
