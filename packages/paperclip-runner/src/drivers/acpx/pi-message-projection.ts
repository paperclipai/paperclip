type RuntimeMessageEvent = { type: string; text?: string; stream?: string; messageId?: string; meta?: Record<string, unknown> };
export interface PiMessageBoundary { phase: "start" | "end"; stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" }
export type PiProjectedMessageEvent<T> = T & { piMessageBoundary?: PiMessageBoundary; piMessageHistory?: true };

/** Revalidate the pinned wrapper's actual SDK provenance. No tool event or
 * message text can be used to infer a missing assistant-message boundary. */
export function createPiMessageProjection<T extends RuntimeMessageEvent>() {
  let active: string | null = null;
  const seen = new Set<string>();
  let poisoned = false;
  const fail = (): never => { poisoned = true; throw new Error("Pi native message provenance is invalid or incomplete"); };
  return {
    normalize(event: T): PiProjectedMessageEvent<T> {
      if (poisoned) return fail();
      if (event.type !== "text_delta") return event;
      const { messageId, meta } = event;
      if (meta?.origin === "pi-history-assistant") {
        if (active || seen.size || meta.source !== "pi-session-history-v1" || meta.kind !== "history"
          || typeof messageId !== "string" || !/^pi-history-message-[a-f0-9]{64}$/.test(messageId)
          || typeof event.text !== "string" || event.stream !== "output") return fail();
        return { ...event, piMessageHistory: true };
      }
      if (typeof messageId !== "string" || !/^pi-message-[a-f0-9]{64}$/.test(messageId)
        || meta?.origin !== "pi-native-assistant" || meta.source !== "pi-rpc-message-v1" || typeof event.text !== "string") return fail();
      if (meta.kind === "delta") {
        if (active !== messageId) return fail();
        return event;
      }
      if (event.text !== "" || event.stream !== "output") return fail();
      if (meta.kind === "start") {
        if (active || seen.has(messageId) || seen.size >= 4096) return fail();
        seen.add(messageId); active = messageId;
        return { ...event, piMessageBoundary: { phase: "start" } };
      }
      if (active !== messageId || typeof meta.kind !== "string" || !/^end:(stop|length|toolUse|error|aborted)$/.test(meta.kind)) return fail();
      active = null;
      return { ...event, piMessageBoundary: { phase: "end", stopReason: meta.kind.slice(4) as PiMessageBoundary["stopReason"] } };
    },
    settle(): void { if (poisoned || active) fail(); },
  };
}

/** A completed tool-use/error/abort message is still durable progress, but it
 * cannot become an assistant final reply if the native loop ends there. */
export function piBoundaryClearsFinal(event: { piMessageBoundary?: PiMessageBoundary }): boolean {
  const boundary = event.piMessageBoundary;
  return boundary?.phase === "start" || (boundary?.phase === "end" && !["stop", "length"].includes(boundary.stopReason ?? ""));
}
