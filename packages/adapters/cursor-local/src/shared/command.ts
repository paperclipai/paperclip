/**
 * The adapter `command` field must be a single executable name or path (e.g. `agent`).
 * Operators sometimes paste `agent login` from auth hints; that is a shell invocation, not a binary name.
 */
export function normalizeCursorCliCommand(raw: string, defaultCommand = "agent"): string {
  const trimmed = raw.trim();
  if (!trimmed) return defaultCommand;
  const parts = trimmed.split(/\s+/);
  if (
    parts.length >= 2 &&
    parts[0]!.toLowerCase() === "agent" &&
    parts[1]!.toLowerCase() === "login"
  ) {
    return "agent";
  }
  return trimmed;
}
