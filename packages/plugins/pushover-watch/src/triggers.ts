import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type {
  PluginConfig,
  CompanyConfig,
  CachedIssueState,
} from "./config-schema.js";
import { matchesT1, matchesT2, matchesT3 } from "./transitions.js";
import { commentMentionsUser } from "./mentions.js";
import { sendPushover, type SendParams } from "./pushover-client.js";

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

async function dispatch(
  ctx: PluginContext,
  config: PluginConfig,
  send: SendParams,
): Promise<void> {
  if (config.dryRun) {
    ctx.logger.info("pushover_watch_dry_run", { send });
    return;
  }
  await sendPushover(ctx, send);
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

  const prev = (await ctx.state.get(issueStateKey(issueId))) as CachedIssueState | null;

  const next: CachedIssueState = {
    status: event.payload.status,
    assigneeAgentId: event.payload.assigneeAgentId,
    assigneeUserId: event.payload.assigneeUserId,
    updatedAt: event.occurredAt,
  };

  await ctx.state.set(issueStateKey(issueId), next);

  if (!prev) return; // unknown issue — seed only, no notification

  const url = issueUrl(config, company, event.payload.identifier);

  // T1: CEO/CHO done
  if (matchesT1(prev, next, company.topAgentIds)) {
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(ctx, config, {
      userKey,
      appToken,
      title: `[${company.issuePrefix}] CEO erledigt: ${truncate(event.payload.title, 80)}`,
      message: event.payload.title,
      url,
      urlTitle: "In Paperclip öffnen",
      priority: 0,
    });
    return;
  }

  // T2: in_review handover to board user
  if (matchesT2(prev, next, config.boardUserId)) {
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(ctx, config, {
      userKey,
      appToken,
      title: `[${company.issuePrefix}] Review-Handover: ${truncate(event.payload.title, 80)}`,
      message: event.payload.title,
      url,
      urlTitle: "In Paperclip öffnen",
      priority: 0,
    });
    return;
  }

  // T3: transition into blocked AND latest comment mentions board user
  if (matchesT3(prev, next)) {
    const comments = await ctx.issues.listComments(issueId, event.companyId);
    const latest = comments[comments.length - 1];
    if (!latest || !commentMentionsUser(latest.body, config.boardUserId)) return;
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(ctx, config, {
      userKey,
      appToken,
      title: `[${company.issuePrefix}] Blockiert, braucht dich: ${truncate(event.payload.title, 80)}`,
      message: truncate(latest.body, 200),
      url,
      urlTitle: "In Paperclip öffnen",
      priority: 1,
    });
  }
}
