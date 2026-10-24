import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function printMuseCodeStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    console.log(line);
    return;
  }
  if (!parsed) {
    console.log(line);
    return;
  }

  const payloadType = asText(parsed.payload_type);
  const payload = asRecord(parsed.payload) ?? {};

  if (payloadType === "run.model.configured") {
    const stream = asRecord(parsed.stream);
    console.log(pc.blue(`muse session ${asText(stream?.id)} · ${asText(payload.model_id)}`));
    return;
  }

  if (payloadType === "run.output.delta") {
    const text = asText(payload.text);
    if (text) console.log(pc.green(text));
    return;
  }

  if (payloadType === "task.lifecycle.proposed") {
    const event = asRecord(payload.event) ?? {};
    const taskKind = asText(event.task_kind);
    if (taskKind.startsWith("tool.")) console.log(pc.yellow(`tool_call: ${taskKind.slice("tool.".length)}`));
    return;
  }

  if (payloadType === "tool.result") {
    const facts = asRecord(payload.correlation_facts) ?? {};
    const failed = asText(facts.outcome) && asText(facts.outcome) !== "success";
    const text = asText(payload.text).trim();
    if (text) console.log(failed ? pc.red(text) : pc.gray(text));
    return;
  }

  if (payloadType.startsWith("run.terminal.") || payload.kind === "run_terminal") {
    const terminal = asText(payload.terminal);
    const text = asText(payload.text) || asText(payload.reason);
    console.log(terminal === "completed" ? pc.green(`✓ ${text}`.trim()) : pc.red(`✗ ${terminal}: ${text}`.trim()));
    return;
  }

  if (debug) console.log(pc.gray(line));
}
