import { parseClaudeCodeJsonl } from "../server/parse.js";

export function parseClaudeCodeStdoutLine(line: string) {
  return parseClaudeCodeJsonl(line);
}
