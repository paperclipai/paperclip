/** Legacy sources retain safe error text rather than provider response bodies. */
export function skillSourceRepairAction(error: string | null): 'connection' | 'branch' | 'retry' | null {
  if (!error) return null;
  if (error.startsWith('The tracked GitHub branch or revision is unavailable.')) return 'branch';
  if (/^(Choose a GitHub connection|Choose an authorized connection|Reconnect|GitHub denied repository access|Azure DevOps denied repository access|Azure DevOps project authorization is unavailable|Project Azure DevOps authorization is unavailable|An Azure DevOps project authorization is unavailable|Authorize this project’s Azure DevOps connection|GitHub connection is unavailable|Choose an active GitHub authorization|Private GitHub skills require|This run cannot use|The person who connected|The agent who connected|Project access changed)/.test(error)) return 'connection';
  return 'retry';
}
