import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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
  const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
  const data = asRecord(parsed.data);

  // ── Current format (Claude Code streaming JSON) ───────────────────────────

  // system/init → session initialization
  if (type === "system" && subtype === "init") {
    const model = typeof parsed.model === "string" ? parsed.model : "unknown";
    console.log(pc.blue(`Copilot initialized (model: ${model})`));
    return;
  }

  // assistant → text and tool_use content blocks
  if (type === "assistant") {
    const msg = asRecord(parsed.message);
    if (msg) {
      for (const block of asArray(msg.content)) {
        const b = asRecord(block);
        if (!b) continue;
        const btype = typeof b.type === "string" ? b.type : "";
        if (btype === "text") {
          const text = typeof b.text === "string" ? b.text : "";
          if (text) console.log(pc.green(`assistant: ${text}`));
        } else if (btype === "tool_use") {
          const name = typeof b.name === "string" ? b.name : "unknown";
          console.log(pc.yellow(`tool_call: ${name}`));
          if (b.input !== undefined && debug) {
            console.log(pc.gray(JSON.stringify(b.input, null, 2)));
          }
        }
      }
    }
    return;
  }

  // user → tool_result blocks (only log errors by default)
  if (type === "user") {
    const msg = asRecord(parsed.message);
    if (msg) {
      for (const block of asArray(msg.content)) {
        const b = asRecord(block);
        if (!b) continue;
        if (typeof b.type === "string" && b.type === "tool_result" && b.is_error === true) {
          console.log(pc.red(`tool_error`));
        } else if (debug) {
          console.log(pc.gray(`tool_result`));
        }
      }
    }
    return;
  }

  // result → final run summary (current format)
  if (type === "result" && (subtype === "success" || subtype.startsWith("error"))) {
    const isError = subtype !== "success";
    if (isError) {
      console.log(pc.red(`copilot_result: ${subtype}`));
    }
    const usage = asRecord(parsed.usage) ?? {};
    const inputTokens = Number(usage.input_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? 0);
    if (debug) {
      console.log(pc.gray(`tokens: in=${inputTokens} out=${outputTokens}`));
    }
    return;
  }

  // ── Legacy format ─────────────────────────────────────────────────────────

  // session.tools_updated → model initialization
  if (type === "session.tools_updated" && data) {
    const model = typeof data.model === "string" ? data.model : "unknown";
    console.log(pc.blue(`Copilot initialized (model: ${model})`));
    return;
  }

  // assistant.message → complete assistant response
  if (type === "assistant.message" && data) {
    const content = typeof data.content === "string" ? data.content : "";
    if (content) console.log(pc.green(`assistant: ${content}`));
    return;
  }

  // assistant.tool_request → tool call
  if (type === "assistant.tool_request" && data) {
    const name = typeof data.name === "string" ? data.name : "unknown";
    console.log(pc.yellow(`tool_call: ${name}`));
    if (data.parameters !== undefined && debug) {
      console.log(pc.gray(JSON.stringify(data.parameters, null, 2)));
    }
    return;
  }

  // tool.result → tool execution result
  if (type === "tool.result" && data) {
    const name = typeof data.name === "string" ? data.name : "";
    const isError = data.isError === true;
    if (isError) {
      console.log(pc.red(`tool_error${name ? `: ${name}` : ""}`));
    } else if (debug) {
      console.log(pc.gray(`tool_result${name ? `: ${name}` : ""}`));
    }
    return;
  }

  // result → final run summary (legacy format)
  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const premiumRequests = Number(usage.premiumRequests ?? 0);
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const exitCode = Number(parsed.exitCode ?? 0);
    if (exitCode !== 0) {
      console.log(pc.red(`copilot_result: exit_code=${exitCode}`));
    }
    if (sessionId && debug) {
      console.log(pc.gray(`session: ${sessionId}`));
    }
    console.log(
      pc.blue(`premium_requests: ${Number.isFinite(premiumRequests) ? premiumRequests : 0}`),
    );
    return;
  }

  if (debug) {
    console.log(pc.gray(line));
  }
}
