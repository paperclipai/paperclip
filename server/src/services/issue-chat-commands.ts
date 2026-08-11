import type {
  IssueCommentMetadata,
  IssueCommentMetadataRow,
  IssueCommentPresentation,
  IssueCommentPresentationTone,
} from "@paperclipai/shared";
import type {
  AdapterChatCommandInvocation,
  AdapterExecutionResult,
} from "../adapters/index.js";

export function parseLeadingIssueChatCommand(body: string): { name: string; args: string; raw: string } | null {
  const firstLine = body.replace(/^\s+/, "").split(/\r?\n/, 1)[0] ?? "";
  const match = firstLine.match(/^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/i);
  if (!match) return null;
  const name = match[1]?.toLowerCase() ?? "";
  if (!name) return null;
  return {
    name,
    args: match[2]?.trim() ?? "",
    raw: firstLine.trim(),
  };
}

export function isHumanIssueChatCommandComment(comment: {
  body: string;
  authorType?: string | null;
  authorUserId?: string | null;
  deletedAt?: Date | string | null;
} | null): comment is {
  body: string;
  authorType: "user";
  authorUserId: string | null;
  deletedAt?: Date | string | null;
} {
  return Boolean(comment && !comment.deletedAt && comment.authorType === "user");
}

/**
 * Adapter-aware guidance for a `/goal` command the assignee cannot honor.
 * Adapters that *could* support goals get enable-it instructions; every other
 * harness gets an explicit "not supported here" warning so humans learn the
 * command is agent-dependent rather than silently losing the request.
 */
function unsupportedGoalCommandMessage(adapterType: string): string {
  if (adapterType === "codex_local") {
    return "`/goal` requires a Codex agent using the app-server goal runtime. Enable the Codex goal runtime in the assignee's adapter settings, then try again.";
  }
  if (adapterType === "claude_local") {
    return "`/goal` requires the Claude Code goal command to be enabled for this agent. Turn on the goal command in the assignee's adapter settings, then try again.";
  }
  return `\`/goal\` is not supported by this agent's \`${adapterType}\` harness. Reassign the issue to a Codex or Claude Code agent with goal support enabled, or send a regular comment instead.`;
}

export function buildUnsupportedChatCommandReply(input: {
  command: AdapterChatCommandInvocation;
  adapterType: string;
}): { message: string; result: AdapterExecutionResult } {
  const message =
    input.command.name === "goal"
      ? unsupportedGoalCommandMessage(input.adapterType)
      : `Unsupported issue-thread command: \`/${input.command.name}\`.`;
  return {
    message,
    result: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      provider: "paperclip",
      biller: "paperclip",
      model: input.adapterType,
      billingType: "fixed",
      costUsd: null,
      resultJson: {
        chatCommand: {
          name: input.command.name,
          supported: false,
          sourceCommentId: input.command.sourceCommentId,
        },
      },
      summary: "",
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const GOAL_STATUS_TONES: Record<string, IssueCommentPresentationTone> = {
  active: "info",
  paused: "neutral",
  complete: "success",
  cleared: "neutral",
  blocked: "warning",
  usageLimited: "warning",
  budgetLimited: "warning",
  error: "danger",
};

/**
 * Derive the structured notice presentation + metadata for a supported `/goal`
 * command reply (Codex app-server or Claude Code) so the composer feedback
 * renders as a goal card (objective / status / budget rows) instead of a bare
 * confirmation line.
 *
 * Returns `null` for any result that is not a supported goal command reply, in
 * which case the caller posts a plain comment. The unsupported-command error is
 * handled separately at dispatch time (see `buildUnsupportedChatCommandReply`).
 */
export function buildGoalChatCommandReplyPresentation(
  resultJson: Record<string, unknown> | null | undefined,
): { presentation: IssueCommentPresentation; metadata: IssueCommentMetadata } | null {
  const root = asRecord(resultJson);
  const chatCommand = asRecord(root.chatCommand);
  if (asTrimmedString(chatCommand.name) !== "goal") return null;
  // A supported reply always carries an `action`; the unsupported reply instead
  // carries `supported: false` and is rendered via a different path.
  const action = asTrimmedString(chatCommand.action);
  if (!action) return null;

  const goal = asRecord(root.codexGoal ?? root.claudeGoal);
  const status = asTrimmedString(goal.status);
  const objective = asTrimmedString(goal.objective);
  const tokenBudget = asFiniteNumber(goal.tokenBudget);
  const tokensUsed = asFiniteNumber(goal.tokensUsed);

  let title: string;
  let tone: IssueCommentPresentationTone;
  if (action === "set") {
    title = "Goal set";
    tone = "success";
  } else if (action === "clear") {
    title = "Goal cleared";
    tone = "neutral";
  } else if (action === "status") {
    title = "Goal status";
    tone = (status && GOAL_STATUS_TONES[status]) || "info";
  } else {
    // "invalid" and any future action: surface as a soft warning.
    title = "Goal command";
    tone = "warning";
  }

  const rows: IssueCommentMetadataRow[] = [];
  if (objective) {
    rows.push({ type: "key_value", label: "Objective", value: objective });
  }
  if (status) {
    rows.push({ type: "key_value", label: "Status", value: status });
  }
  if (tokenBudget != null) {
    const used = tokensUsed != null ? `${tokensUsed.toLocaleString()} / ` : "";
    rows.push({ type: "key_value", label: "Budget", value: `${used}${tokenBudget.toLocaleString()} tokens` });
  } else if (tokensUsed != null) {
    rows.push({ type: "key_value", label: "Tokens used", value: tokensUsed.toLocaleString() });
  }

  return {
    presentation: {
      kind: "system_notice",
      tone,
      title,
      detailsDefaultOpen: rows.length > 0,
    },
    metadata: {
      version: 1,
      sections: rows.length > 0 ? [{ title: "Goal", rows }] : [],
    },
  };
}
