import type { Issue, IssueComment } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Slack Block Kit types (minimal — only what we use)
// ---------------------------------------------------------------------------

export type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string } }
  | { type: "section"; text: { type: "mrkdwn"; text: string }; accessory?: unknown }
  | { type: "divider" }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> };

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Formats a Paperclip issue as a Slack Block Kit message.
 * Used when a new issue is posted to a Slack channel.
 */
export function issueToSlackBlocks(
  issue: Issue,
  projectName: string,
  paperclipUrl: string,
): SlackBlock[] {
  const statusEmoji = statusToEmoji(issue.status);
  const priorityLabel = issue.priority ? ` · ${capitalized(issue.priority)} priority` : "";

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${statusEmoji} ${issue.title}`,
      },
    },
  ];

  if (issue.description) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(issue.description, 2800),
      },
    });
  }

  blocks.push({ type: "divider" });

  const metaParts: string[] = [
    `*Project:* ${projectName}`,
    `*Status:* ${capitalized(issue.status ?? "open")}${priorityLabel}`,
    `*View in Paperclip:* <${paperclipUrl}|Open issue>`,
  ];

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: metaParts.join("   |   ") }],
  });

  return blocks;
}

/**
 * Formats a comment for posting as a Slack thread reply.
 */
export function commentToSlackText(comment: IssueComment, authorName: string): string {
  const header = `*${authorName}:*`;
  const body = truncate(comment.body, 3000);
  return `${header}\n${body}`;
}

/**
 * Formats an issue status change as a short Slack thread message.
 */
export function statusChangeToSlackText(
  issue: Issue,
  oldStatus: string,
  newStatus: string,
): string {
  const oldEmoji = statusToEmoji(oldStatus);
  const newEmoji = statusToEmoji(newStatus);
  return `${oldEmoji} → ${newEmoji}  *Status changed:* _${capitalized(oldStatus)}_ → _${capitalized(newStatus)}_\n_${issue.title}_`;
}

/**
 * Formats a "issue created from Slack" confirmation DM reply.
 */
export function issueCreatedConfirmation(issue: Issue, paperclipUrl: string): string {
  return `✅ Issue created: *${issue.title}*\n<${paperclipUrl}|View in Paperclip>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusToEmoji(status: string | null | undefined): string {
  switch (status) {
    case "done": return "✅";
    case "cancelled": return "🚫";
    case "in_progress": return "🔄";
    case "in_review": return "👀";
    case "blocked": return "🔴";
    default: return "📋";
  }
}

function capitalized(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}
