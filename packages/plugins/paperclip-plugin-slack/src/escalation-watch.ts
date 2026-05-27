import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "./constants.js";
import { postMessage, type SlackMessage } from "./slack-api.js";
import type { SlackPluginConfig } from "./types.js";

interface IssueBlockerSummary {
  id?: string;
  identifier?: string;
  legacyIdentifier?: string;
  issueIdentifier?: string;
  title?: string;
}

function cleanBaseUrl(baseUrl: string): string {
  return (baseUrl || "http://localhost:3100").replace(/\/+$/, "");
}

function issueIdentifierPrefix(identifier: string): string {
  return identifier.includes("-") ? identifier.split("-")[0] : "issues";
}

function issueUrl(baseUrl: string, identifier: string): string {
  const prefix = issueIdentifierPrefix(identifier);
  return `${cleanBaseUrl(baseUrl)}/${prefix}/issues/${identifier}`;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function blockerIdentifier(blocker: IssueBlockerSummary): string | null {
  return firstString(
    blocker.identifier,
    blocker.legacyIdentifier,
    blocker.issueIdentifier,
  );
}

export function getHumanDecisionIssueId(event: PluginEvent): string {
  const payload = event.payload as Record<string, unknown>;
  return String(payload.issueId ?? event.entityId ?? "");
}

export function shouldSuppressHumanDecisionEscalation(
  previousValue: unknown,
  nowMs: number,
  dedupeWindowMs: number,
): boolean {
  const previousMs =
    typeof previousValue === "number"
      ? previousValue
      : typeof previousValue === "string"
        ? Date.parse(previousValue)
        : Number.NaN;
  return Number.isFinite(previousMs) && nowMs - previousMs < dedupeWindowMs;
}

export function formatHumanDecisionEscalationMessage(
  event: PluginEvent,
  config: Pick<SlackPluginConfig, "paperclipBaseUrl">,
): SlackMessage {
  const payload = event.payload as Record<string, unknown>;
  const issueId = getHumanDecisionIssueId(event);
  const identifier = firstString(payload.identifier, payload.issueIdentifier) ?? issueId;
  const title = firstString(payload.title) ?? "Untitled issue";
  const assignee =
    firstString(payload.assigneeName, payload.assigneeAgentName, payload.agentName) ??
    "Unassigned";
  const blockerCandidates = Array.isArray(payload.blockedByIssues)
    ? payload.blockedByIssues
    : Array.isArray(payload.blockedBy)
      ? payload.blockedBy
      : Array.isArray(payload.blockers)
        ? payload.blockers
        : [];
  const blockers = blockerCandidates.filter(
    (blocker): blocker is IssueBlockerSummary =>
      blocker !== null && typeof blocker === "object",
  );
  const blockerCount = Number(payload.blockedByCount ?? blockers.length);
  const firstBlocker = blockers.length > 0 ? blockerIdentifier(blockers[0]) : null;
  const blockerText =
    blockerCount <= 0
      ? "none"
      : `${blockerCount} issue${blockerCount === 1 ? "" : "s"}${firstBlocker ? ` (${firstBlocker}${blockerCount > 1 ? ` +${blockerCount - 1} more` : ""})` : ""}`;
  const url = issueUrl(config.paperclipBaseUrl, identifier);
  const ownershipUrl = `${url}?reassign=user`;

  return {
    text: `Human decision needed: ${identifier} - ${title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:rotating_light: <${url}|${identifier}>: *${title}*`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Assignee*\n${assignee}` },
          { type: "mrkdwn", text: `*Blocked by*\n${blockerText}` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Take ownership" },
            url: ownershipUrl,
            action_id: "take_issue_ownership",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "View in Paperclip" },
            url,
            action_id: "view_issue",
          },
        ],
      },
    ],
  };
}

export async function postHumanDecisionEscalation(
  ctx: PluginContext,
  token: string,
  config: SlackPluginConfig,
  event: PluginEvent,
  nowMs = Date.now(),
): Promise<{ posted: boolean; deduped: boolean; ts?: string; error?: string }> {
  const issueId = getHumanDecisionIssueId(event);
  const channelId =
    config.escalationChatId || config.approvalsChannelId || config.defaultChannelId;
  if (!issueId || !channelId) {
    return { posted: false, deduped: false, error: "missing_issue_or_channel" };
  }

  const stateKey = STATE_KEYS.humanDecisionEscalation(issueId);
  const previous = await ctx.state.get({
    scopeKind: "company",
    scopeId: event.companyId,
    stateKey,
  });
  const dedupeWindowMs = config.escalationDedupeWindowMs ?? 3600000;
  if (shouldSuppressHumanDecisionEscalation(previous, nowMs, dedupeWindowMs)) {
    await ctx.metrics.write("slack.escalation_watch.deduped", 1);
    return { posted: false, deduped: true };
  }

  const result = await postMessage(
    ctx,
    token,
    channelId,
    formatHumanDecisionEscalationMessage(event, config),
  );
  if (!result.ok) {
    await ctx.metrics.write("slack.escalation_watch.failed", 1, {
      error_code: result.error ?? "unknown",
    });
    return { posted: false, deduped: false, error: result.error ?? "unknown" };
  }

  await ctx.state.set(
    { scopeKind: "company", scopeId: event.companyId, stateKey },
    new Date(nowMs).toISOString(),
  );
  await ctx.activity.log({
    companyId: event.companyId,
    message: `Forwarded ${event.eventType} to Slack`,
    entityType: "issue",
    entityId: issueId,
  });
  await ctx.metrics.write("slack.escalation_watch.sent", 1);
  return { posted: true, deduped: false, ts: result.ts };
}
