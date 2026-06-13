export const DEFAULT_PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^\s*Parked\.?\s*$/i,
  /^\s*Parking\.?\s*$/i,
  /^\s*Silent(?:\.|\s+exit\.?)?\s*$/i,
  /^\s*Self-?wake(?:\s+(?:loop|exit|waiting(?:\s+for\s+\w+)?))?\.?\s*$/i,
  /^\s*Done for this heartbeat\.?\s*$/i,
  /^\s*Noop\.?\s*$/i,
  /^\s*Blocked\.?\s*$/i,
  /^\s*\.{1,3}\s*$/,
  /^\s*(?:Heartbeat over|Continuing|Working|Idle|Polling)\.?\s*$/i,
]);

export function isPlaceholderCommentBody(
  body: string | null | undefined,
  regexSet: ReadonlyArray<RegExp> = DEFAULT_PLACEHOLDER_PATTERNS,
): boolean {
  const normalizedBody = body?.trim();
  if (!normalizedBody) return false;

  for (const pattern of regexSet) {
    pattern.lastIndex = 0;
    if (pattern.test(normalizedBody)) return true;
  }
  return false;
}
