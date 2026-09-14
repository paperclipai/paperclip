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

export function printJcodeStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);

  switch (type) {
    case "start":
      console.log(pc.blue("jcode agent started"));
      return;

    case "text_delta": {
      const delta = asString(parsed.delta, "");
      if (delta) console.log(pc.green(delta));
      return;
    }

    case "tool_start": {
      const toolName = asString(parsed.tool_name, "tool");
      const args = parsed.args;
      console.log(pc.yellow(`tool: ${toolName}`));
      if (args !== undefined) {
        try {
          console.log(pc.gray(JSON.stringify(args, null, 2)));
        } catch {
          console.log(pc.gray(String(args)));
        }
      }
      return;
    }

    case "tool_exec": {
      const result = parsed.result;
      const isError = parsed.is_error === true;
      const output = typeof result === "string" ? result : JSON.stringify(result);
      if (output) {
        console.log((isError ? pc.red : pc.gray)(output));
      }
      return;
    }

    case "tokens":
      return;

    case "done": {
      const model = asString(parsed.model, "");
      const text = asString(parsed.text, "");
      if (text) console.log(pc.green(text));
      if (model) console.log(pc.blue(`Done (${model})`));
      return;
    }

    case "error": {
      const message = asString(parsed.message, "");
      if (message) console.log(pc.red(`error: ${message}`));
      return;
    }

    default:
      console.log(line);
  }
}
