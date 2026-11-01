import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseT3RunResult } from "../server/parse.js";

export function parseT3CodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const result = parseT3RunResult(line);
  if (!result) return [{ kind: "stdout", ts, text: line }];
  const entries: TranscriptEntry[] = [];
  if (result.reply) entries.push({ kind: "assistant", ts, text: result.reply });
  if (result.error) entries.push({ kind: "stderr", ts, text: result.error });
  entries.push({ kind: "system", ts, text: `T3 Code thread ${result.threadId}: ${result.status}` });
  return entries;
}
