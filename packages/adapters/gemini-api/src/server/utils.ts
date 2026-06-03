export function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function redactApiKey(key: string): string {
  if (key.length <= 8) return "[redacted]";
  return `[redacted, length=${key.length}]`;
}
