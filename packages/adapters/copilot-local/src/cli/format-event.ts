import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeNum(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

export function printCopilotStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    console.log(line);
    return;
  }
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  const data = asRecord(parsed.data) ?? {};

  // Model init
  if (type === "session.tools_updated") {
    const model = typeof data.model === "string" ? data.model : "unknown";
    console.log(pc.blue(`Copilot initialized (model: ${model})`));
    return;
  }

  // User message
  if (type === "user.message") {
    const content = typeof data.content === "string" ? data.content : "";
    if (content && debug) {
      console.log(pc.gray(`user: ${content.slice(0, 200)}`));
    }
    return;
  }

  // Assistant reasoning (thinking)
  if (type === "assistant.reasoning") {
    if (debug) {
      const text = typeof data.reasoningText === "string" ? data.reasoningText : "";
      if (text) console.log(pc.gray(`thinking: ${text.slice(0, 200)}`));
    }
    return;
  }

  // Assistant message
  if (type === "assistant.message") {
    const content = typeof data.content === "string" ? data.content : "";
    if (content) console.log(pc.green(`assistant: ${content}`));

    // Copilot: toolRequests[].name at top level, not nested under .function
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const rawReq of toolRequests) {
      const req = asRecord(rawReq);
      if (!req) continue;
      const name = typeof req.name === "string" ? req.name : "unknown";
      console.log(pc.yellow(`tool_call: ${name}`));
      if (req.arguments !== undefined && debug) {
        const argStr =
          typeof req.arguments === "string"
            ? req.arguments
            : JSON.stringify(req.arguments, null, 2);
        console.log(pc.gray(argStr));
      }
    }
    return;
  }

  // Streaming delta
  if (type === "assistant.message_delta") {
    const deltaContent = typeof data.deltaContent === "string" ? data.deltaContent : "";
    if (deltaContent) process.stdout.write(pc.green(deltaContent));
    return;
  }

  // Tool execution start
  if (type === "tool.execution_start") {
    const name = typeof data.toolName === "string" ? data.toolName : "unknown";
    console.log(pc.yellow(`tool_start: ${name}`));
    return;
  }

  // Tool execution complete: uses data.success (not data.isError)
  if (type === "tool.execution_complete") {
    const name = typeof data.toolName === "string" ? data.toolName : "unknown";
    const isError = data.success === false;
    if (isError) {
      const errObj = asRecord(data.error);
      const errMsg = errObj && typeof errObj.message === "string" ? errObj.message : "";
      console.log(pc.red(`tool_error: ${name}${errMsg ? ` — ${errMsg}` : ""}`));
    } else {
      console.log(pc.cyan(`tool_done: ${name}`));
    }
    return;
  }

  // Final result
  if (type === "result") {
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const exitCode = safeNum(parsed.exitCode);
    const usageObj = asRecord(parsed.usage) ?? {};
    const premiumRequests = safeNum(usageObj.premiumRequests);
    const totalApiDurationMs = safeNum(usageObj.totalApiDurationMs);
    const sessionDurationMs = safeNum(usageObj.sessionDurationMs);

    if (sessionId) console.log(pc.blue(`session: ${sessionId}`));
    console.log(
      pc.blue(
        `usage: premiumRequests=${premiumRequests} apiDuration=${totalApiDurationMs}ms sessionDuration=${sessionDurationMs}ms exit=${exitCode}`,
      ),
    );
    return;
  }

  // Debug: show everything else
  if (debug) {
    console.log(pc.gray(line));
  }
}
