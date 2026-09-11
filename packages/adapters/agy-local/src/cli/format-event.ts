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

export function printAgyStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const eventType = asString(parsed.event);

  if (eventType === "init") {
    const cid = asString(parsed.conversation_id);
    console.log(pc.blue(`init${cid ? ` (conversation: ${cid})` : ""}`));
    return;
  }

  if (eventType === "step_update") {
    const stepUpdate = asRecord(parsed.step_update);
    if (!stepUpdate) return;

    const stepType = asString(stepUpdate.step_type);

    if (stepType === "agent_response") {
      const textDelta = asString(stepUpdate.text_delta);
      if (textDelta) {
        process.stdout.write(pc.green(textDelta));
      }
      return;
    }

    if (stepType === "tool") {
      const toolName = asString(stepUpdate.tool_name, "tool");
      const state = asString(stepUpdate.state);
      const toolInfo = asRecord(stepUpdate.tool_info) ?? {};

      if (state === "ACTIVE") {
        console.log(pc.yellow(`\ntool_call: ${toolName}`));
      } else if (state === "DONE") {
        const output = asString(toolInfo.output);
        if (output) console.log(pc.gray(`tool_result (${toolName}): ${output}`));
      } else if (state === "ERROR") {
        const errObj = asRecord(toolInfo.error);
        const msg = asString(errObj?.message) || "Tool error";
        console.log(pc.red(`tool_error (${toolName}): ${msg}`));
      }
      return;
    }

    if (stepType === "user_input") {
      console.log(pc.cyan(`\nuser turn started`));
      return;
    }
  }

  if (eventType === "result") {
    const resultObj = asRecord(parsed.result);
    if (!resultObj) return;

    const status = asString(resultObj.status, "SUCCESS");
    const duration = asNumber(resultObj.duration_seconds, 0);
    const usage = asRecord(resultObj.usage);
    const input = asNumber(usage?.input_tokens, 0);
    const output = asNumber(usage?.output_tokens, 0);
    const cached = asNumber(usage?.cache_read_tokens, 0);

    const isError = status === "ERROR";
    console.log(
      (isError ? pc.red : pc.blue)(
        `\nresult: status=${status} duration=${duration.toFixed(2)}s in=${input} out=${output} cached=${cached}`,
      ),
    );
    return;
  }

  console.log(line);
}
