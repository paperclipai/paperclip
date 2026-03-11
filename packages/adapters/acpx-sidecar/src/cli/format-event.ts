import pc from "picocolors";

export function printAcpxSidecarStreamEvent(raw: string): void {
  const line = raw.trim();
  if (!line) return;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const method = typeof event.method === "string" ? event.method : "";
    if (method === "session/update") {
      const params =
        typeof event.params === "object" && event.params && !Array.isArray(event.params)
          ? (event.params as Record<string, unknown>)
          : {};
      const updateType = typeof params.sessionUpdate === "string" ? params.sessionUpdate : "";
      const content =
        typeof params.content === "object" && params.content && !Array.isArray(params.content)
          ? (params.content as Record<string, unknown>)
          : {};
      if (updateType === "agent_message_chunk" && content.type === "text") {
        console.log(pc.green(String(content.text ?? "")));
        return;
      }
      if (updateType === "agent_thought_chunk" && content.type === "text") {
        console.log(pc.gray(`[thinking] ${String(content.text ?? "")}`));
        return;
      }
    }
    if (event.result && typeof event.result === "object") {
      const stopReason = (event.result as Record<string, unknown>).stopReason;
      if (typeof stopReason === "string") {
        console.log(pc.gray(`[done] ${stopReason}`));
        return;
      }
    }
  } catch {
    // fall through
  }
  console.log(line);
}
