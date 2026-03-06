export interface CopilotParseResult {
  sessionId: string | null;
  summary: string;
  stdout: string;
  stderr: string;
}

const SESSION_ID_RE = /(?:session[:\s]+)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;

export function parseCopilotOutput(stdout: string, stderr: string): CopilotParseResult {
  const sessionMatch = stderr.match(SESSION_ID_RE) ?? stdout.match(SESSION_ID_RE);
  const sessionId = sessionMatch ? sessionMatch[1] : null;
  const summary = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("─") && !l.startsWith("╭") && !l.startsWith("╰"))
    ?? "";
  return { sessionId, summary, stdout, stderr };
}

export function isCopilotSessionNotFoundError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("session not found") ||
    lower.includes("session expired") ||
    lower.includes("could not resume") ||
    lower.includes("no session with id")
  );
}
