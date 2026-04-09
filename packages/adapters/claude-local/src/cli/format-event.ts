import pc from "picocolors";

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const obj = value as Record<string, unknown>;
  const message =
    (typeof obj.message === "string" && obj.message) ||
    (typeof obj.error === "string" && obj.error) ||
    (typeof obj.code === "string" && obj.code) ||
    "";
  if (message) return message;
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

function printToolResult(block: Record<string, unknown>): void {
  const isError = block.is_error === true;
  let text = "";
  if (typeof block.content === "string") {
    text = block.content;
  } else if (Array.isArray(block.content)) {
    const parts: string[] = [];
    for (const part of block.content) {
      if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") parts.push(record.text);
    }
    text = parts.join("\n");
  }

  console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
  if (text) {
    console.log((isError ? pc.red : pc.gray)(text));
  }
}

export function printClaudeStreamEvent(raw: string, debug: boolean): void {
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

  if (type === "system" && parsed.subtype === "init") {
    const model = typeof parsed.model === "string" ? parsed.model : "unknown";
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "";
    console.log(pc.blue(`Claude initialized (model: ${model}${sessionId ? `, session: ${sessionId}` : ""})`));
    return;
  }

  if (type === "assistant") {
    const message =
      typeof parsed.message === "object" && parsed.message !== null && !Array.isArray(parsed.message)
        ? (parsed.message as Record<string, unknown>)
        : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const blockRaw of content) {
      if (typeof blockRaw !== "object" || blockRaw === null || Array.isArray(blockRaw)) continue;
      const block = blockRaw as Record<string, unknown>;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) console.log(pc.green(`assistant: ${text}`));
      } else if (blockType === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        if (text) console.log(pc.gray(`thinking: ${text}`));
      } else if (blockType === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "unknown";
        console.log(pc.yellow(`tool_call: ${name}`));
        if (block.input !== undefined) {
          console.log(pc.gray(JSON.stringify(block.input, null, 2)));
        }
      }
    }
    return;
  }

  if (type === "user") {
    const message =
      typeof parsed.message === "object" && parsed.message !== null && !Array.isArray(parsed.message)
        ? (parsed.message as Record<string, unknown>)
        : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const blockRaw of content) {
      if (typeof blockRaw !== "object" || blockRaw === null || Array.isArray(blockRaw)) continue;
      const block = blockRaw as Record<string, unknown>;
      if (typeof block.type === "string" && block.type === "tool_result") {
        printToolResult(block);
      }
    }
    return;
  }

  if (type === "result") {
    const usage =
      typeof parsed.usage === "object" && parsed.usage !== null && !Array.isArray(parsed.usage)
        ? (parsed.usage as Record<string, unknown>)
        : {};
    const input = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    const cached = Number(usage.cache_read_input_tokens ?? 0);
    const cost = Number(parsed.total_cost_usd ?? 0);
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    const isError = parsed.is_error === true;
    const resultText = typeof parsed.result === "string" ? parsed.result : "";
    if (resultText) {
      console.log(pc.green("result:"));
      console.log(resultText);
    }
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(asErrorText).filter(Boolean) : [];
    if (subtype.startsWith("error") || isError || errors.length > 0) {
      console.log(pc.red(`claude_result: subtype=${subtype || "unknown"} is_error=${isError ? "true" : "false"}`));
      if (errors.length > 0) {
        console.log(pc.red(`claude_errors: ${errors.join(" | ")}`));
      }
    }
    console.log(
      pc.blue(
        `tokens: in=${Number.isFinite(input) ? input : 0} out=${Number.isFinite(output) ? output : 0} cached=${Number.isFinite(cached) ? cached : 0} cost=$${Number.isFinite(cost) ? cost.toFixed(6) : "0.000000"}`,
      ),
    );
    return;
  }

  if (debug) {
    console.log(pc.gray(line));
  }
}
