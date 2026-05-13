/**
 * Side-effect handler invoked when {@link IssueCreateRateLimiter.consume} rejects
 * an agent issue-create request. Pauses the offending agent and emits a
 * governance alert issue (with same-agent dedup), per ADR-008 §2.3.
 *
 * The {@link IssueCreateRateLimitGuardDeps} surface is intentionally narrow so
 * route code can wire real services in production and a route test can pass
 * fakes. Storage for dedup is in-memory; cross-restart redundancy is acceptable
 * (one extra alert per agent per restart).
 */

import { logger } from "../middleware/logger.js";
import type {
  IssueCreateRateLimitConfig,
  IssueCreateRateLimitResult,
} from "./issue-create-rate-limit.js";

export const RATE_LIMIT_PAUSE_REASON = "issue_create_rate_limit";
export const RATE_LIMIT_ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

export type IssueCreateRateLimitAlertActor = {
  agentId: string;
  agentName: string | null;
  agentRole: string | null;
};

export type IssueCreateRateLimitRecentIssue = {
  id: string;
  identifier: string | null;
};

export type IssueCreateRateLimitGuardDeps = {
  pauseAgent: (input: { agentId: string; reason: typeof RATE_LIMIT_PAUSE_REASON }) => Promise<void>;
  resolveOwnerUserIds?: (companyId: string) => Promise<readonly string[]>;
  loadRecentIssueIdentifiers?: (input: {
    companyId: string;
    agentId: string;
    limit: number;
    sinceMs: number;
  }) => Promise<readonly IssueCreateRateLimitRecentIssue[]>;
  createAlertIssue: (input: {
    companyId: string;
    title: string;
    body: string;
    notifyUserIds: readonly string[];
    governanceAssigneeAgentId: string | null;
    sourceAgentId: string;
  }) => Promise<{ id: string; identifier: string | null }>;
  appendAlertComment: (input: {
    issueId: string;
    body: string;
  }) => Promise<void>;
  now?: () => number;
};

export type IssueCreateRateLimitGuard = {
  handleBreach(input: {
    companyId: string;
    actor: IssueCreateRateLimitAlertActor;
    config: IssueCreateRateLimitConfig;
    breach: IssueCreateRateLimitResult;
  }): Promise<{
    alertIssueId: string;
    alertIdentifier: string | null;
    alertCreated: boolean;
    pauseApplied: boolean;
    notifiedUserIds: readonly string[];
    recentIssueCount: number;
  }>;
  resetDedup(agentId?: string): void;
};

type DedupEntry = { alertIssueId: string; alertIdentifier: string | null; createdAt: number };

const RECENT_ISSUES_PREVIEW_LIMIT = 30;

function formatAgentName(actor: IssueCreateRateLimitAlertActor): string {
  return actor.agentName?.trim().length ? actor.agentName : actor.agentId;
}

function buildMentionBlock(userIds: readonly string[]): string {
  if (userIds.length === 0) return "";
  // Use the Paperclip-standard user mention format so the board renders a
  // chip and routes the notification through the existing mention pipeline.
  // See packages/shared/src/project-mentions.ts (USER_MENTION_LINK_RE).
  const mentions = userIds.map((id) => `[@owner](user://${id})`).join(" ");
  return `\n\ncc ${mentions}`;
}

function dedupeUserIds(...sources: readonly (readonly string[] | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of sources) {
    if (!list) continue;
    for (const id of list) {
      const trimmed = typeof id === "string" ? id.trim() : "";
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function formatRecentIssuesBlock(items: readonly IssueCreateRateLimitRecentIssue[]): string {
  if (items.length === 0) {
    return "- (no recently created issues found in window)";
  }
  return items
    .map((item) => {
      if (item.identifier) {
        return `- ${item.identifier} (id: \`${item.id}\`)`;
      }
      return `- id: \`${item.id}\``;
    })
    .join("\n");
}

function buildAlertTitle(actor: IssueCreateRateLimitAlertActor): string {
  return `[GUARD] ${formatAgentName(actor)} 이슈 생성 폭증으로 자동 정지`;
}

function buildAlertBody(input: {
  actor: IssueCreateRateLimitAlertActor;
  config: IssueCreateRateLimitConfig;
  breach: IssueCreateRateLimitResult;
  detectedAt: Date;
  recentIssues: readonly IssueCreateRateLimitRecentIssue[];
  notifyUserIds: readonly string[];
}): string {
  const { actor, config, breach, detectedAt, recentIssues, notifyUserIds } = input;
  const lines: string[] = [];
  lines.push(`Agent **${formatAgentName(actor)}** (id: \`${actor.agentId}\`) exceeded the issue-creation rate limit and was automatically paused.`);
  lines.push("");
  lines.push("- Detected: " + detectedAt.toISOString());
  lines.push(`- Window: ${config.windowMinutes} minute(s)`);
  lines.push(`- Threshold: ${config.maxIssuesPerWindow} issues / window`);
  lines.push(`- Retry-After: ${breach.retryAfterSeconds}s`);
  lines.push(`- Pause reason on agent: \`${RATE_LIMIT_PAUSE_REASON}\``);
  if (actor.agentRole) {
    lines.push(`- Agent role: ${actor.agentRole}`);
  }
  lines.push("");
  lines.push(`## Recent ${recentIssues.length} issues created by this agent`);
  lines.push("");
  lines.push(formatRecentIssuesBlock(recentIssues));
  lines.push("");
  lines.push("## Reactivation guidance");
  lines.push("");
  lines.push("1. Review the issues above and confirm whether the burst is intentional.");
  lines.push("2. If the burst was a bug or runaway loop, fix the cause before resuming.");
  lines.push("3. To unpause, clear `agents.pause_reason` and set `agents.status` back to `idle` (CTO authority).");
  lines.push("4. To adjust threshold or exempt this agent, edit `companies.rate_limit_settings.issueCreation`.");
  const mentionBlock = buildMentionBlock(notifyUserIds).trim();
  if (mentionBlock) {
    lines.push("");
    lines.push(mentionBlock);
  }
  return lines.join("\n").trim();
}

function buildAlertCommentBody(input: {
  actor: IssueCreateRateLimitAlertActor;
  config: IssueCreateRateLimitConfig;
  breach: IssueCreateRateLimitResult;
  detectedAt: Date;
  recentIssues: readonly IssueCreateRateLimitRecentIssue[];
}): string {
  const { actor, config, breach, detectedAt, recentIssues } = input;
  const lines = [
    `Repeat rate-limit breach detected for agent **${formatAgentName(actor)}** (id: \`${actor.agentId}\`).`,
    "",
    `- Detected: ${detectedAt.toISOString()}`,
    `- Window: ${config.windowMinutes} minute(s)`,
    `- Threshold: ${config.maxIssuesPerWindow} issues / window`,
    `- Retry-After: ${breach.retryAfterSeconds}s`,
  ];
  if (recentIssues.length > 0) {
    lines.push("", `### Recent ${recentIssues.length} issues`, formatRecentIssuesBlock(recentIssues));
  }
  return lines.join("\n");
}

export function createIssueCreateRateLimitGuard(
  deps: IssueCreateRateLimitGuardDeps,
): IssueCreateRateLimitGuard {
  const now = deps.now ?? Date.now;
  const dedupByAgentId = new Map<string, DedupEntry>();

  return {
    async handleBreach({ companyId, actor, config, breach }) {
      const currentTime = now();
      const detectedAt = new Date(currentTime);

      logger.warn(
        {
          event: "issue_create_rate_limit_breach",
          companyId,
          agentId: actor.agentId,
          windowMinutes: config.windowMinutes,
          maxIssuesPerWindow: config.maxIssuesPerWindow,
          retryAfterSeconds: breach.retryAfterSeconds,
        },
        "Agent issue-creation rate limit exceeded; pausing agent",
      );

      let pauseApplied = false;
      try {
        await deps.pauseAgent({ agentId: actor.agentId, reason: RATE_LIMIT_PAUSE_REASON });
        pauseApplied = true;
      } catch (err) {
        logger.error(
          { err, agentId: actor.agentId },
          "Failed to auto-pause agent after rate-limit breach; continuing to surface alert",
        );
      }

      const ownerUserIds = deps.resolveOwnerUserIds
        ? await deps.resolveOwnerUserIds(companyId).catch((err) => {
            logger.warn(
              { err, companyId },
              "resolveOwnerUserIds failed; falling back to configured notifyUserIds only",
            );
            return [] as readonly string[];
          })
        : [];
      const notifiedUserIds = dedupeUserIds(config.notifyUserIds, ownerUserIds);

      const recentIssues = deps.loadRecentIssueIdentifiers
        ? await deps
            .loadRecentIssueIdentifiers({
              companyId,
              agentId: actor.agentId,
              limit: RECENT_ISSUES_PREVIEW_LIMIT,
              sinceMs: currentTime - Math.max(60_000, config.windowMinutes * 60_000),
            })
            .catch((err) => {
              logger.warn(
                { err, agentId: actor.agentId },
                "loadRecentIssueIdentifiers failed; alert body will omit recent issues list",
              );
              return [] as readonly IssueCreateRateLimitRecentIssue[];
            })
        : [];

      const existing = dedupByAgentId.get(actor.agentId);
      if (existing && currentTime - existing.createdAt < RATE_LIMIT_ALERT_DEDUP_WINDOW_MS) {
        try {
          await deps.appendAlertComment({
            issueId: existing.alertIssueId,
            body: buildAlertCommentBody({ actor, config, breach, detectedAt, recentIssues }),
          });
        } catch (err) {
          logger.error(
            { err, agentId: actor.agentId, alertIssueId: existing.alertIssueId },
            "Failed to append rate-limit breach comment to existing alert issue",
          );
        }
        return {
          alertIssueId: existing.alertIssueId,
          alertIdentifier: existing.alertIdentifier,
          alertCreated: false,
          pauseApplied,
          notifiedUserIds,
          recentIssueCount: recentIssues.length,
        };
      }

      const alertIssue = await deps.createAlertIssue({
        companyId,
        title: buildAlertTitle(actor),
        body: buildAlertBody({ actor, config, breach, detectedAt, recentIssues, notifyUserIds: notifiedUserIds }),
        notifyUserIds: notifiedUserIds,
        governanceAssigneeAgentId: config.governanceAssigneeAgentId,
        sourceAgentId: actor.agentId,
      });
      dedupByAgentId.set(actor.agentId, {
        alertIssueId: alertIssue.id,
        alertIdentifier: alertIssue.identifier,
        createdAt: currentTime,
      });
      return {
        alertIssueId: alertIssue.id,
        alertIdentifier: alertIssue.identifier,
        alertCreated: true,
        pauseApplied,
        notifiedUserIds,
        recentIssueCount: recentIssues.length,
      };
    },
    resetDedup(agentId) {
      if (!agentId) {
        dedupByAgentId.clear();
        return;
      }
      dedupByAgentId.delete(agentId);
    },
  };
}
