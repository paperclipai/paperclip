import pc from "picocolors";
import { parseEveStdoutLine } from "../ui/parse-stdout.js";

export function printEveStreamEvent(raw: string, debug: boolean): void {
  const entries = parseEveStdoutLine(raw, new Date().toISOString());
  for (const entry of entries) {
    switch (entry.kind) {
      case "assistant":
        if (entry.delta) {
          if (debug) console.log(pc.green(`assistant Δ: ${entry.text}`));
          break;
        }
        console.log(pc.green(`assistant: ${entry.text}`));
        break;
      case "thinking":
        if (entry.delta && !debug) break;
        console.log(pc.gray(`thinking: ${entry.text}`));
        break;
      case "user":
        console.log(pc.gray(`user: ${entry.text}`));
        break;
      case "tool_call":
        console.log(pc.yellow(`tool_call: ${entry.name}`));
        break;
      case "tool_result":
        console.log((entry.isError ? pc.red : pc.cyan)(entry.content || "tool result"));
        break;
      case "result":
        console.log(
          (entry.isError ? pc.red : pc.blue)(
            `result: ${entry.subtype}${entry.text ? ` - ${entry.text}` : ""}${
              entry.errors.length > 0 ? ` (${entry.errors.join("; ")})` : ""
            }`,
          ),
        );
        break;
      case "stderr":
        console.error(pc.red(entry.text));
        break;
      case "system":
        console.log(pc.blue(entry.text));
        break;
      case "init":
        console.log(pc.blue(`Eve session ${entry.sessionId}${entry.model ? ` (${entry.model})` : ""}`));
        break;
      case "stdout":
        if (debug) console.log(entry.text);
        break;
      default:
        console.log("text" in entry ? entry.text : JSON.stringify(entry));
    }
  }
}
