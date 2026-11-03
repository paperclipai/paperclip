type RuntimeMessageEvent = { type: string; text?: string; stream?: string; messageId?: string; meta?: Record<string, unknown> };
export interface KimiMessageBoundary { phase: "start" | "end"; stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" }
export type KimiProjectedMessageEvent<T> = T & { assistantMessageBoundary?: KimiMessageBoundary; assistantMessageHistory?: true };

const STOP_REASONS: Readonly<Record<string, KimiMessageBoundary["stopReason"]>> = Object.freeze({
  end_turn: "stop", max_tokens: "length", tool_use: "toolUse", error: "error", filtered: "error", other: "error",
  aborted: "aborted", paused: "aborted", max_steps: "aborted",
});

export function createKimiMessageProjection<T extends RuntimeMessageEvent>() {
  let active: string | null = null;
  const seen = new Set<string>();
  let poisoned = false;
  const fail = (): never => { poisoned = true; throw new Error("Kimi native message provenance is invalid or incomplete"); };
  return {
    normalize(event: T): KimiProjectedMessageEvent<T> {
      if (poisoned) return fail();
      if ("assistantMessageBoundary" in event || "assistantMessageHistory" in event) return fail();
      if (event.type !== "text_delta") return event;
      const { messageId, meta } = event;
      if (typeof messageId !== "string" || !/^kimi-message-[a-f0-9]{64}$/.test(messageId)
        || meta?.origin !== "kimi-native-assistant" || meta.source !== "kimi-turn-step-v1"
        || typeof event.text !== "string" || (event.stream !== "output" && event.stream !== "thought")) return fail();
      if (meta.kind === "delta") {
        if (active !== messageId) return fail();
        return event;
      }
      if (event.text !== "" || event.stream !== "output") return fail();
      if (meta.kind === "start") {
        if (active || seen.has(messageId) || seen.size >= 4096) return fail();
        seen.add(messageId); active = messageId;
        return { ...event, assistantMessageBoundary: { phase: "start" } };
      }
      if (active !== messageId || typeof meta.kind !== "string" || !meta.kind.startsWith("end:")) return fail();
      const reason = meta.kind.slice(4);
      if (!Object.hasOwn(STOP_REASONS, reason)) return fail();
      active = null;
      return { ...event, assistantMessageBoundary: { phase: "end", stopReason: STOP_REASONS[reason] } };
    },
    settle(): void { if (poisoned || active) fail(); },
  };
}

export function kimiMessageBoundaryClears(event: { assistantMessageBoundary?: KimiMessageBoundary }): boolean {
  const boundary = event.assistantMessageBoundary;
  return boundary?.phase === "start" || (boundary?.phase === "end" && !["stop", "length"].includes(boundary.stopReason ?? ""));
}
