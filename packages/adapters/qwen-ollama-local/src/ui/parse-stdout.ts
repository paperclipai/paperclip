import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseStdoutLine } from "../server/parse.js";

export function parseQwenStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const entries = parseStdoutLine(line, ts);
  return entries.map((e) => {
    if (e.type === "system") {
      return { kind: "system" as const, ts, text: e.text || "" };
    } else if (e.type === "error") {
      return { kind: "stderr" as const, ts, text: e.text || "" };
    } else {
      return { kind: "stdout" as const, ts, text: e.text || "" };
    }
  });
}
