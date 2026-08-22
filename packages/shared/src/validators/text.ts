import { z } from "zod";

export function normalizeEscapedLineBreaks(value: string): string {
  if (!value.includes("\\n") && !value.includes("\\r")) return value;
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);
