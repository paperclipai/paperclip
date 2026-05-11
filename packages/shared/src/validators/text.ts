import { z } from "zod";

export function stripDatabaseUnsafeControlCharacters(value: string): string {
  return value.replace(/\u0000/g, "");
}

export function normalizeEscapedLineBreaks(value: string): string {
  return stripDatabaseUnsafeControlCharacters(value)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);
export const databaseTextSchema = z.string().transform(stripDatabaseUnsafeControlCharacters);
