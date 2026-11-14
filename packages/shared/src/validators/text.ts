import { z } from "zod";

export function normalizeEscapedLineBreaks(value: string): string {
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

/**
 * Bound a string by JavaScript string length as well as Zod's max, which counts code
 * points and so admits up to twice `max` in emoji. Use this where a consumer of the
 * value enforces the same limit with `.length`.
 */
export function maxStringLength(schema: z.ZodString, max: number) {
  return schema.max(max).refine((value) => value.length <= max, `Must be at most ${max} characters`);
}
