// Matches standard Jira key format: PROJECT-123
const JIRA_KEY_REGEX = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/**
 * Extracts the first Jira issue key found in the given text.
 * Returns null when no key is found.
 * v1 label-based fallback — use externalRefs.jira.key when available.
 */
export function extractJiraKey(text: string): string | null {
  const match = JIRA_KEY_REGEX.exec(text);
  JIRA_KEY_REGEX.lastIndex = 0;
  return match ? (match[1] ?? null) : null;
}

/**
 * Extracts all unique Jira issue keys found in the given text.
 */
export function extractAllJiraKeys(text: string): string[] {
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  JIRA_KEY_REGEX.lastIndex = 0;
  while ((match = JIRA_KEY_REGEX.exec(text)) !== null) {
    const key = match[1];
    if (key && !keys.includes(key)) {
      keys.push(key);
    }
  }
  JIRA_KEY_REGEX.lastIndex = 0;
  return keys;
}
