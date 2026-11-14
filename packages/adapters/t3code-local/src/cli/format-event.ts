import pc from "picocolors";
import { parseT3RunResult } from "../server/parse.js";

export function printT3CodeStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const result = parseT3RunResult(line);
  if (!result) {
    console.log(line);
    return;
  }
  if (result.reply) console.log(pc.green(`assistant: ${result.reply}`));
  if (result.error) console.log(pc.red(`error: ${result.error}`));
  console.log(pc.blue(`T3 Code thread ${result.threadId}: ${result.status}`));
}
