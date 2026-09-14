"use strict";

function stripAnsi(text) {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

// Pull the reasoning text out of a `reasoning.available` event payload.
// The exact field name is defined by the external Hermes gateway, so this
// checks the plausible field names (mirroring the fallback chain used by
// extractOutput() in gateway/server/execute.ts) and recurses one level into
// nested `data` / `payload` records.
function extractDirectReasoningText(data) {
  return (
    asString(data.reasoning).trim() ||
    asString(data.reasoning_text).trim() ||
    asString(data.thinking).trim() ||
    asString(data.text).trim() ||
    asString(data.summary).trim() ||
    asString(data.content).trim()
  );
}

function extractReasoningText(data) {
  if (!data) return "";
  const direct = extractDirectReasoningText(data);
  if (direct) return stripAnsi(direct);
  const nested = asRecord(data.data) || asRecord(data.payload);
  const nestedDirect = nested ? extractDirectReasoningText(nested) : "";
  return nestedDirect ? stripAnsi(nestedDirect) : "";
}

function parseStdoutLine(line, ts) {
  const cleaned = stripAnsi(line);
  const trimmed = cleaned.trim();
  if (!trimmed) return [];

  const eventMatch = trimmed.match(/^\[hermes-gateway:event\]\s+run=([^\s]+)\s+event=([^\s]+)\s+data=(.*)$/s);
  if (eventMatch) {
    const eventName = eventMatch[2];
    const data = asRecord(safeJsonParse(eventMatch[3]));
    if (eventName === "message.delta") {
      const delta = asString(data && data.delta) || asString(data && data.text_delta);
      return delta ? [{ kind: "assistant", ts, text: stripAnsi(delta), delta: true }] : [];
    }
    if (eventName === "run.failed" || eventName === "run.error") {
      const message = asString(data && data.error) || asString(data && data.message) || "Hermes run failed";
      return [{ kind: "stderr", ts, text: message }];
    }
    if (eventName === "reasoning.available") {
      const reasoning = extractReasoningText(data);
      return [{ kind: "thinking", ts, text: reasoning || "Hermes reasoning available" }];
    }
    return [{ kind: "system", ts, text: `Hermes event: ${eventName}` }];
  }

  if (trimmed.startsWith("[hermes-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[hermes-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: cleaned }];
}

module.exports = { parseStdoutLine };
