import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { ZAI_STDOUT_PREFIX, type ZaiStdoutEvent } from "../shared/types.js";

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

function parseZaiEvent(rawJson: string): ZaiStdoutEvent | null {
  const parsed = asRecord(safeJsonParse(rawJson));
  if (!parsed) return null;
  const kind = typeof parsed.kind === "string" ? parsed.kind : "";
  switch (kind) {
    case "assistant_delta":
      if (typeof parsed.text === "string") return { kind: "assistant_delta", text: parsed.text };
      return null;
    case "assistant_final":
      if (typeof parsed.text === "string") return { kind: "assistant_final", text: parsed.text };
      return null;
    case "tool_call":
      if (typeof parsed.id === "string" && typeof parsed.name === "string") {
        return { kind: "tool_call", id: parsed.id, name: parsed.name, input: parsed.input ?? {} };
      }
      return null;
    case "usage":
      return {
        kind: "usage",
        inputTokens: typeof parsed.inputTokens === "number" ? parsed.inputTokens : 0,
        outputTokens: typeof parsed.outputTokens === "number" ? parsed.outputTokens : 0,
        ...(typeof parsed.cachedTokens === "number" ? { cachedTokens: parsed.cachedTokens } : {}),
        ...(typeof parsed.costUsd === "number" ? { costUsd: parsed.costUsd } : {}),
        ...(parsed.billingType === "api" || parsed.billingType === "subscription_included"
          ? { billingType: parsed.billingType }
          : {}),
      };
    case "model":
      if (typeof parsed.model === "string" && typeof parsed.sessionId === "string") {
        return { kind: "model", model: parsed.model, sessionId: parsed.sessionId };
      }
      return null;
    case "error":
      if (typeof parsed.message === "string") return { kind: "error", message: parsed.message };
      return null;
    default:
      return null;
  }
}

export function parseZaiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith(ZAI_STDOUT_PREFIX)) {
    const rest = trimmed.slice(ZAI_STDOUT_PREFIX.length).trim();
    const event = parseZaiEvent(rest);
    if (!event) return [];
    return renderEvent(event, ts);
  }

  if (trimmed.startsWith("[zai]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[zai\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

function renderEvent(event: ZaiStdoutEvent, ts: string): TranscriptEntry[] {
  switch (event.kind) {
    case "assistant_delta":
      return [{ kind: "assistant", ts, text: event.text, delta: true }];
    case "assistant_final":
      // Emit as non-delta final message so UI can reconcile.
      return [{ kind: "assistant", ts, text: event.text }];
    case "tool_call":
      return [{ kind: "tool_call", ts, name: event.name, input: event.input, toolUseId: event.id }];
    case "usage":
      return [
        {
          kind: "result",
          ts,
          // costUsd here is the Z.AI pay-as-you-go reference cost; the run
          // may have been billed via Coding Plan subscription (see
          // event.billingType). Paperclip aggregates costUsd across runs
          // for management reporting regardless of the actual billing channel.
          text: "",
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedTokens: event.cachedTokens ?? 0,
          costUsd: event.costUsd ?? 0,
          subtype: "usage",
          isError: false,
          errors: [],
        },
      ];
    case "model":
      return [{ kind: "init", ts, model: event.model, sessionId: event.sessionId }];
    case "error":
      return [{ kind: "stderr", ts, text: event.message }];
    default:
      return [];
  }
}
