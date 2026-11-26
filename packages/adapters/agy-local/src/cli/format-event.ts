import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printAgyStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = asString(parsed.event);
  if (type === "init") {
    const init = asRecord(parsed.init) ?? {};
    console.log(pc.blue(`agy init: model=${asString(init.model, "unknown")} conversation=${asString(parsed.conversation_id)}`));
    return;
  }
  if (type === "step_update") {
    const step = asRecord(parsed.step_update) ?? {};
    if (asString(step.step_type) === "tool") {
      const info = asRecord(step.tool_info) ?? {};
      console.log(pc.yellow(`tool: ${asString(info.name, asString(step.tool_name, "tool"))}`));
    }
    return;
  }
  if (type === "result") {
    const result = asRecord(parsed.result) ?? {};
    const response = asString(result.response).trim();
    if (response) console.log(pc.green(`assistant: ${response}`));
    const usage = asRecord(result.usage) ?? {};
    const status = asString(result.status, "SUCCESS");
    const text = `result: ${status} in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0}`;
    console.log(status === "SUCCESS" ? pc.blue(text) : pc.red(text));
    return;
  }
  if (debug) console.log(pc.gray(line));
}
