import type { Issue } from "@paperclipai/shared";

export function issuePostCommitWarningBody(issue: Issue): string | null {
  const messages = issue.postCommitWarnings
    ?.map((warning) => warning.message.trim())
    .filter(Boolean) ?? [];
  return messages.length > 0 ? messages.join(" ") : null;
}
