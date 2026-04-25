import pc from "picocolors";

export function printClaudeCodeStreamEvent(event: unknown): void {
  const record = typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};
  const type = typeof record.type === "string" ? record.type : "";
  const subtype = typeof record.subtype === "string" ? record.subtype : "";

  if (type === "system") {
    const model = typeof record.model === "string" ? record.model : "unknown";
    const sessionId = typeof record.session_id === "string" ? record.session_id : "";
    console.error(pc.dim(`[Claude Code] Session: ${sessionId} | Model: ${model}`));
    return;
  }

  if (type === "assistant") {
    const content = record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>).content
      : null;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
          const text = String((block as Record<string, unknown>).text ?? "");
          if (text) console.log(text);
        }
      }
    }
    return;
  }

  if (type === "result") {
    const isError = record.is_error === true;
    const result = typeof record.result === "string" ? record.result : "";
    if (isError && result) {
      console.error(pc.red(`[Error] ${result}`));
    }
    return;
  }

  console.log(JSON.stringify(event, null, 2));
}
