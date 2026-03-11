import pc from "picocolors";

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

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
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

function printItemStarted(item: Record<string, unknown>): boolean {
  const itemType = asString(item.type);
  if (itemType === "command_execution") {
    const command = asString(item.command);
    console.log(pc.yellow("tool_call: command_execution"));
    if (command) console.log(pc.gray(command));
    return true;
  }

  if (itemType === "tool_use") {
    const name = asString(item.name, "unknown");
    console.log(pc.yellow(`tool_call: ${name}`));
    if (item.input !== undefined) {
      try {
        console.log(pc.gray(JSON.stringify(item.input, null, 2)));
      } catch {
        console.log(pc.gray(String(item.input)));
      }
    }
    return true;
  }

  return false;
}

function printItemCompleted(item: Record<string, unknown>): boolean {
  const itemType = asString(item.type);

  if (itemType === "agent_message") {
    const text = asString(item.text);
    if (text) console.log(pc.green(`assistant: ${text}`));
    return true;
  }

  if (itemType === "reasoning") {
    const text = asString(item.text);
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return true;
  }

  if (itemType === "tool_use") {
    const name = asString(item.name, "unknown");
    console.log(pc.yellow(`tool_call: ${name}`));
    if (item.input !== undefined) {
      try {
        console.log(pc.gray(JSON.stringify(item.input, null, 2)));
      } catch {
        console.log(pc.gray(String(item.input)));
      }
    }
    return true;
  }

  if (itemType === "command_execution") {
    const command = asString(item.command);
    const status = asString(item.status);
    const exitCode = typeof item.exit_code === "number" && Number.isFinite(item.exit_code) ? item.exit_code : null;
    const output = asString(item.aggregated_output).replace(/\s+$/, "");
    const isError =
      (exitCode !== null && exitCode !== 0) ||
      status === "failed" ||
      status === "errored" ||
      status === "error" ||
      status === "cancelled";

    const summaryParts = [
      "tool_result: command_execution",
      command ? `command="${command}"` : "",
      status ? `status=${status}` : "",
      exitCode !== null ? `exit_code=${exitCode}` : "",
    ].filter(Boolean);
    console.log((isError ? pc.red : pc.cyan)(summaryParts.join(" ")));
    if (output) console.log((isError ? pc.red : pc.gray)(output));
    return true;
  }

  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const entries = changes
      .map((changeRaw) => asRecord(changeRaw))
      .filter((change): change is Record<string, unknown> => Boolean(change))
      .map((change) => {
        const kind = asString(change.kind, "update");
        const path = asString(change.path, "unknown");
        return `${kind} ${path}`;
      });
    const preview = entries.length > 0 ? entries.slice(0, 6).join(", ") : "none";
    const more = entries.length > 6 ? ` (+${entries.length - 6} more)` : "";
    console.log(pc.cyan(`file_change: ${preview}${more}`));
    return true;
  }

  if (itemType === "error") {
    const message = errorText(item.message ?? item.error ?? item);
    if (message) console.log(pc.red(`error: ${message}`));
    return true;
  }

  if (itemType === "tool_result") {
    const isError = item.is_error === true || asString(item.status) === "error";
    const text = asString(item.content) || asString(item.result) || asString(item.output);
    console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
    if (text) console.log((isError ? pc.red : pc.gray)(text));
    return true;
  }

  return false;
}

export function printCodexStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);

  if (type === "thread.started") {
    const threadId = asString(parsed.thread_id);
    const model = asString(parsed.model);
    const details = [threadId ? `session: ${threadId}` : "", model ? `model: ${model}` : ""].filter(Boolean).join(", ");
    console.log(pc.blue(`Codex thread started${details ? ` (${details})` : ""}`));
    return;
  }

  if (type === "turn.started") {
    console.log(pc.blue("turn started"));
    return;
  }

  if (type === "item.started" || type === "item.completed") {
    const item = asRecord(parsed.item);
    if (item) {
      const handled =
        type === "item.started"
          ? printItemStarted(item)
          : printItemCompleted(item);
      if (!handled) {
        const itemType = asString(item.type, "unknown");
        const id = asString(item.id);
        const status = asString(item.status);
        const meta = [id ? `id=${id}` : "", status ? `status=${status}` : ""].filter(Boolean).join(" ");
        console.log(pc.gray(`${type}: ${itemType}${meta ? ` (${meta})` : ""}`));
      }
    } else {
      console.log(pc.gray(type));
    }
    return;
  }

  if (type === "turn.completed") {
    const usage = asRecord(parsed.usage);
    const input = asNumber(usage?.input_tokens);
    const output = asNumber(usage?.output_tokens);
    const cached = asNumber(usage?.cached_input_tokens, asNumber(usage?.cache_read_input_tokens));
    const cost = asNumber(parsed.total_cost_usd);
    const isError = parsed.is_error === true;
    const subtype = asString(parsed.subtype);
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(errorText).filter(Boolean) : [];

    console.log(
      pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`),
    );
    if (subtype || isError || errors.length > 0) {
      console.log(
        pc.red(`result: subtype=${subtype || "unknown"} is_error=${isError ? "true" : "false"}`),
      );
      if (errors.length > 0) console.log(pc.red(`errors: ${errors.join(" | ")}`));
    }
    return;
  }

  if (type === "turn.failed") {
    const usage = asRecord(parsed.usage);
    const input = asNumber(usage?.input_tokens);
    const output = asNumber(usage?.output_tokens);
    const cached = asNumber(usage?.cached_input_tokens, asNumber(usage?.cache_read_input_tokens));
    const message = errorText(parsed.error ?? parsed.message);
    console.log(pc.red(`turn failed${message ? `: ${message}` : ""}`));
    console.log(pc.blue(`tokens: in=${input} out=${output} cached=${cached}`));
    return;
  }

  if (type === "error") {
    const message = errorText(parsed.message ?? parsed.error ?? parsed);
    if (message) console.log(pc.red(`error: ${message}`));
    return;
  }

  console.log(line);
}
