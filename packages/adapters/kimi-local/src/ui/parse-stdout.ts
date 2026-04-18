import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseKimiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const role = asString(parsed.role);

  // Assistant message
  if (role === "assistant") {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    const entries: TranscriptEntry[] = [];

    for (const block of content) {
      const blockRec = asRecord(block);
      if (!blockRec) continue;

      const blockType = asString(blockRec.type);

      if (blockType === "text") {
        const text = asString(blockRec.text);
        if (text) entries.push({ kind: "assistant", ts, text });
      } else if (blockType === "think") {
        const think = asString(blockRec.think);
        if (think) entries.push({ kind: "thinking", ts, text: think });
      } else if (blockType === "tool_use") {
        const name = asString(blockRec.name);
        const input = blockRec.input ?? {};
        const toolUseId = asString(blockRec.id) || asString(blockRec.tool_use_id);
        if (name) {
          entries.push({
            kind: "tool_call",
            ts,
            name,
            toolUseId,
            input,
          });
        }
      }
    }

    return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
  }

  // User message
  if (role === "user") {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    const entries: TranscriptEntry[] = [];

    for (const block of content) {
      const blockRec = asRecord(block);
      if (!blockRec) continue;

      const blockType = asString(blockRec.type);

      if (blockType === "text") {
        const text = asString(blockRec.text);
        if (text) entries.push({ kind: "user", ts, text });
      } else if (blockType === "tool_result") {
        const toolUseId = asString(blockRec.tool_use_id);
        const isError = blockRec.is_error === true;
        let text = "";

        if (typeof blockRec.content === "string") {
          text = blockRec.content;
        } else if (Array.isArray(blockRec.content)) {
          const parts: string[] = [];
          for (const part of blockRec.content) {
            const p = asRecord(part);
            if (p && typeof p.text === "string") parts.push(p.text);
          }
          text = parts.join("\n");
        }

        entries.push({ kind: "tool_result", ts, toolUseId, content: text, isError });
      }
    }

    return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
  }

  // System/init message
  if (role === "system" || parsed.type === "init") {
    const model = asString(parsed.model);
    const sessionId = asString(parsed.session_id);
    if (model || sessionId) {
      return [{ kind: "init", ts, model: model || "unknown", sessionId: sessionId || "" }];
    }
  }

  // Result message
  if (parsed.type === "result" || parsed.done === true) {
    const usage = asRecord(parsed.usage) ?? {};
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const cachedTokens = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
    const costUsd = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0;
    const subtype = asString(parsed.subtype);
    const isError = parsed.is_error === true;
    const text = asString(parsed.result);

    const errors: string[] = [];
    if (Array.isArray(parsed.errors)) {
      for (const err of parsed.errors) {
        if (typeof err === "string") {
          errors.push(err);
        } else {
          const errRec = asRecord(err);
          if (errRec) {
            const msg = asString(errRec.message) || asString(errRec.error) || asString(errRec.code);
            if (msg) errors.push(msg);
          }
        }
      }
    }

    return [{
      kind: "result",
      ts,
      text,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      subtype,
      isError,
      errors,
    }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
