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

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Format OpenCode remote response for terminal output.
 * The remote adapter logs the full response as a single JSON object.
 */
export function printOpenCodeRemoteStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const info = asRecord(parsed.info);
  const parts = Array.isArray(parsed.parts) ? parsed.parts : null;

  if (info && parts) {
    const sessionId = asString(info.sessionID);
    const modelID = asString(info.modelID);
    if (sessionId || modelID) {
      console.log(pc.blue(`session: ${sessionId} model: ${modelID}`));
    }

    const error = asRecord(info.error);
    if (error) {
      const errorData = asRecord(error.data);
      const msg = asString(errorData?.message) || asString(error.name) || "Unknown error";
      console.log(pc.red(`error: ${msg}`));
      return;
    }

    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part) continue;

      const type = asString(part.type);

      if (type === "step-start") {
        console.log(pc.blue("step started"));
        continue;
      }

      if (type === "text") {
        const text = asString(part.text).trim();
        if (text) console.log(pc.green(`assistant: ${text}`));
        continue;
      }

      if (type === "tool-use" || type === "tool_use") {
        const toolName = asString(part.tool, "tool");
        const state = asRecord(part.state);
        const status = asString(state?.status);
        console.log(pc.yellow(`tool_call: ${toolName}`));
        if (status) {
          const output = (asString(state?.output) || asString(state?.error)).trim();
          const isError = status === "error";
          console.log((isError ? pc.red : pc.gray)(`tool_result status=${status}`));
          if (output) console.log((isError ? pc.red : pc.gray)(output));
        }
        continue;
      }

      if (type === "step-finish" || type === "step_finish") {
        const tokens = asRecord(part.tokens);
        const cache = asRecord(tokens?.cache);
        const input = asNumber(tokens?.input, 0);
        const output = asNumber(tokens?.output, 0) + asNumber(tokens?.reasoning, 0);
        const cached = asNumber(cache?.read, 0);
        const cost = asNumber(part.cost, 0);
        const reason = asString(part.reason, "step");
        console.log(pc.blue(`step finished: reason=${reason}`));
        console.log(
          pc.blue(
            `tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`,
          ),
        );
        continue;
      }
    }

    return;
  }

  console.log(line);
}
