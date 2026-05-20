import type { TranscriptEntry } from "@paperclipai/adapter-utils";

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

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseResultText(resultRaw: unknown): string {
  if (typeof resultRaw === "string") return resultRaw;
  const result = asRecord(resultRaw);
  if (!result) return stringifyUnknown(resultRaw);
  return (
    asString(result.detailedContent) ||
    asString(result.content) ||
    asString(result.message) ||
    asString(result.error) ||
    stringifyUnknown(result)
  );
}

export function createCopilotStdoutParser() {
  let initEmitted = false;
  let outputTokens = 0;
  let model = "";

  return {
    reset() {
      initEmitted = false;
      outputTokens = 0;
      model = "";
    },
    parseLine(line: string, ts: string): TranscriptEntry[] {
      const parsed = asRecord(safeJsonParse(line));
      if (!parsed) return [{ kind: "stdout", ts, text: line }];

      const type = asString(parsed.type);
      const data = asRecord(parsed.data);

      if (type === "session.tools_updated") {
        model = asString(data?.model, model);
        return [];
      }

      if (type === "user.message") {
        const text = asString(data?.content).trim();
        return text ? [{ kind: "user", ts, text }] : [];
      }

      if (type === "assistant.message") {
        const text = asString(data?.content).trim();
        outputTokens += asNumber(data?.outputTokens, 0);
        return text ? [{ kind: "assistant", ts, text }] : [];
      }

      if (type === "assistant.reasoning") {
        const text = asString(data?.content).trim();
        return text ? [{ kind: "thinking", ts, text }] : [];
      }

      if (type === "tool.execution_start") {
        return [{
          kind: "tool_call",
          ts,
          name: asString(data?.toolName, "tool"),
          toolUseId: asString(data?.toolCallId, "tool_call"),
          input: data?.arguments ?? {},
        }];
      }

      if (type === "tool.execution_complete") {
        return [{
          kind: "tool_result",
          ts,
          toolUseId: asString(data?.toolCallId, "tool_call"),
          content: parseResultText(data?.result),
          isError: data?.success === false,
        }];
      }

      if (type === "result") {
        const sessionId =
          asString(parsed.sessionId) ||
          asString(parsed.session_id);
        const exitCode = asNumber(parsed.exitCode, 0);
        const usage = asRecord(parsed.usage);
        const premiumRequests = usage && typeof usage.premiumRequests === "number"
          ? `premiumRequests=${usage.premiumRequests}`
          : "";
        const resultEntry: TranscriptEntry = {
          kind: "result",
          ts,
          text: premiumRequests,
          inputTokens: 0,
          outputTokens,
          cachedTokens: 0,
          costUsd: 0,
          subtype: `exit_code=${exitCode}`,
          isError: exitCode !== 0,
          errors: [],
        };
        if (!initEmitted && sessionId) {
          initEmitted = true;
          return [
            { kind: "init", ts, model: model || "copilot", sessionId },
            resultEntry,
          ];
        }
        return [resultEntry];
      }

      return [];
    },
  };
}

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return createCopilotStdoutParser().parseLine(line, ts);
}
