// Utility functions for Antigravity local server adapter

// Returns the first non-empty line from a string, or null if all lines are blank
export function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
