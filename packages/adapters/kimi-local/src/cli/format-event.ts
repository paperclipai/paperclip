import pc from "picocolors";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function formatKimiStreamEvent(line: string, debug: boolean): void {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    if (debug) console.log(pc.gray(`[raw] ${line}`));
    return;
  }

  const role = asString(parsed.role);

  // Assistant message
  if (role === "assistant") {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    for (const block of content) {
      const blockRec = asRecord(block);
      if (!blockRec) continue;

      const blockType = asString(blockRec.type);

      if (blockType === "text") {
        const text = asString(blockRec.text);
        if (text) console.log(pc.green(text));
      } else if (blockType === "think") {
        const think = asString(blockRec.think);
        if (think) console.log(pc.cyan(`[thinking] ${think}`));
      } else if (blockType === "tool_use") {
        const name = asString(blockRec.name);
        if (name) {
          const input = JSON.stringify(blockRec.input ?? {});
          console.log(pc.yellow(`[tool: ${name}] ${input}`));
        }
      }
    }
    return;
  }

  // User message
  if (role === "user") {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    for (const block of content) {
      const blockRec = asRecord(block);
      if (!blockRec) continue;

      const blockType = asString(blockRec.type);

      if (blockType === "text") {
        const text = asString(blockRec.text);
        if (text) console.log(pc.blue(`[user] ${text}`));
      } else if (blockType === "tool_result") {
        const isError = blockRec.is_error === true;
        let text = "";
        if (typeof blockRec.content === "string") {
          text = blockRec.content;
        }
        if (isError) {
          console.log(pc.red(`[tool result] ${text}`));
        } else {
          console.log(pc.gray(`[tool result] ${text}`));
        }
      }
    }
    return;
  }

  // Result
  if (parsed.type === "result" || parsed.done === true) {
    const usage = asRecord(parsed.usage) ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cost = parsed.total_cost_usd;

    console.log(pc.dim("─".repeat(40)));
    console.log(pc.dim(`Tokens: ${inputTokens} in / ${outputTokens} out`));
    if (typeof cost === "number") {
      console.log(pc.dim(`Cost: $${cost.toFixed(4)}`));
    }
    return;
  }

  // Unknown format
  if (debug) {
    console.log(pc.gray(`[debug] ${line}`));
  }
}
