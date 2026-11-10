import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";

type TextKind = "agentMessage" | "reasoning";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createNativeDeliverableTextObservation() {
  const itemKinds = new Map<string, string>();
  const observeItem = (payload: Record<string, unknown>, envelopeItemId?: string): TextKind | null => {
    const item = record(payload.item);
    const itemId = text(envelopeItemId) ?? text(payload.itemId) ?? text(item.id);
    const kind = (text(payload.kind) ?? text(item.kind) ?? text(item.type) ?? "")
      .replaceAll("_", "").toLowerCase() || (itemId ? itemKinds.get(itemId) : "");
    if (itemId && kind) itemKinds.set(itemId, kind);
    if (!(text(payload.text) ?? text(item.text))?.trim()) return null;
    if (kind === "reasoning") return "reasoning";
    return kind === "agentmessage" || kind === "assistantmessage" ? "agentMessage" : null;
  };

  return (event: Pick<PrpEvent, "eventType" | "payload" | "itemId">): TextKind | null => {
    const payload = record(event.payload);
    if (/^(item|turn|session)\.(completed|failed|cancelled|interrupted|closed)$/.test(event.eventType)
        && Array.isArray(payload.outputTails)) {
      for (const value of payload.outputTails) {
        const tail = record(value);
        const tailPayload = record(tail.payload);
        const itemId = text(tail.itemId) ?? text(tailPayload.itemId) ?? text(record(tailPayload.item).id);
        if (!itemId || typeof tailPayload.text !== "string") continue;
        const kind = observeItem(tailPayload, itemId);
        if (kind) return kind;
      }
    }
    if (event.eventType === "item.started") {
      observeItem(payload, event.itemId);
      return null;
    }
    if (event.eventType === "item.delta" || event.eventType === "item.completed") {
      const item = record(payload.item);
      if (event.eventType === "item.delta" &&
          !(text(event.itemId) ?? text(payload.itemId) ?? text(item.id))) return null;
      return observeItem(payload, event.itemId);
    }
    if (event.eventType === "run.result.accepted") {
      const result = record(payload.result);
      if (result.schema === "paperclip.run_result.v1" && text(result.summary)?.trim()) return "agentMessage";
    }
    return null;
  };
}
