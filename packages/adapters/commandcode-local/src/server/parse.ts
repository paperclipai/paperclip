export interface ParsedCommandCodeOutput {
  sessionId: string | null;
  summary: string;
  errorMessage: string | null;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function parseCommandCodeOutput(stdout: string, stderr: string): ParsedCommandCodeOutput {
  const sessionId = extractCommandCodeSessionId(stderr) ?? extractCommandCodeSessionId(stdout);
  const summary = stdout.trim();
  const errorMessage = firstNonEmptyLine(stderr) || null;
  return {
    sessionId,
    summary,
    errorMessage,
  };
}

export function extractCommandCodeSessionId(text: string): string | null {
  const patterns = [
    /\bsession(?:\s+id)?\s*[:=]\s*([A-Za-z0-9_.:@/-]+)/i,
    /\bconversation(?:\s+id)?\s*[:=]\s*([A-Za-z0-9_.:@/-]+)/i,
    /\bthread(?:\s+id)?\s*[:=]\s*([A-Za-z0-9_.:@/-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

export function isCommandCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session(?:\s+.*)?\s+not\s+found|resume\s+.*\s+not\s+found|invalid\s+session/i.test(haystack);
}
