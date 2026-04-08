// @ts-nocheck
/**
 * Self-contained UI parser for Qwen Code transcript rendering.
 *
 * This file is loaded by the Paperclip UI as raw JavaScript via the
 * /api/adapters/:type/ui-parser.js endpoint. It must have ZERO runtime
 * imports, no DOM/Node.js APIs, no side effects, and must be
 * deterministic and error-tolerant.
 */

export function parseStdoutLine(line, ts) {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [{ kind: "stdout", ts: ts, text: line }];
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";

  if (type === "system" && parsed.subtype === "init") {
    return [
      {
        kind: "init",
        ts: ts,
        model: typeof parsed.model === "string" ? parsed.model : "unknown",
        sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
      },
    ];
  }

  if (type === "assistant") {
    const message = parsed.message && typeof parsed.message === "object" ? parsed.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const entries = [];
    for (const blockRaw of content) {
      const block = blockRaw && typeof blockRaw === "object" ? blockRaw : null;
      if (!block) continue;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) entries.push({ kind: "assistant", ts: ts, text: text });
      } else if (blockType === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        if (text) entries.push({ kind: "thinking", ts: ts, text: text });
      } else if (blockType === "tool_use") {
        entries.push({
          kind: "tool_call",
          ts: ts,
          name: typeof block.name === "string" ? block.name : "unknown",
          toolUseId:
            typeof block.id === "string"
              ? block.id
              : typeof block.tool_use_id === "string"
                ? block.tool_use_id
                : undefined,
          input: block.input || {},
        });
      }
    }
    return entries.length > 0 ? entries : [{ kind: "stdout", ts: ts, text: line }];
  }

  if (type === "user") {
    const message = parsed.message && typeof parsed.message === "object" ? parsed.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const entries = [];
    for (const blockRaw of content) {
      const block = blockRaw && typeof blockRaw === "object" ? blockRaw : null;
      if (!block) continue;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) entries.push({ kind: "user", ts: ts, text: text });
      } else if (blockType === "tool_result") {
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const isError = block.is_error === true;
        let text = "";
        if (typeof block.content === "string") {
          text = block.content;
        } else if (Array.isArray(block.content)) {
          const parts = [];
          for (const part of block.content) {
            const p = part && typeof part === "object" ? part : null;
            if (p && typeof p.text === "string") parts.push(p.text);
          }
          text = parts.join("\n");
        }
        entries.push({ kind: "tool_result", ts: ts, toolUseId: toolUseId, content: text, isError: isError });
      }
    }
    if (entries.length > 0) return entries;
  }

  if (type === "result") {
    const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const cachedTokens = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : (typeof usage.cached_tokens === "number" ? usage.cached_tokens : 0);
    const costUsd = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : (typeof parsed.cost_usd === "number" ? parsed.cost_usd : 0);
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    const isError = parsed.is_error === true;
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(errorText).filter(Boolean) : [];
    const text = typeof parsed.response === "string" ? parsed.response : (typeof parsed.result === "string" ? parsed.result : "");
    return [{
      kind: "result",
      ts: ts,
      text: text,
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      cachedTokens: cachedTokens,
      costUsd: costUsd,
      subtype: subtype,
      isError: isError,
      errors: errors,
    }];
  }

  return [{ kind: "stdout", ts: ts, text: line }];
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorText(value) {
  if (typeof value === "string") return value;
  const rec = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}
