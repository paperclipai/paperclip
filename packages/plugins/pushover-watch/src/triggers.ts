import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type {
  PluginConfig,
  CompanyConfig,
  CachedIssueState,
} from "./config-schema.js";
import { matchesT1, matchesT2, matchesT3, matchesT6, type T6Status } from "./transitions.js";
import { commentMentionsUser } from "./mentions.js";
import { sendPushover, sendGlance, type SendParams } from "./pushover-client.js";

// Server-internal housekeeping issue origins. The recovery service creates
// these issues (e.g. "Recover stalled issue PAP-1", "Recover missing next step
// PAP-1") and they cycle through todo → done on their own; pushing them to the
// watch is pure noise.
const SUPPRESSED_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  "stranded_issue_recovery",
  "stale_active_run_evaluation",
  "harness_liveness_escalation",
  "issue_productivity_review",
]);

function isSystemRecoveryIssue(originKind: string | null | undefined): boolean {
  return !!originKind && SUPPRESSED_ORIGIN_KINDS.has(originKind);
}

type GlancePayload = {
  title: string;
  text?: string;
  subtext?: string;
};

type IssueUpdatedPayload = {
  id: string;
  identifier: string | null;
  title: string;
  status: CachedIssueState["status"];
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function issueStateKey(issueId: string) {
  return {
    scopeKind: "issue" as const,
    scopeId: issueId,
    stateKey: "pushover-watch:last-seen",
  };
}

function findCompany(config: PluginConfig, companyId: string): CompanyConfig | undefined {
  return config.companies.find((c) => c.companyId === companyId && c.enabled !== false);
}

function issueUrl(config: PluginConfig, company: CompanyConfig, identifier: string | null): string {
  if (!identifier) return config.clickbackBaseUrl;
  return `${config.clickbackBaseUrl}/${company.issuePrefix}/issues/${identifier}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function secretaryPushLabels(
  prefix: string,
  status: T6Status,
): { titleLabel: string; glanceTitle: string; priority: 0 | 1 } {
  switch (status) {
    case "done":
      return {
        titleLabel: `[${prefix}] Sekretärin erledigt`,
        glanceTitle: `[${prefix}] Sekretärin erledigt`,
        priority: 0,
      };
    case "in_review":
      return {
        titleLabel: `[${prefix}] Sekretärin: Review`,
        glanceTitle: `[${prefix}] Sekretärin: Review`,
        priority: 0,
      };
    case "blocked":
      return {
        titleLabel: `[${prefix}] Sekretärin: Blockiert`,
        glanceTitle: `[${prefix}] Sekretärin: Blockiert`,
        priority: 1,
      };
  }
}

async function dispatch(
  ctx: PluginContext,
  config: PluginConfig,
  send: SendParams,
  glance: GlancePayload,
): Promise<void> {
  if (config.dryRun) {
    ctx.logger.info("pushover_watch_dry_run", { send, glance });
    return;
  }
  await Promise.all([
    sendPushover(ctx, send),
    sendGlance(ctx, {
      userKey: send.userKey,
      appToken: send.appToken,
      ...glance,
    }),
  ]);
}

async function resolveCredentials(
  ctx: PluginContext,
  config: PluginConfig,
): Promise<{ userKey: string; appToken: string }> {
  const [userKey, appToken] = await Promise.all([
    ctx.secrets.resolve(config.pushoverUserKeyRef),
    ctx.secrets.resolve(config.pushoverAppTokenRef),
  ]);
  return { userKey, appToken };
}

export async function handleIssueUpdated(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent<IssueUpdatedPayload>,
): Promise<void> {
  const company = findCompany(config, event.companyId);
  if (!company) return;

  const issueId = event.entityId;
  if (!issueId) return;

  // The event payload only carries the delta (changed fields). Fetch the full
  // current issue state so we know assignee, title etc. regardless of which
  // fields were in this particular update.
  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue) {
    ctx.logger.warn("pushover_watch_issue_not_found", { issueId, companyId: event.companyId });
    return;
  }

  if (isSystemRecoveryIssue(issue.originKind)) {
    ctx.logger.info("pushover_watch_skip_system_origin", {
      issueId,
      originKind: issue.originKind,
    });
    return;
  }

  const prev = (await ctx.state.get(issueStateKey(issueId))) as CachedIssueState | null;

  const next: CachedIssueState = {
    status: issue.status as CachedIssueState["status"],
    assigneeAgentId: issue.assigneeAgentId ?? null,
    assigneeUserId: issue.assigneeUserId ?? null,
    updatedAt: event.occurredAt,
  };

  await ctx.state.set(issueStateKey(issueId), next);

  ctx.logger.info("pushover_watch_issue_event", {
    issueId,
    identifier: issue.identifier,
    prevStatus: prev?.status ?? null,
    nextStatus: next.status,
    assigneeAgentId: next.assigneeAgentId,
    assigneeUserId: next.assigneeUserId,
  });

  const url = issueUrl(config, company, issue.identifier);
  const title = issue.title ?? "";

  const identifierLabel = issue.identifier ?? "";

  // T6: Sekretärin transition into done / in_review / blocked.
  // Checked before T1/T2/T3 so the more specific Sekretärin label wins when
  // the same transition would also match a generic trigger (e.g. Sekretärin
  // hands an issue to Walter via in_review → T6, not T2).
  const t6 = matchesT6(prev, next, company.secretaryAgentIds ?? []);
  if (t6) {
    const { titleLabel, glanceTitle, priority } = secretaryPushLabels(company.issuePrefix, t6);
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(
      ctx,
      config,
      {
        userKey,
        appToken,
        title: `${titleLabel}: ${truncate(title, 80)}`,
        message: title,
        url,
        urlTitle: "In Paperclip öffnen",
        priority,
      },
      {
        title: glanceTitle,
        text: title,
        subtext: identifierLabel,
      },
    );
    return;
  }

  // T1: CEO/CHO done
  if (matchesT1(prev, next, company.topAgentIds)) {
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(
      ctx,
      config,
      {
        userKey,
        appToken,
        title: `[${company.issuePrefix}] CEO erledigt: ${truncate(title, 80)}`,
        message: title,
        url,
        urlTitle: "In Paperclip öffnen",
        priority: 0,
      },
      {
        title: `[${company.issuePrefix}] CEO erledigt`,
        text: title,
        subtext: identifierLabel,
      },
    );
    return;
  }

  // T2: in_review handover to board user
  if (matchesT2(prev, next, config.boardUserId)) {
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(
      ctx,
      config,
      {
        userKey,
        appToken,
        title: `[${company.issuePrefix}] Review-Handover: ${truncate(title, 80)}`,
        message: title,
        url,
        urlTitle: "In Paperclip öffnen",
        priority: 0,
      },
      {
        title: `[${company.issuePrefix}] Review wartet`,
        text: title,
        subtext: identifierLabel,
      },
    );
    return;
  }

  // T3: transition into blocked AND latest comment mentions board user
  if (matchesT3(prev, next)) {
    const comments = await ctx.issues.listComments(issueId, event.companyId);
    const latest = comments[comments.length - 1];
    if (!latest || !commentMentionsUser(latest.body, config.boardUserId)) return;
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(
      ctx,
      config,
      {
        userKey,
        appToken,
        title: `[${company.issuePrefix}] Blockiert, braucht dich: ${truncate(title, 80)}`,
        message: truncate(latest.body, 200),
        url,
        urlTitle: "In Paperclip öffnen",
        priority: 1,
      },
      {
        title: `[${company.issuePrefix}] Blockiert`,
        text: title,
        subtext: identifierLabel,
      },
    );
  }
}

type CommentCreatedPayload = {
  id: string;
  issueId: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
};

export async function handleCommentCreated(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent<CommentCreatedPayload>,
): Promise<void> {
  const company = findCompany(config, event.companyId);
  if (!company) return;

  // The event payload from the activity log carries activity details, not the
  // full comment record. Resolve the comment + parent issue via the API to get
  // the body, author, and issue context we need.
  const commentId = event.entityId;
  if (!commentId) return;

  const issueId = (event.payload as { issueId?: string }).issueId
    ?? (event.payload as { parentEntityId?: string }).parentEntityId;
  if (!issueId) {
    ctx.logger.info("pushover_watch_comment_no_issueid", { commentId, payload: event.payload });
    return;
  }

  const [issue, comments] = await Promise.all([
    ctx.issues.get(issueId, event.companyId),
    ctx.issues.listComments(issueId, event.companyId),
  ]);
  if (!issue) return;
  if (isSystemRecoveryIssue(issue.originKind)) return;

  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return;

  if (comment.authorUserId === config.boardUserId) return; // ignore self-mentions
  if (typeof comment.body !== "string") return;
  if (!commentMentionsUser(comment.body, config.boardUserId)) return;

  const url = issueUrl(config, company, issue.identifier);
  const { userKey, appToken } = await resolveCredentials(ctx, config);
  const authorLabel = comment.authorAgentId
    ? `Agent ${comment.authorAgentId.slice(0, 8)}`
    : "jemand";

  await dispatch(
    ctx,
    config,
    {
      userKey,
      appToken,
      title: `[${company.issuePrefix}] @-Mention von ${authorLabel}: ${truncate(issue.title ?? "", 60)}`,
      message: truncate(comment.body, 200),
      url,
      urlTitle: "In Paperclip öffnen",
      priority: 0,
    },
    {
      title: `[${company.issuePrefix}] @-Mention`,
      text: issue.title ?? "",
      subtext: issue.identifier ?? "",
    },
  );
}

type ApprovalCreatedPayload = {
  id: string;
  type: string;
  status: string;
  title?: string;
};

export async function handleApprovalCreated(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent<ApprovalCreatedPayload>,
): Promise<void> {
  const company = findCompany(config, event.companyId);
  if (!company) return;
  if (event.payload.type !== "request_board_approval") return;
  if (event.payload.status !== "pending") return;

  const { userKey, appToken } = await resolveCredentials(ctx, config);
  const approvalUrl = `${config.clickbackBaseUrl}/${company.issuePrefix}/approvals/${event.payload.id}`;
  const title = event.payload.title ?? "Approval-Request";

  await dispatch(
    ctx,
    config,
    {
      userKey,
      appToken,
      title: `[${company.issuePrefix}] Approval wartet: ${truncate(title, 80)}`,
      message: title,
      url: approvalUrl,
      urlTitle: "In Paperclip öffnen",
      priority: 1,
    },
    {
      title: `[${company.issuePrefix}] Approval wartet`,
      text: title,
      subtext: event.payload.id.slice(0, 8),
    },
  );
}
