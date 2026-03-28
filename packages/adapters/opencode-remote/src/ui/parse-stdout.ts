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

/**
 * Parse OpenCode remote response JSON into transcript entries.
 *
 * Unlike the local adapter which receives JSONL lines from stdout,
 * the remote adapter receives the full response as a single JSON object.
 * We parse the response shape: { info, parts[] } where parts contain
 * step-start, text, tool-use, step-finish entries.
 */
export function parseOpenCodeRemoteStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  // The remote adapter logs the full response as a single JSON line
  const info = asRecord(parsed.info);
  const parts = Array.isArray(parsed.parts) ? parsed.parts : null;

  // If this is the full response shape (has info + parts), parse as response
  if (info && parts) {
    const entries: TranscriptEntry[] = [];

    const sessionId = asString(info.sessionID);
    const modelID = asString(info.modelID);
    if (sessionId || modelID) {
      entries.push({
        kind: "init",
        ts,
        model: modelID || "unknown",
        sessionId: sessionId || "unknown",
      });
    }

    // Check for error in info
    const error = asRecord(info.error);
    if (error) {
      const errorData = asRecord(error.data);
      const errorMsg = asString(errorData?.message) || asString(error.name) || "Unknown error";
      entries.push({ kind: "stderr", ts, text: errorMsg });
      return entries;
    }

    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part) continue;

      const type = asString(part.type);

      if (type === "step-start") {
        entries.push({ kind: "system", ts, text: "step started" });
        continue;
      }

      if (type === "text") {
        const text = asString(part.text).trim();
        if (text) entries.push({ kind: "assistant", ts, text });
        continue;
      }

      if (type === "tool-use" || type === "tool_use") {
        const toolName = asString(part.tool, "tool");
        const state = asRecord(part.state);
        entries.push({
          kind: "tool_call",
          ts,
          name: toolName,
          toolUseId: asString(part.callID) || asString(part.id) || undefined,
          input: state?.input ?? {},
        });

        const status = asString(state?.status);
        if (status === "completed" || status === "error") {
          const output = asString(state?.output) || asString(state?.error) || `${toolName} ${status}`;
          entries.push({
            kind: "tool_result",
            ts,
            toolUseId: asString(part.callID) || asString(part.id, toolName),
            content: output,
            isError: status === "error",
          });
        }
        continue;
      }

      if (type === "step-finish" || type === "step_finish") {
        const tokens = asRecord(part.tokens);
        const cache = asRecord(tokens?.cache);
        const reason = asString(part.reason, "step");
        entries.push({
          kind: "result",
          ts,
          text: reason,
          inputTokens: asNumber(tokens?.input, 0),
          outputTokens: asNumber(tokens?.output, 0) + asNumber(tokens?.reasoning, 0),
          cachedTokens: asNumber(cache?.read, 0),
          costUsd: asNumber(part.cost, 0),
          subtype: reason,
          isError: false,
          errors: [],
        });
        continue;
      }
    }

    // If we got info tokens but no step-finish, add a result entry
    if (entries.length > 0 && !entries.some((e) => e.kind === "result")) {
      const tokens = asRecord(info.tokens);
      const cache = asRecord(tokens?.cache);
      if (tokens) {
        entries.push({
          kind: "result",
          ts,
          text: asString(info.finish, "complete"),
          inputTokens: asNumber(tokens.input, 0),
          outputTokens: asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0),
          cachedTokens: asNumber(cache?.read, 0),
          costUsd: asNumber(info.cost, 0),
          subtype: "complete",
          isError: false,
          errors: [],
        });
      }
    }

    return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
  }

  // Fallback: treat as raw stdout
  return [{ kind: "stdout", ts, text: line }];
}
