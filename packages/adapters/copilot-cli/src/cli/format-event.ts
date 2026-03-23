import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Pretty-print a single JSONL event from Copilot CLI output for terminal display.
 */
export function printCopilotStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  const data = asRecord(parsed.data) ?? {};

  if (type === "session.tools_updated") {
    const model = typeof data.model === "string" ? data.model : "unknown";
    console.log(pc.blue(`Copilot initialized (model: ${model})`));
    return;
  }

  if (type === "assistant.message_delta") {
    const deltaContent = typeof data.deltaContent === "string" ? data.deltaContent : "";
    if (deltaContent) process.stdout.write(pc.green(deltaContent));
    return;
  }

  if (type === "assistant.message") {
    const content = typeof data.content === "string" ? data.content : "";
    if (content) console.log(pc.green(`assistant: ${content}`));

    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const reqRaw of toolRequests) {
      const req = asRecord(reqRaw);
      if (!req) continue;
      const name = typeof req.name === "string" ? req.name : "unknown";
      console.log(pc.yellow(`tool_call: ${name}`));
      if (req.arguments !== undefined) {
        console.log(pc.gray(JSON.stringify(req.arguments, null, 2)));
      }
    }
    return;
  }

  if (type === "tool.execution_complete") {
    const result = asRecord(data.result) ?? {};
    const content = typeof result.content === "string" ? result.content : "";
    const success = data.success !== false;
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (!success) {
      console.log(pc.red(`tool_error [${toolCallId}]: ${content}`));
    } else if (debug) {
      console.log(pc.gray(`tool_result [${toolCallId}]: ${content.slice(0, 200)}`));
    }
    return;
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const premiumRequests = Number(usage.premiumRequests ?? 0);
    const totalApiDurationMs = Number(usage.totalApiDurationMs ?? 0);
    const sessionDurationMs = Number(usage.sessionDurationMs ?? 0);
    const exitCode = Number(parsed.exitCode ?? 0);
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";

    if (exitCode !== 0) {
      console.log(pc.red(`copilot_result: exit_code=${exitCode}`));
    }
    console.log(
      pc.blue(
        `requests=${premiumRequests} api_time=${totalApiDurationMs}ms session_time=${sessionDurationMs}ms${sessionId ? ` session=${sessionId}` : ""}`,
      ),
    );
    return;
  }

  if (debug) {
    console.log(pc.gray(line));
  }
}
