import { z } from "zod";

export function normalizeEscapedLineBreaks(value: string): string {
  // Skip valid JSON payloads: their `\n`/`\r` sequences are structural string
  // escapes, not literal text a client mistakenly failed to turn into a real
  // line break. Rewriting those bytes turns escaped-newline JSON into raw
  // control characters, breaking `JSON.parse`/`json.loads` for any consumer
  // reading the stored value back as data (see SPC-39026).
  try {
    JSON.parse(value);
    return value;
  } catch {
    // Not JSON — fall through to the legacy literal-escape normalization
    // used for human/agent-authored markdown text.
  }

  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);
