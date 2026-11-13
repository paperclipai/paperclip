const trimWhitespace = String.raw`[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*`;

export const taskDocumentKeySchema = {
  type: "string",
  description: "Stable document identifier, not a filename or path (for example reconciliation, not reconciliation.md). After trimming whitespace and lowercasing: 1–64 characters, starting with a letter or digit and containing only a–z, 0–9, _ or -. The raw input is limited to 120 characters.",
  minLength: 1,
  maxLength: 120,
  pattern: `^${trimWhitespace}[A-Za-z0-9\\u212a][A-Za-z0-9_\\u212a-]{0,63}${trimWhitespace}$`,
} as const;
