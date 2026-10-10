import { z } from "zod";

export function normalizeEscapedLineBreaks(value: string): string {
  if (!value.includes("\\n") && !value.includes("\\r")) return value;
  // Recover legacy single-line payloads that encoded their own line breaks.
  // A real multiline body already has decoded transport newlines; decoding
  // it again corrupts literal escapes in JSON, code, paths and agent prompts.
  if (/[\r\n]/.test(value)) return value;
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);
