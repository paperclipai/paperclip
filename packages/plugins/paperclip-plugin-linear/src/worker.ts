import crypto from "node:crypto";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { Issue, PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";

// Goal type with `targetDate` — added in paperclipai/shared post-2026-04-26
// (BLO-584). Cast at the boundary until the SDK ships the updated type.
type GoalWithTargetDate = {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
  parentId: string | null;
  ownerAgentId: string | null;
  targetDate: string | null;
  createdAt: Date;
  updatedAt: Date;
};
import {
  TOOL_NAMES,
  JOB_KEYS,
  ACTION_KEYS,
  DATA_KEYS,
  DEFAULT_CONFIG,
  PLUGIN_ID,
  WEBHOOK_KEYS,
  STATE_KEYS,
  LINEAR_OAUTH,
  GOALS_LINEAR_PROJECT_NAME,
  ORIGIN_KIND_SELF,
} from "./constants.js";
import * as linear from "./linear.js";
import * as sync from "./sync.js";
import {
  absolutePaperclipHref,
  absolutizePaperclipMarkdownLinks,
  appendPaperclipProjectBacklink,
  extractLinearWorkspaceSlug,
  linkifyBareLinearIssueRefs,
  normalizePaperclipBaseUrl,
} from "./markdown.js";

function verifyLinearSignature(secret: string, rawBody: string, headerSig: string | string[] | undefined): boolean {
  const provided = Array.isArray(headerSig) ? headerSig[0] : headerSig;
  if (!provided) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Module-level context (set during setup, used by onWebhook)
// ---------------------------------------------------------------------------

let currentCtx: PluginContext | null = null;

// ---------------------------------------------------------------------------
// In-flight lock: prevents duplicate issue creation when Linear sends
// duplicate webhook events for the same issue ID simultaneously.
// ---------------------------------------------------------------------------

const inFlightCreates = new Set<string>();

// Tracks Paperclip issue IDs that were just created from Linear webhooks.
// The issue.created event handler checks this to avoid a feedback loop
// (webhook creates Paperclip issue → issue.created fires → would push back to Linear).
const recentlyCreatedFromLinear = new Set<string>();

// Same idea for goals: Linear initiative.create webhook → ctx.goals.create →
// goal.created event → would push back to Linear as a duplicate initiative.
const recentlyCreatedGoalFromLinear = new Set<string>();
const inFlightInitiativeCreates = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve Linear API token — config secret ref or plugin state */
async function resolveToken(ctx: PluginContext): Promise<string> {
  // 1. Secret ref from config (manual setup via settings page — passes scope check)
  const config = await ctx.config.get();
  const configRef = config.linearTokenRef as string | undefined;
  if (configRef) return ctx.secrets.resolve(configRef);

  // 2. OAuth token stored in plugin state
  const oauthToken = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.oauthToken,
  });
  if (oauthToken) return String(oauthToken);

  throw new Error("Not connected to Linear. Use the settings page to connect via OAuth.");
}

async function resolvePaperclipBaseUrl(ctx: PluginContext): Promise<string | null> {
  const config = await ctx.config.get();
  return normalizePaperclipBaseUrl(
    (config.paperclipBaseUrl as string | undefined) ?? DEFAULT_CONFIG.paperclipBaseUrl,
  );
}

async function resolveCompanyPrefix(
  ctx: PluginContext,
  companyId: string | null | undefined,
  fallbackIdentifier?: string | null,
): Promise<string | null> {
  if (companyId) {
    try {
      const company = await ctx.companies.get(companyId);
      const prefix = company?.issuePrefix?.trim();
      if (prefix) return prefix;
    } catch {
      // Older SDKs may not expose companies.get; fall through to identifier.
    }
  }

  const inferred = fallbackIdentifier?.match(/^([A-Z][A-Z0-9]*)-/i)?.[1];
  return inferred ? inferred.toUpperCase() : null;
}

async function paperclipLinkOptionsForCompany(
  ctx: PluginContext,
  companyId: string | null | undefined,
  fallbackIdentifier?: string | null,
): Promise<{ baseUrl: string | null; companyPrefix: string | null }> {
  const [baseUrl, companyPrefix] = await Promise.all([
    resolvePaperclipBaseUrl(ctx),
    resolveCompanyPrefix(ctx, companyId, fallbackIdentifier),
  ]);
  return { baseUrl, companyPrefix };
}

async function buildPaperclipIssueUrl(
  ctx: PluginContext,
  companyId: string | null | undefined,
  issueIdentifier: string,
): Promise<string | null> {
  const { baseUrl, companyPrefix } = await paperclipLinkOptionsForCompany(ctx, companyId, issueIdentifier);
  if (!baseUrl) return null;
  return absolutePaperclipHref(`/issues/${encodeURIComponent(issueIdentifier)}`, baseUrl, companyPrefix);
}

async function buildPaperclipProjectUrl(
  ctx: PluginContext,
  companyId: string,
  project: { id: string; urlKey?: string | null; name?: string | null },
): Promise<string | null> {
  const { baseUrl, companyPrefix } = await paperclipLinkOptionsForCompany(ctx, companyId);
  if (!baseUrl) return null;
  const projectRef = project.urlKey?.trim() || project.id;
  return absolutePaperclipHref(`/projects/${encodeURIComponent(projectRef)}`, baseUrl, companyPrefix);
}

async function getPaperclipProjectForLink(
  ctx: PluginContext,
  link: sync.ProjectLink,
): Promise<{ id: string; name?: string | null; description?: string | null; urlKey?: string | null } | null> {
  try {
    return await ctx.projects.get(
      link.paperclipProjectId,
      link.paperclipCompanyId,
    ) as { id: string; name?: string | null; description?: string | null; urlKey?: string | null } | null;
  } catch {
    return null;
  }
}

async function getProjectById(
  ctx: PluginContext,
  projectId: string | null | undefined,
  companyId: string | null | undefined,
): Promise<{ id: string; name?: string | null; status?: string | null; urlKey?: string | null; description?: string | null } | null> {
  if (!projectId || !companyId) return null;
  try {
    return await ctx.projects.get(
      projectId,
      companyId,
    ) as { id: string; name?: string | null; status?: string | null; urlKey?: string | null; description?: string | null } | null;
  } catch {
    return null;
  }
}

async function summarizePaperclipIssue(
  ctx: PluginContext,
  issue: Record<string, unknown> | null | undefined,
  companyId: string | null | undefined,
) {
  if (!issue) return null;
  const identifier = typeof issue.identifier === "string" ? issue.identifier : null;
  const effectiveCompanyId = typeof issue.companyId === "string" ? issue.companyId : companyId;
  return {
    id: typeof issue.id === "string" ? issue.id : null,
    companyId: effectiveCompanyId ?? null,
    identifier,
    title: typeof issue.title === "string" ? issue.title : null,
    status: typeof issue.status === "string" ? issue.status : null,
    projectId: typeof issue.projectId === "string" ? issue.projectId : null,
    url: identifier ? await buildPaperclipIssueUrl(ctx, effectiveCompanyId, identifier) : null,
  };
}

async function summarizePaperclipProject(
  ctx: PluginContext,
  project: { id: string; name?: string | null; status?: string | null; urlKey?: string | null } | null | undefined,
  companyId: string | null | undefined,
) {
  if (!project || !companyId) return null;
  return {
    id: project.id,
    name: project.name ?? null,
    status: project.status ?? null,
    urlKey: project.urlKey ?? null,
    url: await buildPaperclipProjectUrl(ctx, companyId, project),
  };
}

// Write a "Paperclip mirror: <id>" link attachment back to a Linear issue.
//
// Shared between the polling-import action and the webhook-create handler so
// both paths produce the same back-link with the same dedup semantics. Behavior
// gated by config:
//   - paperclipBaseUrl invalid/empty     → silent no-op
//   - paperclipIdentifier null           → warn + no-op (e.g. mirror created
//                                          with null projectId)
//   - linearBacklinkBestEffort = true    → warn-and-swallow on write failure
//   - default (false, strict rollout)    → re-throw so the caller fails loudly
//
// No echo-loop guard needed: registerWebhook in linear.ts subscribes to
// {Issue, Comment, IssueLabel, Project} only, not Attachment events.
async function writePaperclipBackLink(
  ctx: PluginContext,
  token: string,
  linearIssueId: string,
  linearIdentifier: string | null,
  paperclipIdentifier: string | null,
  paperclipIssueId: string,
  paperclipTitle?: string | null,
  paperclipCompanyId?: string | null,
): Promise<void> {
  if (!paperclipIdentifier) {
    ctx.logger.warn("Skipped Paperclip back-link: created issue has null identifier", {
      linearIdentifier,
      paperclipIssueId,
    });
    return;
  }
  const config = await ctx.config.get();
  const backLinkBestEffort = config.linearBacklinkBestEffort === true;
  const paperclipUrl = await buildPaperclipIssueUrl(ctx, paperclipCompanyId, paperclipIdentifier);
  if (!paperclipUrl) return;
  const title = paperclipTitle?.trim() ?? "";
  try {
    await linear.attachmentLinkURL(ctx.http.fetch.bind(ctx.http), token, {
      issueId: linearIssueId,
      url: paperclipUrl,
      title: `Paperclip mirror: ${paperclipIdentifier}`,
      subtitle: title ? `${paperclipIdentifier} - ${title}` : "Open in Paperclip",
      metadata: {
        source: "paperclip",
        paperclipIssueId,
        paperclipIdentifier,
        linearIdentifier: linearIdentifier ?? "",
        url: paperclipUrl,
        attributes: [
          { name: "Paperclip issue", value: paperclipIdentifier },
          { name: "Linear issue", value: linearIdentifier ?? "" },
          { name: "Paperclip issue ID", value: paperclipIssueId },
        ],
      },
    });
  } catch (err) {
    if (backLinkBestEffort) {
      ctx.logger.warn("Failed to add Paperclip back-link to Linear issue", {
        identifier: linearIdentifier,
        paperclipIdentifier,
        error: String(err),
      });
    } else {
      throw err;
    }
  }
}

async function writePaperclipProjectBackLink(
  ctx: PluginContext,
  token: string,
  link: sync.ProjectLink,
  paperclipProject?: { id: string; name?: string | null; description?: string | null; urlKey?: string | null } | null,
): Promise<void> {
  const project = paperclipProject ?? await getPaperclipProjectForLink(ctx, link);
  const paperclipUrl = await buildPaperclipProjectUrl(
    ctx,
    link.paperclipCompanyId,
    project ?? { id: link.paperclipProjectId },
  );
  if (!paperclipUrl) return;

  const config = await ctx.config.get();
  const bestEffort = config.linearBacklinkBestEffort === true;
  const label = "Paperclip project";
  try {
    await linear.ensureProjectLink(ctx.http.fetch.bind(ctx.http), token, {
      projectId: link.linearProjectId,
      url: paperclipUrl,
      label,
    });
    return;
  } catch (err) {
    const { baseUrl, companyPrefix } = await paperclipLinkOptionsForCompany(ctx, link.paperclipCompanyId);
    const fallbackDescription = appendPaperclipProjectBacklink(
      absolutizePaperclipMarkdownLinks(
        project?.description ?? "",
        baseUrl,
        companyPrefix,
      ),
      paperclipUrl,
    );
    try {
      await linear.updateProject(ctx.http.fetch.bind(ctx.http), token, link.linearProjectId, {
        description: fallbackDescription,
      });
      ctx.logger.warn("Linear project link API unavailable; wrote Paperclip backlink into project description", {
        linearProjectId: link.linearProjectId,
        paperclipProjectId: link.paperclipProjectId,
        error: String(err),
      });
    } catch (fallbackErr) {
      if (bestEffort) {
        ctx.logger.warn("Failed to add Paperclip back-link to Linear project", {
          linearProjectId: link.linearProjectId,
          paperclipProjectId: link.paperclipProjectId,
          error: String(fallbackErr),
          originalError: String(err),
        });
      } else {
        throw fallbackErr;
      }
    }
  }
}

async function getTeamId(ctx: PluginContext): Promise<string> {
  // Try state first (set during OAuth)
  const stored = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.oauthTeamId,
  });
  if (stored) return String(stored);

  const config = await ctx.config.get();
  const teamId = config.teamId as string | undefined;
  if (!teamId) throw new Error("teamId not configured");
  return teamId;
}

async function getCompanyId(ctx: PluginContext): Promise<string | null> {
  const stored = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.companyId,
  });
  return stored ? String(stored) : null;
}

async function refreshLinearWebhookRegistration(
  ctx: PluginContext,
  configOverride?: Record<string, unknown>,
): Promise<{ registered: boolean; reason?: string; webhookId?: string }> {
  const config = configOverride ?? await ctx.config.get();
  const baseUrl = normalizePaperclipBaseUrl(
    (config.paperclipBaseUrl as string | undefined) ?? DEFAULT_CONFIG.paperclipBaseUrl,
  );
  if (!baseUrl) return { registered: false, reason: "paperclipBaseUrl not configured" };

  let token: string;
  try {
    token = await resolveToken(ctx);
  } catch (err) {
    return { registered: false, reason: String(err) };
  }

  let teamId: string;
  try {
    teamId = await getTeamId(ctx);
  } catch (err) {
    return { registered: false, reason: String(err) };
  }

  const webhook = await linear.registerWebhook(ctx.http.fetch.bind(ctx.http), token, {
    teamId,
    url: `${baseUrl}/api/plugins/${PLUGIN_ID}/webhooks/${WEBHOOK_KEYS.linear}`,
    secret: (config.linearWebhookSigningSecret as string | undefined)?.trim(),
  });
  return { registered: true, webhookId: webhook.id };
}

/**
 * Resolve the Paperclip projectId for an incoming Linear issue.
 *
 * Resolution order:
 *   1. If the Linear issue carries a project id, look up the project link
 *      record and return its `paperclipProjectId`.
 *   2. If a `nameLookup` is provided (bulk import has an in-memory
 *      Linear-project-name → Paperclip-project-id map) and the Linear
 *      issue exposes a project name, return that.
 *   3. Fall back to the configured `defaultProjectId` from instance config
 *      — the CEO-editable bucket for un-projected Linear tickets. Empty
 *      string is treated as unset.
 *   4. If nothing resolves, return null. Caller may still create the issue
 *      without a project, but a warn is logged so we can spot regressions
 *      in the orphan audit.
 *
 * Origin of this helper: BLO-2350 — pre-fix, ~235 of 271 orphans were
 * Linear-imported issues with no projectId because none of the three
 * create paths (bulk import, webhook, manual import) consistently
 * resolved a project. This is the single chokepoint for that resolution.
 */
async function resolveProjectIdForLinearIssue(
  ctx: PluginContext,
  linearProject: { id?: string | null; name?: string | null } | null | undefined,
  identifierForLog?: string,
  nameLookup?: (name: string) => string | undefined,
): Promise<string | null> {
  const linearProjectId = linearProject?.id ?? null;
  if (linearProjectId) {
    const link = await sync.getProjectLinkByLinear(ctx, linearProjectId);
    if (link) return link.paperclipProjectId;
  }
  const linearProjectName = linearProject?.name ?? null;
  if (nameLookup && linearProjectName) {
    const matched = nameLookup(linearProjectName);
    if (matched) return matched;
  }
  const config = await ctx.config.get();
  const fallback = (config.defaultProjectId as string | undefined) ?? "";
  if (fallback) return fallback;
  ctx.logger.warn(
    `Linear import: no projectId resolved for ${identifierForLog ?? linearProjectId ?? "issue"} (no project link, no defaultProjectId configured)`,
  );
  return null;
}

/**
 * Resolve the Linear workspace url-key (e.g. `blockcast`) for linkifying bare
 * BLO-N refs at ingest. Prefers the value cached at OAuth-connect time; falls
 * back to parsing any candidate Linear URL the caller already has on hand
 * (webhook payload `data.url`, an existing `link.linearUrl`, etc.). Returns
 * null only when nothing is available — the linkifier degrades gracefully.
 */
async function resolveLinearWorkspaceSlug(
  ctx: PluginContext,
  ...candidates: Array<string | null | undefined>
): Promise<string | null> {
  const cached = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.workspaceUrlKey,
  });
  if (typeof cached === "string" && cached.length > 0) return cached;
  for (const c of candidates) {
    const slug = extractLinearWorkspaceSlug(c);
    if (slug) {
      // Self-heal: backfill the cache so subsequent calls skip the URL parse.
      // Best-effort — failures to write are silent (next call will retry).
      ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.workspaceUrlKey },
        slug,
      ).catch(() => undefined);
      return slug;
    }
  }
  return null;
}

/**
 * Resolve a Linear assignee's email to a Paperclip user id, with caching.
 *
 * Lazy-on-first-need: looks up `ctx.users.findByEmail` on first call for a
 * given email, then caches `linear-user-by-email:<email>` → paperclip user
 * id in plugin state so subsequent calls skip the round-trip. Returns null
 * if no Paperclip user has that email (Linear teammate hasn't signed up
 * for this Paperclip instance yet).
 */
async function resolvePaperclipUserIdForEmail(
  ctx: PluginContext,
  email: string | undefined | null,
): Promise<string | undefined> {
  if (!email) return undefined;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  const stateKey = `linear-user-by-email:${normalized}`;
  const cached = await ctx.state.get({ scopeKind: "instance", stateKey });
  // Positive cache: non-empty string id. Negative cache: "" (looked up, no match).
  // null means never queried — fall through to the lookup.
  if (typeof cached === "string" && cached.length > 0) return cached;
  if (cached === "") return undefined;

  try {
    const user = await ctx.users.findByEmail(normalized);
    const userId = user?.id ?? null;
    await ctx.state.set({ scopeKind: "instance", stateKey }, userId ?? "");
    return userId ?? undefined;
  } catch (err) {
    ctx.logger.warn(`Failed to resolve user by email ${normalized}: ${err}`);
    return undefined;
  }
}

const ISSUE_TITLE_INDEX_PAGE_SIZE = 200;

async function listExistingIssuesByExactTitle(
  ctx: PluginContext,
  companyId: string,
): Promise<Map<string, Issue[]>> {
  const byTitle = new Map<string, Issue[]>();
  let offset = 0;

  while (true) {
    const page = await ctx.issues.list({
      companyId,
      limit: ISSUE_TITLE_INDEX_PAGE_SIZE,
      offset,
    });
    if (page.length === 0) break;

    for (const issue of page) {
      const title = issue.title?.trim();
      if (!title) continue;
      const bucket = byTitle.get(title) ?? [];
      bucket.push(issue);
      byTitle.set(title, bucket);
    }

    if (page.length < ISSUE_TITLE_INDEX_PAGE_SIZE) break;
    offset += page.length;
  }

  return byTitle;
}

async function findUnlinkedExactTitleIssue(
  ctx: PluginContext,
  candidates: Issue[] | undefined,
  claimedIssueIds: Set<string>,
  preferredProjectId: string | null,
): Promise<Issue | null> {
  if (!candidates?.length) return null;
  const ordered = [...candidates].sort((a, b) => {
    const aProjectMatch = preferredProjectId && a.projectId === preferredProjectId ? 0 : 1;
    const bProjectMatch = preferredProjectId && b.projectId === preferredProjectId ? 0 : 1;
    if (aProjectMatch !== bProjectMatch) return aProjectMatch - bProjectMatch;
    const aOpen = a.status === "cancelled" || a.status === "done" ? 1 : 0;
    const bOpen = b.status === "cancelled" || b.status === "done" ? 1 : 0;
    return aOpen - bOpen;
  });

  for (const issue of ordered) {
    if (claimedIssueIds.has(issue.id)) continue;
    const existingLink = await sync.getLink(ctx, issue.id);
    if (!existingLink) return issue;
  }
  return null;
}

async function updateExistingPaperclipIssueFromLinear(
  ctx: PluginContext,
  issue: Issue,
  companyId: string,
  params: {
    linearIssue: linear.LinearIssue;
    description?: string;
    priority: Issue["priority"];
    status: Issue["status"];
    projectId: string | null;
    labelIds: string[];
    assigneeUserId?: string;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    title: params.linearIssue.title,
    priority: params.priority,
    originKind: ORIGIN_KIND_SELF,
    originId: params.linearIssue.id,
  };
  if (params.description !== undefined) patch.description = params.description;
  if (params.projectId && issue.projectId !== params.projectId) patch.projectId = params.projectId;
  if (params.labelIds.length > 0) patch.labelIds = params.labelIds;
  if (!issue.assigneeUserId && !issue.assigneeAgentId && params.assigneeUserId) {
    patch.assigneeUserId = params.assigneeUserId;
  }
  if (
    params.status !== "in_progress"
    || params.assigneeUserId
    || issue.assigneeUserId
    || issue.assigneeAgentId
  ) {
    patch.status = params.status;
  } else {
    ctx.logger.info(
      `Skipped in_progress status sync for ${params.linearIssue.identifier}: Linear assignee is not mapped to a Paperclip user`,
    );
  }

  try {
    await ctx.issues.update(issue.id, patch as Parameters<typeof ctx.issues.update>[1], companyId);
  } catch (err) {
    if (!("projectId" in patch)) throw err;
    const { projectId: _projectId, ...withoutProject } = patch;
    await ctx.issues.update(
      issue.id,
      withoutProject as Parameters<typeof ctx.issues.update>[1],
      companyId,
    );
    ctx.logger.warn(
      `Linear import relinked ${params.linearIssue.identifier} but could not move Paperclip issue ${issue.identifier ?? issue.id} to the Linear project: ${err}`,
    );
  }
}

async function applyImportedLinearStatus(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  status: string,
  assigneeUserId: string | undefined,
  identifier: string,
): Promise<void> {
  if (status === "backlog") return;
  if (status === "in_progress" && !assigneeUserId) {
    ctx.logger.info(
      `Skipped in_progress status sync for ${identifier}: Linear assignee is not mapped to a Paperclip user`,
    );
    return;
  }
  await ctx.issues.update(issueId, { status: status as Issue["status"] }, companyId);
}

async function createPluginLinkForExistingPaperclipIssue(
  ctx: PluginContext,
  issue: Issue,
  companyId: string,
  linearIssue: linear.LinearIssue,
): Promise<void> {
  await sync.createLink(ctx, {
    paperclipIssueId: issue.id,
    paperclipCompanyId: companyId,
    linearIssueId: linearIssue.id,
    linearIdentifier: linearIssue.identifier,
    linearUrl: linearIssue.url,
    linearStateType: linearIssue.state.type,
    syncDirection: "bidirectional",
  });
}


// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    currentCtx = ctx;
    ctx.logger.info("Linear Issue Sync plugin starting");

    // -----------------------------------------------------------------------
    // OAuth action handlers (called from settings UI)
    // -----------------------------------------------------------------------

    /** Generate the OAuth authorize URL for the user to open */
    ctx.actions.register(ACTION_KEYS.oauthStart, async (params: any) => {
      const config = await ctx.config.get();
      const clientId = config.linearClientId as string;
      if (!clientId) {
        return { error: "linearClientId not configured. Set it in plugin config." };
      }

      const { companyId, redirectUri } = params as {
        companyId: string;
        redirectUri: string;
      };

      // Store companyId and server URL for later use during import
      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        companyId,
      );

      // Generate a state token for CSRF protection
      const stateToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await ctx.state.set(
        { scopeKind: "instance", stateKey: `oauth-state:${stateToken}` },
        { companyId, createdAt: Date.now() },
      );

      const authUrl = new URL(LINEAR_OAUTH.authorizeUrl);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", LINEAR_OAUTH.scopes.join(","));
      authUrl.searchParams.set("state", stateToken);
      authUrl.searchParams.set("prompt", "consent");

      return { authorizeUrl: authUrl.toString(), state: stateToken };
    });

    /** Exchange OAuth code for token, detect team, store everything */
    ctx.actions.register(ACTION_KEYS.oauthCallback, async (params: any) => {
      const { code, state: stateToken } = params as { code: string; state: string };

      // Validate CSRF state
      const stateRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `oauth-state:${stateToken}`,
      });
      if (!stateRaw) {
        return { error: "Invalid or expired OAuth state. Please try again." };
      }
      // Clean up state token
      await ctx.state.delete({
        scopeKind: "instance",
        stateKey: `oauth-state:${stateToken}`,
      });

      const config = await ctx.config.get();
      const clientId = config.linearClientId as string;
      const clientSecret = config.linearClientSecret as string;
      if (!clientId || !clientSecret) {
        return { error: "OAuth client credentials not configured" };
      }

      // Determine redirect URI — the webhook endpoint on this plugin
      const redirectUri = (params as any).redirectUri as string;

      try {
        // Exchange code for token
        const tokenResponse = await linear.exchangeCodeForToken(
          ctx.http.fetch.bind(ctx.http),
          { code, clientId, clientSecret, redirectUri },
        );

        const token = tokenResponse.access_token;

        // Store token in plugin state
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
          token,
        );

        // Detect first team
        const teams = await linear.getTeams(ctx.http.fetch.bind(ctx.http), token);
        const team = teams[0];
        if (team) {
          await ctx.state.set(
            { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
            team.id,
          );
          await ctx.state.set(
            { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamKey },
            team.key,
          );
        }

        // Cache the workspace url-key (e.g. "blockcast") so the comment/
        // description linkifier can build full Linear urls without parsing
        // every link.linearUrl. Best-effort — failure here just leaves the
        // linkifier in its slug-less fallback mode.
        try {
          const org = await linear.getOrganization(ctx.http.fetch.bind(ctx.http), token);
          if (org?.urlKey) {
            await ctx.state.set(
              { scopeKind: "instance", stateKey: STATE_KEYS.workspaceUrlKey },
              org.urlKey,
            );
          }
        } catch (err) {
          ctx.logger.warn(`Failed to cache Linear workspace url-key: ${err}`);
        }

        // Mark as connected
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_KEYS.connected },
          {
            connectedAt: new Date().toISOString(),
            teamId: team?.id,
            teamKey: team?.key,
            teamName: team?.name,
          },
        );

        // Get highest issue number for the team
        let highestNumber = 0;
        if (team) {
          highestNumber = await linear.getHighestIssueNumber(
            ctx.http.fetch.bind(ctx.http),
            token,
            team.id,
          );
        }

        try {
          const webhookResult = await refreshLinearWebhookRegistration(ctx, config);
          if (webhookResult.registered) {
            ctx.logger.info(`Linear webhook registered: ${webhookResult.webhookId}`);
          } else {
            ctx.logger.warn(`Linear webhook registration skipped: ${webhookResult.reason}`);
          }
        } catch (err) {
          ctx.logger.warn(`Linear webhook registration failed: ${err}`);
        }

        ctx.logger.info(`Linear OAuth connected: team=${team?.key}, highestNumber=${highestNumber}`);

        return {
          connected: true,
          teamId: team?.id,
          teamKey: team?.key,
          teamName: team?.name,
          highestNumber,
        };
      } catch (err) {
        ctx.logger.error("OAuth callback failed", { error: String(err) });
        return { error: `OAuth failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    });

    /** Disconnect Linear: revoke token, delete secret, and clear state */
    ctx.actions.register(ACTION_KEYS.oauthDisconnect, async () => {
      try {
        const token = await resolveToken(ctx);
        await linear.revokeToken(ctx.http.fetch.bind(ctx.http), token);
      } catch {
        // Best effort — token may already be invalid
      }

      // Clear all OAuth state
      await ctx.state.delete({ scopeKind: "instance", stateKey: STATE_KEYS.oauthToken });
      await ctx.state.delete({ scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId });
      await ctx.state.delete({ scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamKey });
      await ctx.state.delete({ scopeKind: "instance", stateKey: STATE_KEYS.connected });

      ctx.logger.info("Linear disconnected");
      return { disconnected: true };
    });

    /** Get connection status (called from settings UI) */
    ctx.actions.register(ACTION_KEYS.oauthStatus, async () => {
      const connectedRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.connected,
      });

      // Also check if connected via server-managed OAuth (linearTokenRef in config)
      const config = await ctx.config.get();
      const hasConfigRef = !!(config.linearTokenRef as string | undefined);

      if (!connectedRaw && !hasConfigRef) {
        return { connected: false };
      }

      const info = (connectedRaw as Record<string, unknown>) ?? {};

      // Try to fetch live stats
      try {
        const token = await resolveToken(ctx);
        const teamId = (info.teamId ?? config.teamId) as string;
        if (teamId) {
          const highest = await linear.getHighestIssueNumber(
            ctx.http.fetch.bind(ctx.http),
            token,
            teamId,
          );
          return { connected: true, ...info, teamId, highestNumber: highest };
        }
        // Token resolved successfully — connected even without team info
        return { connected: true, ...info };
      } catch (err) {
        // Token resolution / live API call failed. Surface as disconnected so
        // the settings UI doesn't keep claiming "Connected" while every Linear
        // call 401s — that mismatch caused real operator confusion when a
        // long-lived OAuth token was server-side revoked but the cached
        // `connected` state row stayed truthy. Cached team metadata is
        // preserved under `lastConnectedAs` so the UI can render
        // "previously connected to team X" next to a reconnect prompt.
        const errMsg = err instanceof Error ? err.message : String(err);
        if (connectedRaw) {
          return { connected: false, error: errMsg, lastConnectedAs: info };
        }
        return { connected: false, error: "Token expired or invalid" };
      }
    });

    /** List available Linear teams */
    ctx.actions.register(ACTION_KEYS.listTeams, async () => {
      const token = await resolveToken(ctx);
      const teams = await linear.getTeams(ctx.http.fetch.bind(ctx.http), token);
      return { teams };
    });

    /**
     * Create a new Linear team and bind the plugin instance to it.
     * Used by onboarding to give each Paperclip company its own isolated team.
     */
    ctx.actions.register(ACTION_KEYS.createTeam, async (params: any) => {
      const { name, key, description } = params as {
        name: string;
        key: string;
        description?: string;
      };
      if (!name || !key) {
        throw new Error("createTeam requires both `name` and `key`");
      }

      const token = await resolveToken(ctx);
      const team = await linear.createTeam(
        ctx.http.fetch.bind(ctx.http),
        token,
        { name, key, description },
      );

      // Bind the new team to this plugin instance (same state the OAuth
      // callback populates when auto-detecting).
      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        team.id,
      );
      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamKey },
        team.key,
      );

      return { team };
    });

    /** Configure prefix/counter */
    ctx.actions.register(ACTION_KEYS.configure, async (params: any) => {
      const { teamId } = params as { teamId?: string };
      if (teamId) {
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
          teamId,
        );
        const token = await resolveToken(ctx);
        const teams = await linear.getTeams(ctx.http.fetch.bind(ctx.http), token);
        const team = teams.find((t) => t.id === teamId);
        if (team) {
          await ctx.state.set(
            { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamKey },
            team.key,
          );
        }

        // Refresh the `connected` state so oauth-status (which reads it as
        // the source of truth for displayed team) reflects the new selection.
        // Without this, switching teams updates oauth-team-{id,key} but the
        // UI keeps rendering the stale team that was current at OAuth time.
        const connectedRaw = await ctx.state.get({
          scopeKind: "instance",
          stateKey: STATE_KEYS.connected,
        });
        const connectedInfo =
          (connectedRaw && typeof connectedRaw === "object"
            ? (connectedRaw as Record<string, unknown>)
            : {});
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_KEYS.connected },
          {
            ...connectedInfo,
            teamId: team?.id ?? teamId,
            teamKey: team?.key,
            teamName: team?.name,
            updatedAt: new Date().toISOString(),
          },
        );

        try {
          const webhookResult = await refreshLinearWebhookRegistration(ctx);
          if (webhookResult.registered) {
            ctx.logger.info(`Linear webhook refreshed after team change: ${webhookResult.webhookId}`);
          }
        } catch (err) {
          ctx.logger.warn(`Linear webhook refresh after team change failed: ${err}`);
        }
      }
      return { ok: true };
    });

    /** Trigger import (called from settings UI after OAuth) */
    ctx.actions.register(ACTION_KEYS.triggerImport, async (params: any) => {
      const { companyId } = params as { companyId: string };

      // Store company ID for the import job
      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        companyId,
      );

      // Run import inline (not as a job — UI wants progress feedback)
      return await runImport(ctx);
    });

    /** Trigger a full re-sync of all linked issues */
    ctx.actions.register(ACTION_KEYS.triggerSync, async () => {
      return await runFullSync(ctx);
    });

    // One-time bounded backfill: write Paperclip back-links for already-mirrored
    // issues/projects that predate paperclipBaseUrl. Idempotent (Linear dedupes
    // by URL/external link), bounded per run, and resumable via offset cursors
    // in instance state.
    ctx.actions.register(ACTION_KEYS.backfillBackLinks, async (params: any) => {
      const { companyId } = params as { companyId: string };

      if (!(await resolvePaperclipBaseUrl(ctx))) {
        return {
          backfilled: 0,
          issueBackfilled: 0,
          projectBackfilled: 0,
          done: true,
          projectsDone: true,
          note: "paperclipBaseUrl not set; nothing to do",
        };
      }
      const token = await resolveToken(ctx);
      const options = params as {
        maxPerRun?: number;
        maxIssueBacklinksPerRun?: number;
        maxProjectBacklinksPerRun?: number;
      };
      const defaultMaxPerRun = Math.max(1, Number(options.maxPerRun ?? 100));
      const maxIssueBacklinks = Math.max(1, Number(options.maxIssueBacklinksPerRun ?? defaultMaxPerRun));
      const maxProjectBacklinks = Math.max(1, Number(options.maxProjectBacklinksPerRun ?? defaultMaxPerRun));
      const issuePageSize = Math.min(25, maxIssueBacklinks);
      const projectPageSize = Math.min(25, maxProjectBacklinks);

      const cursorKey = { scopeKind: "instance" as const, stateKey: "backfill-backlink-offset" };
      let offset = Number((await ctx.state.get(cursorKey)) ?? 0) || 0;

      let issueBackfilled = 0;
      let done = false;
      while (issueBackfilled < maxIssueBacklinks) {
        const page = await ctx.issues.list({
          companyId,
          originKindPrefix: ORIGIN_KIND_SELF,
          limit: Math.min(issuePageSize, maxIssueBacklinks - issueBackfilled),
          offset,
        });
        if (page.length === 0) { offset = 0; done = true; break; } // swept clean -> reset cursor

        for (const issue of page) {
          offset++; // advance over every scanned issue, linked or not
          const link = await sync.getLink(ctx, issue.id);
          if (!link) continue;
          await writePaperclipBackLink(
            ctx, token, link.linearIssueId, link.linearIdentifier,
            issue.identifier ?? null, issue.id, issue.title ?? null, companyId,
          );
          issueBackfilled++;
          if (issueBackfilled >= maxIssueBacklinks) break;
        }
        await ctx.state.set(cursorKey, offset);
        await new Promise((r) => setTimeout(r, 250)); // backoff between pages (Linear rate limits)
      }
      await ctx.state.set(cursorKey, offset);

      const projectCursorKey = { scopeKind: "instance" as const, stateKey: "backfill-project-backlink-offset" };
      let projectOffset = Number((await ctx.state.get(projectCursorKey)) ?? 0) || 0;

      let projectBackfilled = 0;
      let projectsDone = false;
      while (projectBackfilled < maxProjectBacklinks) {
        const page = await ctx.state.list({
          scopeKind: "instance",
          namespace: "default",
          stateKeyPrefix: STATE_KEYS.projectLinkPrefix,
          limit: Math.min(projectPageSize, maxProjectBacklinks - projectBackfilled),
          offset: projectOffset,
        });
        if (page.entries.length === 0) { projectOffset = 0; projectsDone = true; break; }

        for (const entry of page.entries) {
          projectOffset++;
          if (!isProjectLink(entry.value)) continue;
          if (entry.value.paperclipCompanyId !== companyId) continue;
          await writePaperclipProjectBackLink(ctx, token, entry.value);
          projectBackfilled++;
          if (projectBackfilled >= maxProjectBacklinks) break;
        }
        await ctx.state.set(projectCursorKey, projectOffset);
        await new Promise((r) => setTimeout(r, 250)); // backoff between pages (Linear rate limits)
      }
      await ctx.state.set(projectCursorKey, projectOffset);

      return {
        backfilled: issueBackfilled + projectBackfilled,
        issueBackfilled,
        projectBackfilled,
        offset,
        projectOffset,
        done,
        projectsDone,
      };
    });

    /** Link a Paperclip issue to a Linear issue (UI counterpart of the link tool). */
    ctx.actions.register(ACTION_KEYS.linkIssue, async (params: any) => {
      const { paperclipIssueId, linearRef, replaceExisting } = params as {
        paperclipIssueId: string;
        linearRef: string;
        replaceExisting?: boolean;
      };
      if (!paperclipIssueId || !linearRef) {
        return { ok: false, error: "paperclipIssueId and linearRef are required" };
      }

      const ref = linear.parseLinearIssueRef(linearRef);
      if (!ref) return { ok: false, error: "Could not parse Linear issue reference" };

      const existing = await sync.getLink(ctx, paperclipIssueId);
      if (existing && !replaceExisting) {
        return {
          ok: false,
          error: `Already linked to ${existing.linearIdentifier}. Pass replaceExisting=true to swap.`,
        };
      }

      const token = await resolveToken(ctx);
      const linearIssue = await linear.getIssueByIdentifier(
        ctx.http.fetch.bind(ctx.http),
        token,
        ref.identifier,
      );
      if (!linearIssue) return { ok: false, error: `${ref.identifier} not found in Linear` };

      const companyId = existing?.paperclipCompanyId ?? (await getCompanyId(ctx));
      if (!companyId) return { ok: false, error: "Company id is not configured for this plugin" };

      if (existing) {
        await sync.removeLink(ctx, paperclipIssueId);
      }

      const config = await ctx.config.get();
      const syncDirection = (config.syncDirection as sync.IssueLink["syncDirection"]) || "bidirectional";
      const link = await sync.createLink(ctx, {
        paperclipIssueId,
        paperclipCompanyId: companyId,
        linearIssueId: linearIssue.id,
        linearIdentifier: linearIssue.identifier,
        linearUrl: linearIssue.url,
        linearStateType: linearIssue.state.type,
        syncDirection,
      });

      try {
        const paperclipIssue = await ctx.issues.get(paperclipIssueId, companyId);
        await writePaperclipBackLink(
          ctx,
          token,
          linearIssue.id,
          linearIssue.identifier,
          paperclipIssue?.identifier ?? null,
          paperclipIssueId,
          paperclipIssue?.title ?? linearIssue.title,
          companyId,
        );
      } catch (err) {
        ctx.logger.warn(`Failed to write Paperclip back-link after manual link: ${err}`);
      }

      return {
        ok: true,
        linked: true,
        identifier: linearIssue.identifier,
        url: linearIssue.url,
        title: linearIssue.title,
        stateType: linearIssue.state.type,
        replaced: Boolean(existing),
        previousIdentifier: existing?.linearIdentifier ?? null,
        syncDirection: link.syncDirection,
      };
    });

    /** Remove the Linear link from a Paperclip issue (UI counterpart of the unlink tool). */
    ctx.actions.register(ACTION_KEYS.unlinkIssue, async (params: any) => {
      const { paperclipIssueId } = params as { paperclipIssueId: string };
      if (!paperclipIssueId) return { ok: false, error: "paperclipIssueId is required" };
      const removed = await sync.removeLink(ctx, paperclipIssueId);
      return { ok: true, unlinked: removed };
    });

    /**
     * Import a single Linear issue by identifier — including closed/cancelled
     * issues that the bulk-import filter skips. Creates a Paperclip issue and
     * link, or returns the existing one if already imported.
     */
    ctx.actions.register(ACTION_KEYS.importIssue, async (params: any) => {
      const { linearRef } = params as { linearRef: string };
      if (!linearRef) return { ok: false, error: "linearRef is required" };

      const ref = linear.parseLinearIssueRef(linearRef);
      if (!ref) return { ok: false, error: "Could not parse Linear issue reference" };

      const companyId = await getCompanyId(ctx);
      if (!companyId) {
        return { ok: false, error: "Company id is not configured for this plugin" };
      }

      const token = await resolveToken(ctx);
      const linearIssue = await linear.getIssueByIdentifier(
        ctx.http.fetch.bind(ctx.http),
        token,
        ref.identifier,
      );
      if (!linearIssue) return { ok: false, error: `${ref.identifier} not found in Linear` };

      const existing = await sync.getLinkByLinear(ctx, linearIssue.id);
      if (existing) {
        return {
          ok: true,
          alreadyImported: true,
          paperclipIssueId: existing.paperclipIssueId,
          identifier: linearIssue.identifier,
          url: linearIssue.url,
        };
      }

      const priorityMap: Record<number, string> = {
        0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
      };
      const statusMap: Record<string, string> = {
        backlog: "backlog", unstarted: "todo", started: "in_progress",
        completed: "done", canceled: "cancelled", cancelled: "cancelled",
      };
      const priority = priorityMap[linearIssue.priority] ?? "medium";
      const status = statusMap[linearIssue.state.type] ?? "backlog";
      const assigneeUserId = await resolvePaperclipUserIdForEmail(ctx, linearIssue.assignee?.email);
      const projectId = await resolveProjectIdForLinearIssue(
        ctx,
        linearIssue.project,
        linearIssue.identifier,
      );
      const workspaceSlug = await resolveLinearWorkspaceSlug(ctx, linearIssue.url);
      const description = linearIssue.description
        ? linkifyBareLinearIssueRefs(linearIssue.description, workspaceSlug)
        : undefined;

      const hostLinkedIssue = await ctx.issues.getByLinearIssueId({
        linearIssueId: linearIssue.id,
        companyId,
      });
      if (hostLinkedIssue) {
        await updateExistingPaperclipIssueFromLinear(ctx, hostLinkedIssue, companyId, {
          linearIssue,
          description,
          priority: priority as Issue["priority"],
          status: status as Issue["status"],
          projectId,
          labelIds: [],
          assigneeUserId,
        });
        await createPluginLinkForExistingPaperclipIssue(ctx, hostLinkedIssue, companyId, linearIssue);
        return {
          ok: true,
          imported: false,
          relinked: true,
          paperclipIssueId: hostLinkedIssue.id,
          identifier: linearIssue.identifier,
          url: linearIssue.url,
          alreadyImported: true,
        };
      }

      // Dedup by (originKind, originId) — skip if Paperclip already has an
      // issue tagged with this Linear issue id. Same (companyId, originKind,
      // originId) tuple is the only stable identity across re-imports.
      const existingByOrigin = await ctx.issues.list({
        companyId,
        originKind: ORIGIN_KIND_SELF,
        originId: linearIssue.id,
        limit: 1,
      });
      if (existingByOrigin.length > 0) {
        const existing = existingByOrigin[0]!;
        await updateExistingPaperclipIssueFromLinear(ctx, existing, companyId, {
          linearIssue,
          description,
          priority: priority as Issue["priority"],
          status: status as Issue["status"],
          projectId,
          labelIds: [],
          assigneeUserId,
        });
        await createPluginLinkForExistingPaperclipIssue(ctx, existing, companyId, linearIssue);
        return {
          ok: true,
          imported: false,
          relinked: true,
          paperclipIssueId: existing.id,
          identifier: linearIssue.identifier,
          url: linearIssue.url,
          alreadyImported: true,
        };
      }

      const exactTitleIndex = await listExistingIssuesByExactTitle(ctx, companyId);
      const exactTitleIssue = await findUnlinkedExactTitleIssue(
        ctx,
        exactTitleIndex.get(linearIssue.title.trim()),
        new Set(),
        projectId,
      );
      if (exactTitleIssue) {
        await updateExistingPaperclipIssueFromLinear(ctx, exactTitleIssue, companyId, {
          linearIssue,
          description,
          priority: priority as Issue["priority"],
          status: status as Issue["status"],
          projectId,
          labelIds: [],
          assigneeUserId,
        });
        await createPluginLinkForExistingPaperclipIssue(ctx, exactTitleIssue, companyId, linearIssue);
        return {
          ok: true,
          imported: false,
          relinked: true,
          paperclipIssueId: exactTitleIssue.id,
          identifier: linearIssue.identifier,
          url: linearIssue.url,
          alreadyImported: false,
        };
      }

      const created = await ctx.issues.create({
        companyId,
        title: linearIssue.title,
        description,
        priority: priority as "critical" | "high" | "medium" | "low",
        originKind: ORIGIN_KIND_SELF,
        originId: linearIssue.id,
        ...(projectId ? { projectId } : {}),
        ...(assigneeUserId ? { assigneeUserId } : {}),
        linkedLinearIssue: {
          id: linearIssue.id,
          identifier: linearIssue.identifier,
        },
      });

      await applyImportedLinearStatus(ctx, created.id, companyId, status, assigneeUserId, linearIssue.identifier);

      recentlyCreatedFromLinear.add(created.id);
      setTimeout(() => recentlyCreatedFromLinear.delete(created.id), 10_000);

      await sync.createLink(ctx, {
        paperclipIssueId: created.id,
        paperclipCompanyId: companyId,
        linearIssueId: linearIssue.id,
        linearIdentifier: linearIssue.identifier,
        linearUrl: linearIssue.url,
        linearStateType: linearIssue.state.type,
        syncDirection: "bidirectional",
      });

      // Back-link write — shared helper so the polling-import path here and
      // the Issue/create webhook handler emit the same attachment shape with
      // the same dedup + best-effort semantics. See writePaperclipBackLink.
      await writePaperclipBackLink(
        ctx,
        token,
        linearIssue.id,
        linearIssue.identifier,
        created.identifier,
        created.id,
        linearIssue.title,
        companyId,
      );

      return {
        ok: true,
        imported: true,
        paperclipIssueId: created.id,
        identifier: linearIssue.identifier,
        url: linearIssue.url,
        title: linearIssue.title,
        stateType: linearIssue.state.type,
      };
    });

    // -----------------------------------------------------------------------
    // Agent tools
    // -----------------------------------------------------------------------

    ctx.tools.register(
      TOOL_NAMES.search,
      { displayName: "Search Linear Issues", description: "Search Linear issues by query", parametersSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      async (params: any) => {
        const { query } = params as { query: string };
        const token = await resolveToken(ctx);
        const teamId = await getTeamId(ctx).catch(() => "");

        const results = await linear.searchIssues(ctx.http.fetch.bind(ctx.http), token, teamId, query);
        return {
          content: `Found ${results.totalCount} issues`,
          data: {
            total_count: results.totalCount,
            issues: results.issues.map((issue) => ({
              identifier: issue.identifier, title: issue.title,
              state: issue.state.name, url: issue.url,
              assignee: issue.assignee?.name ?? null,
            })),
          },
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.create,
      { displayName: "Create Linear Issue", description: "Create a new issue in Linear", parametersSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, teamId: { type: "string" } }, required: ["title"] } },
      async (params: any, runCtx) => {
        const { title, description, teamId: paramTeamId } = params as { title: string; description?: string; teamId?: string };
        const token = await resolveToken(ctx);
        const teamId = paramTeamId || await getTeamId(ctx).catch(() => "");
        if (!teamId) return { content: "Error: no team ID", data: { error: "No team ID specified" } };
        const paperclipLinkOptions = await paperclipLinkOptionsForCompany(ctx, runCtx.companyId);

        const issue = await linear.createIssue(ctx.http.fetch.bind(ctx.http), token, {
          title,
          description: description
            ? absolutizePaperclipMarkdownLinks(
                description,
                paperclipLinkOptions.baseUrl,
                paperclipLinkOptions.companyPrefix,
              )
            : undefined,
          teamId,
        });
        return {
          content: `Created ${issue.identifier}: ${issue.title}`,
          data: { identifier: issue.identifier, title: issue.title, url: issue.url },
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.resolveBinding,
      {
        displayName: "Resolve Linear Binding",
        description: "Resolve a Linear issue to its Paperclip mirror and project binding",
        parametersSchema: {
          type: "object",
          properties: {
            linearRef: {
              type: "string",
              description: "Linear issue identifier (e.g. BLO-123) or URL",
            },
          },
          required: ["linearRef"],
        },
      },
      async (params: any, runCtx) => {
        const { linearRef } = params as { linearRef?: string };
        const ref = linear.parseLinearIssueRef(linearRef ?? "");
        if (!ref) {
          return {
            content: "Error: invalid ref",
            data: {
              linked: false,
              syncState: "missing",
              foundPaperclipMirror: false,
              error: "Could not parse Linear issue reference",
            },
          };
        }

        const token = await resolveToken(ctx);
        const linearIssue = await linear.getIssueByIdentifier(
          ctx.http.fetch.bind(ctx.http),
          token,
          ref.identifier,
        );
        if (!linearIssue) {
          return {
            content: `Error: ${ref.identifier} not found`,
            data: {
              linked: false,
              syncState: "missing",
              foundPaperclipMirror: false,
              linear: { identifier: ref.identifier },
              error: `${ref.identifier} not found in Linear`,
            },
          };
        }

        const storedCompanyId = await getCompanyId(ctx);
        const link = await sync.getLinkByLinear(ctx, linearIssue.id);
        const companyCandidates = [
          link?.paperclipCompanyId,
          runCtx.companyId,
          storedCompanyId,
        ].filter((value): value is string => typeof value === "string" && value.length > 0)
          .filter((value, index, values) => values.indexOf(value) === index);

        let paperclipIssue: Record<string, unknown> | null = null;
        if (link) {
          try {
            paperclipIssue = await ctx.issues.get(
              link.paperclipIssueId,
              link.paperclipCompanyId,
            ) as unknown as Record<string, unknown> | null;
          } catch {
            paperclipIssue = null;
          }
        }

        if (!paperclipIssue) {
          for (const companyId of companyCandidates) {
            try {
              const candidate = await ctx.issues.getByLinearIssueId({
                linearIssueId: linearIssue.id,
                companyId,
              });
              if (candidate) {
                paperclipIssue = candidate as unknown as Record<string, unknown>;
                break;
              }
            } catch {
              // Host fallback may not be available in older runtimes.
            }
          }
        }

        if (!paperclipIssue) {
          for (const companyId of companyCandidates) {
            try {
              const mirrors = await ctx.issues.list({
                companyId,
                originKind: ORIGIN_KIND_SELF,
                originId: linearIssue.id,
                limit: 1,
              });
              if (mirrors[0]) {
                paperclipIssue = mirrors[0] as unknown as Record<string, unknown>;
                break;
              }
            } catch {
              // Keep resolver best-effort; the primary binding row is above.
            }
          }
        }

        const issueCompanyId = typeof paperclipIssue?.companyId === "string"
          ? paperclipIssue.companyId
          : link?.paperclipCompanyId ?? companyCandidates[0] ?? null;
        const paperclipIssueSummary = await summarizePaperclipIssue(
          ctx,
          paperclipIssue,
          issueCompanyId,
        );

        let projectLink: sync.ProjectLink | null = null;
        if (linearIssue.project?.id) {
          projectLink = await sync.getProjectLinkByLinear(ctx, linearIssue.project.id);
        }

        const paperclipProject = await getProjectById(
          ctx,
          paperclipIssueSummary?.projectId ?? projectLink?.paperclipProjectId ?? null,
          paperclipIssueSummary?.companyId ?? projectLink?.paperclipCompanyId ?? issueCompanyId,
        );
        const paperclipProjectSummary = await summarizePaperclipProject(
          ctx,
          paperclipProject,
          paperclipIssueSummary?.companyId ?? projectLink?.paperclipCompanyId ?? issueCompanyId,
        );

        const warning = !link && paperclipIssueSummary
          ? "Paperclip mirror was found through the host link/origin fallback, but plugin sync state is missing."
          : null;
        const content = link && paperclipIssueSummary?.identifier
          ? `Linear ${linearIssue.identifier} is linked to Paperclip ${paperclipIssueSummary.identifier}`
          : link
            ? `Linear ${linearIssue.identifier} has a sync link, but the Paperclip issue was not readable`
            : paperclipIssueSummary?.identifier
              ? `Linear ${linearIssue.identifier} has no plugin sync binding, but maps to Paperclip ${paperclipIssueSummary.identifier}`
              : `No Paperclip sync binding found for Linear ${linearIssue.identifier}`;

        return {
          content,
          data: {
            linked: Boolean(link),
            syncState: link ? "linked" : "missing",
            foundPaperclipMirror: Boolean(paperclipIssueSummary),
            warning,
            linear: {
              id: linearIssue.id,
              identifier: linearIssue.identifier,
              title: linearIssue.title,
              url: linearIssue.url,
              state: linearIssue.state,
              project: linearIssue.project
                ? {
                    id: linearIssue.project.id,
                    name: linearIssue.project.name,
                    state: linearIssue.project.state,
                  }
                : null,
            },
            paperclip: {
              issue: paperclipIssueSummary,
              project: paperclipProjectSummary,
            },
            projectLink: projectLink
              ? {
                  linearProjectId: projectLink.linearProjectId,
                  linearProjectName: projectLink.linearProjectName,
                  paperclipProjectId: projectLink.paperclipProjectId,
                  paperclipCompanyId: projectLink.paperclipCompanyId,
                  syncDirection: projectLink.syncDirection,
                  lastSyncAt: projectLink.lastSyncAt,
                }
              : null,
            issueLink: link
              ? {
                  linearIssueId: link.linearIssueId,
                  linearIdentifier: link.linearIdentifier,
                  paperclipIssueId: link.paperclipIssueId,
                  paperclipCompanyId: link.paperclipCompanyId,
                  syncDirection: link.syncDirection,
                  lastSyncAt: link.lastSyncAt,
                }
              : null,
          },
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.setBinding,
      {
        displayName: "Set Linear Binding",
        description: "Repair or create Paperclip/Linear issue and project sync bindings",
        parametersSchema: {
          type: "object",
          properties: {
            linearRef: { type: "string" },
            paperclipIssueId: { type: "string" },
            linearProjectId: { type: "string" },
            linearProjectName: { type: "string" },
            paperclipProjectId: { type: "string" },
            replaceExisting: { type: "boolean" },
            linkProjectFromIssue: { type: "boolean" },
            syncDirection: {
              type: "string",
              enum: ["bidirectional", "linear-to-paperclip", "paperclip-to-linear"],
            },
          },
        },
      },
      async (params: any, runCtx) => {
        const {
          linearRef,
          paperclipIssueId,
          linearProjectId,
          linearProjectName,
          paperclipProjectId,
          replaceExisting = false,
          linkProjectFromIssue = true,
          syncDirection,
        } = params as {
          linearRef?: string;
          paperclipIssueId?: string;
          linearProjectId?: string;
          linearProjectName?: string;
          paperclipProjectId?: string;
          replaceExisting?: boolean;
          linkProjectFromIssue?: boolean;
          syncDirection?: string;
        };

        const wantsIssueBinding = Boolean(linearRef || paperclipIssueId);
        const wantsProjectBinding = Boolean(linearProjectId || paperclipProjectId);
        if (!wantsIssueBinding && !wantsProjectBinding) {
          return {
            content: "Error: no binding target supplied",
            data: {
              ok: false,
              error: "Supply either linearRef + paperclipIssueId, or linearProjectId + paperclipProjectId.",
            },
          };
        }
        if (wantsIssueBinding && (!linearRef || !paperclipIssueId)) {
          return {
            content: "Error: incomplete issue binding",
            data: {
              ok: false,
              error: "Issue binding requires both linearRef and paperclipIssueId.",
            },
          };
        }
        if (wantsProjectBinding && (!linearProjectId || !paperclipProjectId)) {
          return {
            content: "Error: incomplete project binding",
            data: {
              ok: false,
              error: "Project binding requires both linearProjectId and paperclipProjectId.",
            },
          };
        }
        if (
          syncDirection
          && !["bidirectional", "linear-to-paperclip", "paperclip-to-linear"].includes(syncDirection)
        ) {
          return {
            content: "Error: invalid syncDirection",
            data: { ok: false, error: "Invalid syncDirection." },
          };
        }

        const companyId = runCtx.companyId || await getCompanyId(ctx);
        if (!companyId) {
          return {
            content: "Error: company id is not configured",
            data: { ok: false, error: "Company id is not configured for this plugin." },
          };
        }

        const config = await ctx.config.get();
        const effectiveSyncDirection = (
          syncDirection
          || (config.syncDirection as string | undefined)
          || "bidirectional"
        ) as sync.IssueLink["syncDirection"];
        const token = await resolveToken(ctx);
        const warnings: string[] = [];

        let linearIssue: linear.LinearIssue | null = null;
        let paperclipIssue: Record<string, unknown> | null = null;
        let issueLink: sync.IssueLink | null = null;
        let projectLink: sync.ProjectLink | null = null;

        if (wantsIssueBinding) {
          const ref = linear.parseLinearIssueRef(linearRef ?? "");
          if (!ref) {
            return {
              content: "Error: invalid ref",
              data: { ok: false, error: "Could not parse Linear issue reference." },
            };
          }

          linearIssue = await linear.getIssueByIdentifier(
            ctx.http.fetch.bind(ctx.http),
            token,
            ref.identifier,
          );
          if (!linearIssue) {
            return {
              content: `Error: ${ref.identifier} not found`,
              data: { ok: false, error: `${ref.identifier} not found in Linear.` },
            };
          }

          const issue = await ctx.issues.get(paperclipIssueId!, companyId);
          if (!issue) {
            return {
              content: "Error: Paperclip issue not found",
              data: {
                ok: false,
                error: `Paperclip issue ${paperclipIssueId} was not found in company ${companyId}.`,
              },
            };
          }
          paperclipIssue = issue as unknown as Record<string, unknown>;

          const existingByPaperclip = await sync.getLink(ctx, paperclipIssueId!);
          const existingByLinear = await sync.getLinkByLinear(ctx, linearIssue.id);
          const paperclipConflict = existingByPaperclip && existingByPaperclip.linearIssueId !== linearIssue.id;
          const linearConflict = existingByLinear && existingByLinear.paperclipIssueId !== paperclipIssueId;
          if ((paperclipConflict || linearConflict) && !replaceExisting) {
            return {
              content: "Error: conflicting issue binding exists",
              data: {
                ok: false,
                error: "Conflicting issue binding exists. Pass replaceExisting=true to repair it.",
                existingByPaperclip,
                existingByLinear,
              },
            };
          }

          if (replaceExisting) {
            const removeIssueIds = [
              existingByPaperclip?.paperclipIssueId,
              existingByLinear?.paperclipIssueId,
            ].filter((value): value is string => typeof value === "string" && value.length > 0)
              .filter((value, index, values) => values.indexOf(value) === index);
            for (const id of removeIssueIds) {
              await sync.removeLink(ctx, id);
            }
          }

          issueLink = await sync.createLink(ctx, {
            paperclipIssueId: paperclipIssueId!,
            paperclipCompanyId: companyId,
            linearIssueId: linearIssue.id,
            linearIdentifier: linearIssue.identifier,
            linearUrl: linearIssue.url,
            linearStateType: linearIssue.state.type,
            syncDirection: effectiveSyncDirection,
          });

          try {
            await writePaperclipBackLink(
              ctx,
              token,
              linearIssue.id,
              linearIssue.identifier,
              typeof paperclipIssue.identifier === "string" ? paperclipIssue.identifier : null,
              paperclipIssueId!,
              typeof paperclipIssue.title === "string" ? paperclipIssue.title : linearIssue.title,
              companyId,
            );
          } catch (err) {
            const message = `Failed to write Linear issue backlink: ${err}`;
            warnings.push(message);
            ctx.logger.warn(message);
          }
        }

        let targetPaperclipProjectId = paperclipProjectId;
        let targetLinearProjectId = linearProjectId;
        let targetLinearProjectName = linearProjectName;
        let targetLinearProjectState = "planned";
        const inferredProjectFromIssue = Boolean(
          !wantsProjectBinding
          && linkProjectFromIssue
          && linearIssue?.project?.id
          && typeof paperclipIssue?.projectId === "string"
          && paperclipIssue.projectId.length > 0,
        );

        if (inferredProjectFromIssue) {
          targetPaperclipProjectId = paperclipIssue!.projectId as string;
          targetLinearProjectId = linearIssue!.project!.id;
          targetLinearProjectName = linearIssue!.project!.name;
          targetLinearProjectState = linearIssue!.project!.state || "planned";
        } else if (wantsProjectBinding) {
          targetLinearProjectState = "planned";
        }

        if (targetPaperclipProjectId && targetLinearProjectId) {
          const paperclipProject = await getProjectById(ctx, targetPaperclipProjectId, companyId);
          if (!paperclipProject) {
            return {
              content: "Error: Paperclip project not found",
              data: {
                ok: false,
                error: `Paperclip project ${targetPaperclipProjectId} was not found in company ${companyId}.`,
              },
            };
          }

          const existingByPaperclipProject = await sync.getProjectLink(ctx, targetPaperclipProjectId);
          const existingByLinearProject = await sync.getProjectLinkByLinear(ctx, targetLinearProjectId);
          const paperclipProjectConflict = existingByPaperclipProject
            && existingByPaperclipProject.linearProjectId !== targetLinearProjectId;
          const linearProjectConflict = existingByLinearProject
            && existingByLinearProject.paperclipProjectId !== targetPaperclipProjectId;
          if ((paperclipProjectConflict || linearProjectConflict) && !replaceExisting) {
            return {
              content: "Error: conflicting project binding exists",
              data: {
                ok: false,
                error: "Conflicting project binding exists. Pass replaceExisting=true to repair it.",
                existingByPaperclipProject,
                existingByLinearProject,
              },
            };
          }

          if (replaceExisting) {
            const removeProjectIds = [
              existingByPaperclipProject?.paperclipProjectId,
              existingByLinearProject?.paperclipProjectId,
            ].filter((value): value is string => typeof value === "string" && value.length > 0)
              .filter((value, index, values) => values.indexOf(value) === index);
            for (const id of removeProjectIds) {
              await sync.removeProjectLink(ctx, id);
            }
          }

          projectLink = await sync.createProjectLink(ctx, {
            paperclipProjectId: targetPaperclipProjectId,
            paperclipCompanyId: companyId,
            linearProjectId: targetLinearProjectId,
            linearProjectName: targetLinearProjectName?.trim() || paperclipProject.name || targetLinearProjectId,
            linearState: targetLinearProjectState,
            syncDirection: effectiveSyncDirection,
          });

          try {
            await writePaperclipProjectBackLink(ctx, token, projectLink, paperclipProject);
          } catch (err) {
            const message = `Failed to write Linear project backlink: ${err}`;
            warnings.push(message);
            ctx.logger.warn(message);
          }
        }

        const issueSummary = await summarizePaperclipIssue(ctx, paperclipIssue, companyId);
        const projectSummary = await summarizePaperclipProject(
          ctx,
          projectLink ? await getProjectById(ctx, projectLink.paperclipProjectId, companyId) : null,
          companyId,
        );
        const parts = [
          issueLink ? `issue ${issueLink.linearIdentifier} -> ${issueSummary?.identifier ?? issueLink.paperclipIssueId}` : null,
          projectLink ? `project ${projectLink.linearProjectName} -> ${projectSummary?.name ?? projectLink.paperclipProjectId}` : null,
        ].filter((part): part is string => Boolean(part));

        return {
          content: `Set Linear binding: ${parts.join("; ")}`,
          data: {
            ok: true,
            issueLinked: Boolean(issueLink),
            projectLinked: Boolean(projectLink),
            warnings,
            issueLink,
            projectLink,
            linear: linearIssue
              ? {
                  id: linearIssue.id,
                  identifier: linearIssue.identifier,
                  title: linearIssue.title,
                  url: linearIssue.url,
                  project: linearIssue.project
                    ? {
                        id: linearIssue.project.id,
                        name: linearIssue.project.name,
                        state: linearIssue.project.state,
                      }
                    : null,
                }
              : null,
            paperclip: {
              issue: issueSummary,
              project: projectSummary,
            },
          },
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.link,
      { displayName: "Link Linear Issue", description: "Link a Linear issue to a Paperclip issue", parametersSchema: { type: "object", properties: { linearRef: { type: "string", description: "Linear issue identifier (e.g. LUC-123) or URL" }, paperclipIssueId: { type: "string", description: "Paperclip issue ID to link to" } }, required: ["linearRef", "paperclipIssueId"] } },
      async (params, runCtx) => {
        const { linearRef, paperclipIssueId } = params as { linearRef: string; paperclipIssueId: string };
        const ref = linear.parseLinearIssueRef(linearRef);
        if (!ref) return { content: "Error: invalid ref", data: { error: "Could not parse Linear issue reference" } };

        const issueId = paperclipIssueId;
        const companyId = runCtx.companyId;

        const existing = await sync.getLink(ctx, issueId);
        if (existing) return { content: "Error: already linked", data: { error: `Already linked to ${existing.linearIdentifier}` } };

        const token = await resolveToken(ctx);
        const linearIssue = await linear.getIssueByIdentifier(ctx.http.fetch.bind(ctx.http), token, ref.identifier);
        if (!linearIssue) return { content: "Error: not found", data: { error: `${ref.identifier} not found` } };

        const config = await ctx.config.get();
        const syncDirection = (config.syncDirection as sync.IssueLink["syncDirection"]) || "bidirectional";

        const link = await sync.createLink(ctx, {
          paperclipIssueId: issueId, paperclipCompanyId: companyId,
          linearIssueId: linearIssue.id, linearIdentifier: linearIssue.identifier,
          linearUrl: linearIssue.url, linearStateType: linearIssue.state.type, syncDirection,
        });

        try {
          const paperclipIssue = await ctx.issues.get(issueId, companyId);
          await writePaperclipBackLink(
            ctx,
            token,
            linearIssue.id,
            linearIssue.identifier,
            paperclipIssue?.identifier ?? null,
            issueId,
            paperclipIssue?.title ?? linearIssue.title,
            companyId,
          );
        } catch (err) {
          ctx.logger.warn(`Failed to write Paperclip back-link after link tool: ${err}`);
        }

        return {
          content: `Linked to ${linearIssue.identifier}`,
          data: { linked: true, identifier: linearIssue.identifier, url: linearIssue.url, syncDirection: link.syncDirection },
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.unlink,
      { displayName: "Unlink Linear Issue", description: "Remove the Linear sync link", parametersSchema: { type: "object", properties: { paperclipIssueId: { type: "string", description: "Paperclip issue ID to unlink" } }, required: ["paperclipIssueId"] } },
      async (params: any) => {
        const { paperclipIssueId } = params as { paperclipIssueId: string };
        const removed = await sync.removeLink(ctx, paperclipIssueId);
        return { content: removed ? "Unlinked" : "No link found", data: { unlinked: removed } };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.markDuplicate,
      { displayName: "Mark Linear Duplicate", description: "Mark one Linear issue as a native duplicate of another", parametersSchema: { type: "object", properties: { dupeRef: { type: "string", description: "Linear identifier/URL of the duplicate issue" }, keeperRef: { type: "string", description: "Linear identifier/URL of the keeper issue" } }, required: ["dupeRef", "keeperRef"] } },
      async (params) => {
        const { dupeRef, keeperRef } = params as { dupeRef: string; keeperRef: string };
        const dupe = linear.parseLinearIssueRef(dupeRef);
        const keeper = linear.parseLinearIssueRef(keeperRef);
        if (!dupe || !keeper) {
          return { content: "Error: invalid ref", data: { error: "Could not parse dupe/keeper Linear reference" } };
        }
        const token = await resolveToken(ctx);
        const fetch = ctx.http.fetch.bind(ctx.http);
        const dupeIssue = await linear.getIssueByIdentifier(fetch, token, dupe.identifier);
        const keeperIssue = await linear.getIssueByIdentifier(fetch, token, keeper.identifier);
        if (!dupeIssue) return { content: "Error: dupe not found", data: { error: `${dupe.identifier} not found` } };
        if (!keeperIssue) return { content: "Error: keeper not found", data: { error: `${keeper.identifier} not found` } };

        const config = await ctx.config.get();
        const bestEffort = config.linearBacklinkBestEffort === true;
        try {
          const res = await linear.markDuplicate(fetch, token, dupeIssue.id, keeperIssue.id);
          const content = res.alreadyRelated
            ? `${dupe.identifier} already a duplicate of ${keeper.identifier}`
            : res.success
              ? `Marked ${dupe.identifier} as duplicate of ${keeper.identifier}`
              : `Warning: Linear reported the duplicate relation was not created (success=false) for ${dupe.identifier} → ${keeper.identifier}`;
          return {
            content,
            data: { ...res, dupe: dupe.identifier, keeper: keeper.identifier },
          };
        } catch (err) {
          if (bestEffort) {
            ctx.logger.warn("markDuplicate failed (best-effort)", { dupe: dupe.identifier, keeper: keeper.identifier, error: String(err) });
            return { content: "Warning: mark duplicate failed (best-effort)", data: { error: String(err), dupe: dupe.identifier, keeper: keeper.identifier } };
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // Events: bidirectional sync
    // -----------------------------------------------------------------------

    ctx.events.on("issue.updated", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const issueId = (event.entityId ?? payload?.id) as string | undefined;
      if (!issueId) return;

      // Skip if this update came from the Linear webhook (prevents feedback loop)
      if (payload?.source === "linear") return;

      const link = await sync.getLink(ctx, issueId);
      if (!link) return;

      const changes: sync.SyncChanges = {};
      if (payload?.status) changes.status = payload.status as string;
      if (payload?.priority) changes.priority = payload.priority as string;
      if (payload?.title) changes.title = payload.title as string;
      if (payload?.description !== undefined) changes.description = payload.description as string;
      if (payload?.estimate !== undefined) changes.estimate = payload.estimate as number | null;
      if (payload?.dueDate !== undefined) changes.dueDate = payload.dueDate as string | null;

      if (Object.keys(changes).length === 0) return;

      try {
        const token = await resolveToken(ctx);
        const teamId = await getTeamId(ctx);
        await sync.syncToLinear(
          ctx,
          link,
          changes,
          token,
          teamId,
          await paperclipLinkOptionsForCompany(ctx, link.paperclipCompanyId),
        );
      } catch (err) {
        ctx.logger.error("Failed to sync to Linear", { error: String(err) });
      }
    });

    ctx.events.on("issue.created", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const issueId = (event.entityId ?? payload?.id) as string | undefined;

      ctx.logger.info(`issue.created event received: issueId=${issueId}, entityId=${event.entityId}, payloadKeys=${payload ? Object.keys(payload).join(",") : "none"}`);

      if (!issueId) { ctx.logger.info("issue.created: no issueId, skipping"); return; }

      // Skip if this issue was created by the Linear webhook (prevents feedback loop)
      if (payload?.source === "linear") { ctx.logger.info("issue.created: source=linear, skipping"); return; }
      // Race-safe defense for webhook-imported mirrors.
      //
      // The Issue.create webhook handler below calls `ctx.issues.create` with
      // `originKind: ORIGIN_KIND_SELF`. The host stamps that value onto the
      // issue row during the insert and surfaces it via the issue.created
      // event payload (plugin-host-services.ts's logPluginActivity → activity-log.ts's
      // publishPluginDomainEvent, which spreads `details.originKind` into
      // `event.payload`).
      //
      // This is the only race-safe gate against the feedback push. The
      // `recentlyCreatedFromLinear` Set check below is populated AFTER
      // `ctx.issues.create` resolves (via `recentlyCreatedFromLinear.add` in
      // the Issue.create webhook branch). publishPluginDomainEvent is
      // fire-and-forget (`void bus.emit().then(...)`), so this handler can run
      // in a later microtask BEFORE the Set.add lands — leaving the Set empty
      // and producing a duplicate Linear issue (the 2026-05-03 runaway-loop
      // pattern; see prior-incident note in the Issue.create branch).
      //
      // `normalizePluginOriginKind` in plugin-host-services.ts permits
      // sub-origin extensions like `${ORIGIN_KIND_SELF}:<sub>`, so this gate
      // accepts both the bare value and any sub-origin form. Exact `===` alone
      // would silently miss any future sub-origin path.
      //
      // The Set-based check below remains as a defense-in-depth fallback for
      // any non-originKind webhook-import path that may be added later.
      if (
        payload?.originKind === ORIGIN_KIND_SELF ||
        (typeof payload?.originKind === "string" &&
          payload.originKind.startsWith(`${ORIGIN_KIND_SELF}:`))
      ) {
        ctx.logger.info(
          `issue.created: originKind=${String(payload.originKind)}, skipping (webhook-imported mirror)`,
        );
        return;
      }
      if (recentlyCreatedFromLinear.has(issueId)) { ctx.logger.info("issue.created: recently created from linear, skipping"); return; }

      const config = await ctx.config.get();
      const syncDirection = (config.syncDirection as string) || "bidirectional";
      if (syncDirection === "linear-to-paperclip") { ctx.logger.info("issue.created: syncDirection=linear-to-paperclip, skipping"); return; }

      const companyId = await getCompanyId(ctx);
      if (!companyId) { ctx.logger.info("issue.created: no companyId stored, skipping"); return; }

      // Skip if already linked (e.g. created via import or link tool)
      const existingLink = await sync.getLink(ctx, issueId);
      if (existingLink) { ctx.logger.info("issue.created: already linked, skipping"); return; }

      try {
        const token = await resolveToken(ctx);
        const teamId = await getTeamId(ctx);

        const title = (payload?.title as string) ?? "Untitled";
        const paperclipLinkOptions = await paperclipLinkOptionsForCompany(ctx, companyId, payload?.identifier as string | undefined);
        const description = payload?.description
          ? absolutizePaperclipMarkdownLinks(
              payload.description as string,
              paperclipLinkOptions.baseUrl,
              paperclipLinkOptions.companyPrefix,
            )
          : undefined;
        const priority = payload?.priority as string | undefined;

        const priorityMap: Record<string, number> = {
          critical: 1, high: 2, medium: 3, low: 4,
        };

        const linearIssue = await linear.createIssue(
          ctx.http.fetch.bind(ctx.http),
          token,
          {
            title,
            description,
            teamId,
            priority: priority ? priorityMap[priority] : undefined,
          },
        );

        await sync.createLink(ctx, {
          paperclipIssueId: issueId,
          paperclipCompanyId: companyId,
          linearIssueId: linearIssue.id,
          linearIdentifier: linearIssue.identifier,
          linearUrl: linearIssue.url,
          linearStateType: linearIssue.state.type,
          syncDirection: syncDirection as sync.IssueLink["syncDirection"],
        });

        await writePaperclipBackLink(
          ctx,
          token,
          linearIssue.id,
          linearIssue.identifier,
          (payload?.identifier as string | undefined) ?? null,
          issueId,
          title,
          companyId,
        );

        await ctx.activity.log({
          companyId,
          message: `issue.pushed_to_linear`,
          entityType: "issue",
          entityId: issueId,
          metadata: { source: "paperclip", identifier: linearIssue.identifier, title, action: "pushed" },
        });

        ctx.logger.info(`Created Linear issue for Paperclip issue: ${linearIssue.identifier}`);
      } catch (err) {
        ctx.logger.error(`Failed to create Linear issue: ${err}`);
      }
    });

    ctx.events.on("project.created", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const projectId = (event.entityId ?? payload?.id) as string | undefined;
      if (!projectId || payload?.source === "linear") return;

      const existing = await sync.getProjectLink(ctx, projectId);
      if (existing) return;

      const companyId = await getCompanyId(ctx);
      if (!companyId) return;

      try {
        const token = await resolveToken(ctx);
        const teamId = await getTeamId(ctx);
        const name = (payload?.name as string) ?? "Untitled";
        const paperclipLinkOptions = await paperclipLinkOptionsForCompany(ctx, companyId);
        const description = payload?.description
          ? absolutizePaperclipMarkdownLinks(
              payload.description as string,
              paperclipLinkOptions.baseUrl,
              paperclipLinkOptions.companyPrefix,
            )
          : undefined;
        const status = (payload?.status as string) ?? "backlog";

        const linearState = sync.paperclipProjectStateToLinear(status);
        const created = await linear.createProject(ctx.http.fetch.bind(ctx.http), token, {
          name, description, teamIds: [teamId], state: linearState,
        });

        const link = await sync.createProjectLink(ctx, {
          paperclipProjectId: projectId,
          paperclipCompanyId: companyId,
          linearProjectId: created.id,
          linearProjectName: created.name,
          linearState,
          syncDirection: "bidirectional",
        });

        await writePaperclipProjectBackLink(ctx, token, link, {
          id: projectId,
          name,
          description,
        });

        await ctx.activity.log({
          companyId,
          message: `project.pushed_to_linear`,
          entityType: "project",
          entityId: projectId,
          metadata: { source: "paperclip", projectName: name, linearProjectId: created.id, action: "pushed" },
        });

        ctx.logger.info(`Created Linear project for Paperclip project: ${name}`);
      } catch (err) {
        ctx.logger.error(`Failed to create Linear project: ${err}`);
      }
    });

    ctx.events.on("project.updated", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const projectId = (event.entityId ?? payload?.id) as string | undefined;
      if (!projectId || payload?.source === "linear") return;

      const link = await sync.getProjectLink(ctx, projectId);
      if (!link) return;

      const changes: { name?: string; description?: string; status?: string } = {};
      if (payload?.name) changes.name = payload.name as string;
      if (payload?.description !== undefined) changes.description = payload.description as string;
      if (payload?.status) changes.status = payload.status as string;

      if (Object.keys(changes).length === 0) return;

      try {
        const token = await resolveToken(ctx);
        const project = await getPaperclipProjectForLink(ctx, link);
        await sync.syncProjectToLinear(
          ctx,
          link,
          changes,
          token,
          await paperclipLinkOptionsForCompany(ctx, link.paperclipCompanyId),
        );
        await writePaperclipProjectBackLink(ctx, token, link, project);
      } catch (err) {
        ctx.logger.error(`Failed to sync project to Linear: ${err}`);
      }
    });

    // -----------------------------------------------------------------------
    // Goal events: paperclip → Linear (one-way)
    //
    // Each Paperclip goal becomes a Linear Issue inside the "Company Goals"
    // project. Title, description, status and target date sync forward; we
    // do NOT pull Linear-side edits back, since goals are first-class in
    // Paperclip and the Linear mirror is for the Gantt view.
    // -----------------------------------------------------------------------
    ctx.events.on("goal.created", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const goalId = (event.entityId ?? payload?.id) as string | undefined;
      if (!goalId) return;

      // Avoid echo: a goal we just created from a Linear initiative webhook
      // would otherwise push right back to Linear as a duplicate initiative.
      if (recentlyCreatedGoalFromLinear.has(goalId)) {
        ctx.logger.info(`goal.created: ${goalId} was synced from Linear, skipping outbound push`);
        return;
      }

      const companyId = await getCompanyId(ctx);
      if (!companyId) return;

      try {
        await pushGoalToLinear(ctx, companyId, goalId);
      } catch (err) {
        ctx.logger.error("Failed to sync goal to Linear", { error: String(err) });
      }
    });

    ctx.events.on("goal.updated", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const goalId = (event.entityId ?? payload?.id) as string | undefined;
      if (!goalId) return;

      const companyId = await getCompanyId(ctx);
      if (!companyId) return;

      try {
        await pushGoalToLinear(ctx, companyId, goalId);
      } catch (err) {
        ctx.logger.error("Failed to sync goal update to Linear", { error: String(err) });
      }
    });

    ctx.events.on("issue.comment.created", async (event) => {
      const config = await ctx.config.get();
      if (!config.syncComments) return;

      const payload = event.payload as Record<string, unknown> | undefined;
      const issueId = (payload?.issueId ?? event.entityId) as string | undefined;
      const body = payload?.body as string | undefined;
      const authorName = (payload?.authorName as string) || "Paperclip user";
      if (!issueId || !body) return;

      const link = await sync.getLink(ctx, issueId);
      if (!link) return;

      try {
        const token = await resolveToken(ctx);
        await sync.bridgeCommentToLinear(
          ctx,
          link,
          token,
          body,
          authorName,
          await paperclipLinkOptionsForCompany(ctx, link.paperclipCompanyId),
        );
      } catch (err) {
        ctx.logger.error("Failed to bridge comment to Linear", { error: String(err) });
      }
    });

    // -----------------------------------------------------------------------
    // Scheduled jobs
    // -----------------------------------------------------------------------

    ctx.jobs.register(JOB_KEYS.periodicSync, async () => {
      ctx.logger.info("Running periodic Linear sync");
      try {
        const result = await runFullSync(ctx);
        ctx.logger.info(`Periodic sync complete: ${JSON.stringify(result)}`);
      } catch (err) {
        ctx.logger.error("Periodic sync failed", { error: String(err) });
      }
    });

    ctx.jobs.register(JOB_KEYS.initialImport, async () => {
      ctx.logger.info("Starting initial Linear issue import (job)");
      try {
        const result = await runImport(ctx);
        ctx.logger.info(`Initial import complete: ${JSON.stringify(result)}`);
      } catch (err) {
        ctx.logger.error("Initial import job failed", { error: String(err) });
      }
    });

    // -----------------------------------------------------------------------
    // UI data providers
    // -----------------------------------------------------------------------

    ctx.data.register(DATA_KEYS.issueLink, async (params: any) => {
      const issueId = params.issueId as string | undefined;
      if (!issueId) return { linked: false };
      const link = await sync.getLink(ctx, issueId);
      if (!link) return { linked: false };

      try {
        const token = await resolveToken(ctx);
        const linearIssue = await linear.getIssue(ctx.http.fetch.bind(ctx.http), token, link.linearIssueId);
        return {
          linked: true,
          linear: {
            identifier: linearIssue.identifier, title: linearIssue.title,
            state: linearIssue.state.name, stateType: linearIssue.state.type,
            url: linearIssue.url, assignee: linearIssue.assignee?.name ?? null,
          },
          syncDirection: link.syncDirection,
          lastSyncAt: link.lastSyncAt,
        };
      } catch {
        return {
          linked: true,
          linear: { identifier: link.linearIdentifier, url: link.linearUrl },
          syncDirection: link.syncDirection, lastSyncAt: link.lastSyncAt, fetchError: true,
        };
      }
    });

    ctx.data.register(DATA_KEYS.connectionStatus, async () => {
      const connectedRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.connected,
      });
      if (!connectedRaw) return { connected: false };
      return { connected: true, ...(connectedRaw as Record<string, unknown>) };
    });

    ctx.logger.info("Linear Issue Sync plugin ready");
  },

  // -------------------------------------------------------------------------
  // Webhook handler: Linear events
  // -------------------------------------------------------------------------
  async onWebhook(input: PluginWebhookInput) {
    const ctx = currentCtx;
    if (!ctx) return;

    const config = await ctx.config.get();
    const signingSecret = config.linearWebhookSigningSecret as string | undefined;
    if (signingSecret) {
      if (!verifyLinearSignature(signingSecret, input.rawBody, input.headers["linear-signature"])) {
        ctx.logger.warn("Rejected Linear webhook: signature mismatch");
        throw new Error("Invalid Linear webhook signature");
      }
    } else {
      ctx.logger.warn("Linear webhook signature check skipped — linearWebhookSigningSecret not configured");
    }

    const body = input.parsedBody as Record<string, unknown> | undefined;
    if (!body) return;

    const action = body.action as string | undefined;
    const type = body.type as string | undefined;
    const data = body.data as Record<string, unknown> | undefined;

    if (!data || !type || !action) return;

    ctx.logger.info(`Webhook: type=${type} action=${action} id=${data.id}`);

    try {
      await handleWebhookEvent(ctx, type, action, data);
    } catch (err) {
      ctx.logger.error("Webhook handler error", { error: String(err) });
    }
  },

  async onHealth() {
    return { status: "ok" as const, message: "Linear Issue Sync operational" };
  },

  async onConfigChanged(newConfig) {
    const ctx = currentCtx;
    if (!ctx) return;
    try {
      const webhookResult = await refreshLinearWebhookRegistration(ctx, newConfig);
      if (webhookResult.registered) {
        ctx.logger.info(`Linear webhook refreshed after config change: ${webhookResult.webhookId}`);
      } else {
        ctx.logger.warn(`Linear webhook refresh skipped after config change: ${webhookResult.reason}`);
      }
    } catch (err) {
      ctx.logger.warn(`Linear webhook refresh after config change failed: ${err}`);
    }
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Must have either OAuth credentials or a token ref
    // Note: client secret may be in a Paperclip secret (not visible in config)
    const hasOAuth = !!config.linearClientId;
    const hasTokenRef = !!config.linearTokenRef;
    if (!hasOAuth && !hasTokenRef) {
      warnings.push(
        "Configure either OAuth credentials (linearClientId) or a linearTokenRef to connect to Linear.",
      );
    }
    return { ok: errors.length === 0, errors, warnings };
  },
});

// ---------------------------------------------------------------------------
// Webhook event processing
// ---------------------------------------------------------------------------

async function handleWebhookEvent(
  ctx: PluginContext,
  type: string,
  action: string,
  data: Record<string, unknown>,
): Promise<void> {
  const linearIssueId = data.id as string;

  // --- Issue events ---
  if (type === "Issue") {
    if (action === "update") {
      const link = await sync.getLinkByLinear(ctx, linearIssueId);
      if (!link) return;

      // Build a fake LinearIssue from webhook data for syncFromLinear
      const state = data.state as Record<string, unknown> | undefined;
      const stateType = (state?.type as string) ?? link.lastLinearStateType;
      const stateName = (state?.name as string) ?? stateType;
      const webhookAssignee =
        (data.assignee as { name?: string | null; email?: string | null } | null | undefined) ?? null;

      const fakeIssue: linear.LinearIssue = {
        id: linearIssueId,
        identifier: (data.identifier as string) ?? link.linearIdentifier,
        title: (data.title as string) ?? "",
        description: (data.description as string | null) ?? null,
        state: { name: stateName, type: stateType },
        priority: (data.priority as number) ?? 0,
        url: link.linearUrl,
        assignee: webhookAssignee?.email
          ? { name: webhookAssignee.name ?? "", email: webhookAssignee.email }
          : null,
        labels: { nodes: [] },
        project: null,
        createdAt: "",
        updatedAt: "",
      };

      await sync.syncFromLinear(ctx, link, fakeIssue);

      // Also sync fields that syncFromLinear doesn't cover
      const extraPatch: Record<string, unknown> = {};
      if (data.estimate !== undefined) extraPatch.estimate = data.estimate;
      if (data.dueDate !== undefined) extraPatch.dueDate = data.dueDate;
      if (Object.keys(extraPatch).length > 0) {
        await ctx.issues.update(link.paperclipIssueId, extraPatch as any, link.paperclipCompanyId);
      }

      ctx.logger.info(`Webhook synced issue update: ${link.linearIdentifier}`);

      // Backfill the Paperclip back-link on the update path too: idempotent
      // (Linear dedupes the attachment by URL) and best-effort by config. Covers
      // mirrors that predate paperclipBaseUrl or were only ever updated. Wrapped
      // in try/catch like the create path so a strict-mode back-link failure
      // doesn't make Linear retry the whole webhook (the sync already committed).
      try {
        const pcIssue = await ctx.issues.get(link.paperclipIssueId, link.paperclipCompanyId);
        const linearToken = await resolveToken(ctx);
        await writePaperclipBackLink(
          ctx,
          linearToken,
          linearIssueId,
          link.linearIdentifier,
          pcIssue?.identifier ?? null,
          link.paperclipIssueId,
          pcIssue?.title ?? null,
          link.paperclipCompanyId,
        );
      } catch (err) {
        ctx.logger.warn(`Webhook update back-link write failed for ${link.linearIdentifier}: ${err}`);
      }

    } else if (action === "create") {
      const config = await ctx.config.get();
      if (config.disableLinearOriginatedCreates !== false) {
        const linearIdentifier = (data.identifier as string | undefined) ?? linearIssueId;
        ctx.logger.info(
          `Skipping Linear issue.create webhook for ${linearIdentifier} (disableLinearOriginatedCreates=true; use Link Linear Issue action for explicit pair)`,
        );
        return;
      }

      // New issue created in Linear → create in Paperclip
      const companyId = await getCompanyId(ctx);
      if (!companyId) return;

      const existing = await sync.getLinkByLinear(ctx, linearIssueId);
      if (existing) return;

      // Host-side link dedup: when a paperclip issue is created via the
      // host's allocator path (companies.identifier_provider='linear' →
      // allocateFromLinear → linear_issue_links insert in same tx), the
      // resulting paperclip row carries the CALLER's originKind (e.g.
      // 'manual', 'harness_liveness_escalation') — NOT the plugin's. The
      // plugin's existingByOrigin check below filters on
      // originKind='plugin:paperclip-plugin-linear' so it misses host-
      // allocator mirrors entirely. Without this lookup the inbound Linear
      // webhook (fired in response to the host's IssueCreate mutation)
      // proceeds to create a SECOND paperclip mirror, which mints ANOTHER
      // Linear issue, which fires another webhook — closing a runaway loop
      // that under cutover produced 305 noise Linear issues + 161 paperclip
      // rows in ~2 minutes during 2026-05-03 verify.
      const hostLinkedIssue = await ctx.issues.getByLinearIssueId({
        linearIssueId,
        companyId,
      });
      if (hostLinkedIssue) {
        // Webhook re-delivery on a host-allocator-mirrored issue: same
        // assigneeUserId backfill the existingByOrigin branch below
        // performs (lines ~1340-1351). Without this, a host-allocator
        // mirror's first webhook re-delivery never resolves its human
        // assignee — the legacy branch handled it for plugin mirrors
        // but the new dedup branch returned early and skipped it.
        const webhookAssignee = (data.assignee as { email?: string | null } | null | undefined) ?? null;
        const existingAssigneeUserId =
          (hostLinkedIssue as unknown as { assigneeUserId?: string | null }).assigneeUserId;
        if (!existingAssigneeUserId && webhookAssignee?.email) {
          const userId = await resolvePaperclipUserIdForEmail(ctx, webhookAssignee.email);
          if (userId) {
            await ctx.issues.update(hostLinkedIssue.id, { assigneeUserId: userId }, companyId);
          }
        }
        ctx.logger.info(
          `Webhook create for ${linearIssueId} already mirrored via host allocator path (paperclip ${hostLinkedIssue.identifier}); skipping`,
        );
        return;
      }

      // Prevent duplicate creation from simultaneous webhook deliveries
      if (inFlightCreates.has(linearIssueId)) {
        ctx.logger.info(`Skipping duplicate webhook create for ${linearIssueId} — already in flight`);
        return;
      }
      inFlightCreates.add(linearIssueId);

      // `data.identifier` is what the conditional `linkedLinearIssue` spread
      // below depends on — without it, the create call falls through to the
      // host allocator's MINT path under identifier_provider='linear' and
      // creates a duplicate Linear issue. That is the original 2026-05-03
      // loop-trigger condition. We MUST resolve identifier before continuing.
      //
      // Linear's stable webhook payload includes identifier; older formats
      // and replays can omit it. We fetch from Linear's API as fallback.
      // If both fail under cutover, we ABORT the webhook (rethrow) rather
      // than degrade to the mint path — Linear's webhook delivery layer
      // will retry with backoff, and that's strictly safer than spawning
      // a duplicate Linear issue under the bug-amplification conditions
      // (rate-limit / 5xx during peak load) we have to assume on this path.
      let identifier = data.identifier as string | undefined;
      if (!identifier) {
        try {
          const token = await resolveToken(ctx);
          const linearIssue = await linear.getIssue(
            ctx.http.fetch.bind(ctx.http),
            token,
            linearIssueId,
          );
          identifier = linearIssue?.identifier;
        } catch (err) {
          ctx.logger.error(
            `Webhook create for ${linearIssueId} missing data.identifier; Linear API getIssue failed — aborting webhook (Linear will retry) rather than fall through to mint path which would re-trigger the loop. err=${(err as Error).message}`,
            { linearIssueId, error: (err as Error).message },
          );
          inFlightCreates.delete(linearIssueId);
          throw err;
        }
        if (!identifier) {
          ctx.logger.error(
            `Webhook create for ${linearIssueId} missing data.identifier and Linear API getIssue returned no identifier — aborting webhook (Linear will retry).`,
            { linearIssueId },
          );
          inFlightCreates.delete(linearIssueId);
          throw new Error(
            `Cannot resolve identifier for Linear issue ${linearIssueId}; refusing to proceed to mint path`,
          );
        }
      }
      const state = data.state as Record<string, unknown> | undefined;
      const stateType = (state?.type as string) ?? "backlog";

      const statusMap: Record<string, string> = {
        backlog: "backlog", unstarted: "todo", started: "in_progress",
        completed: "done", canceled: "cancelled", cancelled: "cancelled",
      };
      const priorityMap: Record<number, string> = {
        0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
      };

      const status = statusMap[stateType] ?? "backlog";
      const priority = priorityMap[(data.priority as number) ?? 0] ?? "medium";

      try {
        // Dedup against prior imports of the same Linear issue.
        const existingByOrigin = await ctx.issues.list({
          companyId,
          originKind: ORIGIN_KIND_SELF,
          originId: linearIssueId,
          limit: 1,
        });
        if (existingByOrigin.length > 0) {
          // Webhook re-delivery → backfill assigneeUserId if the existing
          // row is unassigned and the webhook payload's assignee resolves
          // to a Paperclip user. Cheap idempotent update.
          const existing = existingByOrigin[0]!;
          const webhookAssignee = (data.assignee as { email?: string | null } | null | undefined) ?? null;
          const existingAssigneeUserId = (existing as unknown as { assigneeUserId?: string | null }).assigneeUserId;
          if (!existingAssigneeUserId && webhookAssignee?.email) {
            const userId = await resolvePaperclipUserIdForEmail(ctx, webhookAssignee.email);
            if (userId) {
              await ctx.issues.update(existing.id, { assigneeUserId: userId }, companyId);
            }
          }
          ctx.logger.info(`Skipped duplicate webhook create for Linear ${identifier ?? linearIssueId} (already imported)`);
          inFlightCreates.delete(linearIssueId);
          return;
        }

        const assigneeRecord = (data.assignee as { email?: string | null } | null | undefined) ?? null;
        const assigneeUserId = await resolvePaperclipUserIdForEmail(ctx, assigneeRecord?.email);

        // Linear webhook payloads include `url` for Issue events. Prefer that
        // (workspace-prefixed) over the slug-less form we used to construct
        // ourselves — the slug-less form leaves the link record without
        // enough context for downstream linkifiers to build correct urls.
        const dataUrl = (data.url as string | null | undefined) ?? null;
        const workspaceSlug = await resolveLinearWorkspaceSlug(ctx, dataUrl);
        const rawDescription = (data.description as string | null | undefined) ?? null;
        // Same bug class as comment ingest: bare BLO-N in a Linear-side
        // description would otherwise mis-route via paperclip's UI linkifier
        // to paperclip's own /issues/<id>.
        const description = rawDescription
          ? linkifyBareLinearIssueRefs(rawDescription, workspaceSlug)
          : undefined;

        // BLO-2350: webhook payloads carry `data.projectId` (and sometimes a
        // nested `project.id` / `project.name`). Map to a Paperclip project
        // so the imported row is not orphaned. Falls back to the configured
        // defaultProjectId.
        const webhookProject = data.project as
          | { id?: string | null; name?: string | null }
          | null
          | undefined;
        const linearProjectId =
          webhookProject?.id ?? (data.projectId as string | null | undefined) ?? null;
        const projectId = await resolveProjectIdForLinearIssue(
          ctx,
          { id: linearProjectId, name: webhookProject?.name ?? null },
          identifier,
        );

        const created = await ctx.issues.create({
          companyId,
          title: (data.title as string) ?? "Untitled",
          description,
          priority: priority as "critical" | "high" | "medium" | "low",
          originKind: ORIGIN_KIND_SELF,
          originId: linearIssueId,
          ...(projectId ? { projectId } : {}),
          ...(assigneeUserId ? { assigneeUserId } : {}),
          // Webhook payloads sometimes omit `data.identifier`. When present,
          // bind to the existing Linear issue so the host doesn't re-mint
          // (linear-provider) and writes a correct linear_issue_links row.
          // When absent we fall back to the legacy buggy behavior — better
          // than failing the webhook outright; PR2 can fetch from Linear.
          ...(identifier ? { linkedLinearIssue: { id: linearIssueId, identifier } } : {}),
        });

        await applyImportedLinearStatus(ctx, created.id, companyId, status, assigneeUserId, identifier ?? linearIssueId);

        const url = dataUrl ?? (identifier ? `https://linear.app/issue/${identifier}` : "");

        // Mark as created-from-Linear BEFORE createLink so the issue.created
        // event handler (which fires from ctx.issues.create above) can skip it.
        recentlyCreatedFromLinear.add(created.id);
        setTimeout(() => recentlyCreatedFromLinear.delete(created.id), 10_000);

        await sync.createLink(ctx, {
          paperclipIssueId: created.id,
          paperclipCompanyId: companyId,
          linearIssueId,
          linearIdentifier: identifier ?? linearIssueId,
          linearUrl: url,
          linearStateType: stateType,
          syncDirection: "bidirectional",
        });

        await ctx.activity.log({
          companyId,
          message: `issue.synced_from_linear`,
          entityType: "issue",
          entityId: created.id,
          metadata: { source: "linear", identifier, title: (data.title as string) ?? "", action: "created" },
        });

        ctx.logger.info(`Webhook created issue from Linear: ${identifier}`);

        // Back-link write — shared helper with the polling-import path. The
        // helper itself respects linearBacklinkBestEffort for strict-rollout
        // semantics. Wrapped in a local try/catch here because the webhook
        // must return 200 to Linear fast: even a strict-mode back-link
        // failure shouldn't make Linear retry the whole Issue.create webhook
        // (the Paperclip mirror was created successfully — that work is
        // committed). Surfacing the failure via warn is enough.
        try {
          const linearToken = await resolveToken(ctx);
          await writePaperclipBackLink(
            ctx,
            linearToken,
            linearIssueId,
            identifier ?? null,
            created.identifier ?? null,
            created.id,
            (data.title as string | null | undefined) ?? null,
            companyId,
          );
        } catch (err) {
          ctx.logger.warn(
            `Webhook back-link write failed for ${identifier ?? linearIssueId}: ${err}`,
          );
        }
      } catch (err) {
        ctx.logger.warn(`Webhook failed to create issue: ${err}`);
      } finally {
        inFlightCreates.delete(linearIssueId);
      }

    } else if (action === "remove") {
      // Issue deleted in Linear → cancel in Paperclip
      const link = await sync.getLinkByLinear(ctx, linearIssueId);
      if (!link) return;

      await ctx.issues.update(link.paperclipIssueId, {
        status: "cancelled" as any,
      }, link.paperclipCompanyId);

      ctx.logger.info(`Webhook archived issue (deleted in Linear): ${link.linearIdentifier}`);
    }
  }

  // --- Comment events ---
  if (type === "Comment" && (action === "create" || action === "update")) {
    const issueData = data.issue as Record<string, unknown> | undefined;
    const issueLinearId = issueData?.id as string | undefined;
    if (!issueLinearId) return;

    const link = await sync.getLinkByLinear(ctx, issueLinearId);
    if (!link) return;

    const commentBody = data.body as string;
    if (!commentBody || commentBody.includes("[synced from Paperclip]")) return;

    // BLO-2973: idempotency-check by Linear comment UUID before creating.
    // Linear retries webhook deliveries on transient failures (and our own
    // retry layer can fire the handler twice for the same payload). Without
    // this check, every retry creates a duplicate paperclip comment.
    //
    // We embed a sentinel HTML comment in the bridged body — invisible in
    // rendered markdown, but a stable, content-addressable marker we can
    // grep when listing existing comments. Falls back to skipping the
    // create if listing fails (better an occasional missed sync than a
    // duplicate sync).
    const linearCommentId = data.id as string | undefined;
    if (!linearCommentId) {
      ctx.logger.warn("Comment webhook missing data.id; skipping idempotency check (may double-post)");
    } else {
      try {
        const existing = await ctx.issues.listComments(link.paperclipIssueId, link.paperclipCompanyId);
        const sentinel = `<!-- linear-comment-id: ${linearCommentId} -->`;
        if (existing.some((c) => typeof c.body === "string" && c.body.includes(sentinel))) {
          ctx.logger.info(`Webhook comment ${linearCommentId} already mirrored to ${link.linearIdentifier}; skipping`);
          return;
        }
      } catch (err) {
        ctx.logger.warn(`Idempotency check failed for comment ${linearCommentId}: ${err}; proceeding (may double-post)`);
      }
    }

    const userName = (data.user as Record<string, unknown>)?.name as string ?? "Linear user";

    // Bare `BLO-1234`-style refs in Linear text would otherwise be linkified
    // by the UI to Paperclip's own `/issues/BLO-1234` — same identifier
    // scheme, different issues. Wrap them as proper Linear links here so the
    // UI rewrite skips them.
    const workspaceSlug = await resolveLinearWorkspaceSlug(ctx, link.linearUrl);
    const safeBody = linkifyBareLinearIssueRefs(commentBody, workspaceSlug);

    // Prepend the sentinel so future webhook deliveries can detect this
    // comment was already mirrored. The HTML comment renders invisibly.
    const sentinelPrefix = linearCommentId
      ? `<!-- linear-comment-id: ${linearCommentId} -->\n`
      : "";

    try {
      await ctx.issues.createComment(
        link.paperclipIssueId,
        `${sentinelPrefix}**${userName}** (from Linear):\n\n${safeBody}`,
        link.paperclipCompanyId,
      );

      await ctx.activity.log({
        companyId: link.paperclipCompanyId,
        message: `issue.comment.synced_from_linear`,
        entityType: "issue",
        entityId: link.paperclipIssueId,
        metadata: { source: "linear", identifier: link.linearIdentifier, author: userName, bodySnippet: commentBody.slice(0, 120), action: "comment.synced", linearCommentId: linearCommentId ?? null },
      });

      ctx.logger.info(`Webhook bridged comment to ${link.linearIdentifier}`);
    } catch (err) {
      ctx.logger.warn(`Webhook failed to bridge comment: ${err}`);
    }
  }

  // --- Project events ---
  if (type === "Project") {
    const linearProjectId = data.id as string;

    if (action === "create") {
      const companyId = await getCompanyId(ctx);
      if (!companyId) return;
      const existing = await sync.getProjectLinkByLinear(ctx, linearProjectId);
      if (existing) return;

      const name = (data.name as string) ?? "Untitled";
      const state = (data.state as string)?.toLowerCase() ?? "planned";
      const status = sync.linearProjectStateToPaperclip(state);

      try {
        const created = await (ctx.projects as any).create({
          companyId,
          name,
          description: (data.description as string) ?? undefined,
          status,
        });

        const link = await sync.createProjectLink(ctx, {
          paperclipProjectId: created.id,
          paperclipCompanyId: companyId,
          linearProjectId,
          linearProjectName: name,
          linearState: state,
          syncDirection: "bidirectional",
        });
        const token = await resolveToken(ctx);
        await writePaperclipProjectBackLink(ctx, token, link, created);

        await ctx.activity.log({
          companyId,
          message: `project.synced_from_linear`,
          entityType: "project",
          entityId: created.id,
          metadata: { source: "linear", projectName: name, action: "created" },
        });

        ctx.logger.info(`Webhook created project from Linear: ${name}`);
      } catch (err) {
        ctx.logger.warn(`Webhook failed to create project: ${err}`);
      }

    } else if (action === "update") {
      const link = await sync.getProjectLinkByLinear(ctx, linearProjectId);
      if (!link) return;

      await sync.syncProjectFromLinear(ctx, link, {
        id: linearProjectId,
        name: (data.name as string) ?? "",
        description: (data.description as string | null) ?? null,
        state: (data.state as string) ?? link.lastLinearState,
      });

    } else if (action === "remove") {
      const link = await sync.getProjectLinkByLinear(ctx, linearProjectId);
      if (!link) return;

      await (ctx.projects as any).update(link.paperclipProjectId, { status: "cancelled" } as any, link.paperclipCompanyId);
      ctx.logger.info(`Webhook archived project (deleted in Linear): ${link.linearProjectName}`);
    }
  }

  // --- Initiative events (Linear → Paperclip goal) ---
  if (type === "Initiative") {
    const linearInitiativeId = data.id as string;
    if (!linearInitiativeId) return;

    if (action === "create") {
      const companyId = await getCompanyId(ctx);
      if (!companyId) return;

      const existing = await sync.getGoalLinkByLinear(ctx, linearInitiativeId);
      if (existing) return;

      if (inFlightInitiativeCreates.has(linearInitiativeId)) {
        ctx.logger.info(`Skipping duplicate webhook initiative create for ${linearInitiativeId} — already in flight`);
        return;
      }
      inFlightInitiativeCreates.add(linearInitiativeId);

      const name = (data.name as string) ?? "Untitled initiative";
      const description = (data.description as string | null) ?? undefined;
      const targetDate = (data.targetDate as string | null) ?? null;
      const status = sync.linearInitiativeStatusToPaperclip(data.status as string | null | undefined);

      try {
        const created = await ctx.goals.create({
          companyId,
          title: name,
          description,
          status,
        });

        recentlyCreatedGoalFromLinear.add(created.id);
        setTimeout(() => recentlyCreatedGoalFromLinear.delete(created.id), 10_000);

        await sync.createGoalLink(ctx, {
          paperclipGoalId: created.id,
          paperclipCompanyId: companyId,
          linearIssueId: linearInitiativeId,
          linearIdentifier: linearInitiativeId,
          linearUrl: `https://linear.app/initiatives/${linearInitiativeId}`,
          linearProjectId: null,
          lastSyncAt: new Date().toISOString(),
          lastTitle: name,
          lastStatus: status,
          lastTargetDate: targetDate,
          lastLevel: (created as { level?: string }).level ?? "outcome",
        });

        await ctx.activity.log({
          companyId,
          message: "goal.synced_from_linear",
          entityType: "goal",
          entityId: created.id,
          metadata: { source: "linear", initiativeId: linearInitiativeId, name, action: "created" },
        });

        ctx.logger.info(`Webhook created goal from Linear initiative: ${name}`);
      } catch (err) {
        ctx.logger.warn(`Webhook failed to create goal from initiative ${linearInitiativeId}: ${err}`);
      } finally {
        inFlightInitiativeCreates.delete(linearInitiativeId);
      }

    } else if (action === "update") {
      const link = await sync.getGoalLinkByLinear(ctx, linearInitiativeId);
      if (!link) return;

      // SDK `goals.update` only accepts a known field whitelist
      // (title/description/level/status/parentId/ownerAgentId). Linear's
      // `targetDate` is intentionally not synced here — the Paperclip Goal
      // type doesn't carry targetDate as a directly-mutable field.
      const patch: { title?: string; description?: string; status?: sync.PaperclipGoalStatus } = {};

      const newName = data.name as string | undefined;
      if (newName && newName !== link.lastTitle) {
        patch.title = newName;
        link.lastTitle = newName;
      }
      if (data.description !== undefined) {
        patch.description = (data.description as string | null) ?? undefined;
      }
      if (data.status !== undefined) {
        const newStatus = sync.linearInitiativeStatusToPaperclip(data.status as string | null | undefined);
        if (newStatus !== link.lastStatus) {
          patch.status = newStatus;
          link.lastStatus = newStatus;
        }
      }

      if (Object.keys(patch).length === 0) return;

      try {
        await ctx.goals.update(link.paperclipGoalId, patch, link.paperclipCompanyId);
        await sync.updateGoalLink(ctx, link);
        ctx.logger.info(`Webhook updated goal from Linear initiative: ${link.paperclipGoalId}`);
      } catch (err) {
        ctx.logger.warn(`Webhook failed to update goal ${link.paperclipGoalId}: ${err}`);
      }

    } else if (action === "remove") {
      const link = await sync.getGoalLinkByLinear(ctx, linearInitiativeId);
      if (!link) return;

      try {
        await ctx.goals.update(link.paperclipGoalId, { status: "cancelled" }, link.paperclipCompanyId);
        link.lastStatus = "cancelled";
        await sync.updateGoalLink(ctx, link);
        ctx.logger.info(`Webhook cancelled goal (initiative removed in Linear): ${link.paperclipGoalId}`);
      } catch (err) {
        ctx.logger.warn(`Webhook failed to cancel goal ${link.paperclipGoalId}: ${err}`);
      }
    }
  }

  // --- InitiativeUpdate events (status/note posts on a Linear initiative) ---
  // Linear's "Initiative updates" feature: periodic written status posts.
  // No native equivalent on Paperclip goals, so record the post into the
  // activity feed of the linked goal so it shows up in audit history without
  // mutating the goal description (which would accumulate noise).
  if (type === "InitiativeUpdate" && action === "create") {
    const initiativeRef = data.initiative as Record<string, unknown> | undefined;
    const linearInitiativeId = initiativeRef?.id as string | undefined;
    if (!linearInitiativeId) return;

    const link = await sync.getGoalLinkByLinear(ctx, linearInitiativeId);
    if (!link) return;

    const body = (data.body as string) ?? "";
    const author = ((data.user as Record<string, unknown> | undefined)?.name as string) ?? "Linear user";
    await ctx.activity.log({
      companyId: link.paperclipCompanyId,
      message: "goal.initiative_update_from_linear",
      entityType: "goal",
      entityId: link.paperclipGoalId,
      metadata: {
        source: "linear",
        initiativeId: linearInitiativeId,
        author,
        bodySnippet: body.slice(0, 280),
      },
    });
    ctx.logger.info(`Webhook recorded initiative update on goal ${link.paperclipGoalId} (from ${author})`);
  }

  // --- ProjectUpdate events (status posts on a Linear project) ---
  // Mirrors InitiativeUpdate. Paperclip projects also lack a comment thread,
  // so record into activity feed.
  if (type === "ProjectUpdate" && action === "create") {
    const projectRef = data.project as Record<string, unknown> | undefined;
    const linearProjectId = projectRef?.id as string | undefined;
    if (!linearProjectId) return;

    const link = await sync.getProjectLinkByLinear(ctx, linearProjectId);
    if (!link) return;

    const body = (data.body as string) ?? "";
    const author = ((data.user as Record<string, unknown> | undefined)?.name as string) ?? "Linear user";
    await ctx.activity.log({
      companyId: link.paperclipCompanyId,
      message: "project.update_from_linear",
      entityType: "project",
      entityId: link.paperclipProjectId,
      metadata: {
        source: "linear",
        linearProjectId,
        author,
        bodySnippet: body.slice(0, 280),
      },
    });
    ctx.logger.info(`Webhook recorded project update on project ${link.paperclipProjectId} (from ${author})`);
  }

  // --- Attachment events (files attached to issues in Linear) ---
  // Bridge as a comment on the linked Paperclip issue so the file is
  // visible+navigable. Skips updates and removes — Linear doesn't typically
  // mutate attachments after creation, and we'd rather over-comment than
  // silently lose evidence of file activity.
  if (type === "Attachment" && action === "create") {
    const issueRef = data.issue as Record<string, unknown> | undefined;
    const linearIssueId = (issueRef?.id as string | undefined) ?? (data.issueId as string | undefined);
    if (!linearIssueId) return;

    const link = await sync.getLinkByLinear(ctx, linearIssueId);
    if (!link) return;

    const title = (data.title as string) ?? "Attachment";
    const url = (data.url as string) ?? "";
    const author = ((data.creator as Record<string, unknown> | undefined)?.name as string) ?? "Linear";

    if (!url) {
      ctx.logger.info(`Skipping attachment ${title} — no URL in webhook payload`);
      return;
    }

    try {
      await ctx.issues.createComment(
        link.paperclipIssueId,
        `**${author}** attached in Linear: [${title}](${url})\n\n[synced from Paperclip]`,
        link.paperclipCompanyId,
      );
      await ctx.activity.log({
        companyId: link.paperclipCompanyId,
        message: "issue.attachment_synced_from_linear",
        entityType: "issue",
        entityId: link.paperclipIssueId,
        metadata: { source: "linear", title, url, author },
      });
      ctx.logger.info(`Webhook bridged Linear attachment to ${link.linearIdentifier}: ${title}`);
    } catch (err) {
      ctx.logger.warn(`Webhook failed to bridge attachment for ${link.linearIdentifier}: ${err}`);
    }
  }

  // --- Workspace-level label CRUD (no per-issue effect) ---
  // IssueLabel/ProjectLabel webhooks fire when labels themselves are
  // created/renamed/deleted at the workspace level — distinct from per-issue
  // label assignments which already flow via Issue.update. Paperclip doesn't
  // currently mirror Linear's workspace label catalog, so we acknowledge
  // these events into the activity log instead of silently dropping them,
  // and leave full label-catalog sync as future work.
  if (type === "IssueLabel" || type === "ProjectLabel") {
    const labelName = (data.name as string) ?? "(unnamed)";
    ctx.logger.info(`Webhook acknowledged ${type}.${action}: ${labelName} — workspace label catalog sync not implemented`);
    return;
  }

  // --- Document events (Linear's project documents feature) ---
  // No clean mapping: Linear documents are project-scoped wiki pages with no
  // direct Paperclip equivalent (issue documents are issue-scoped). Log so
  // operators can see the events arrive; downstream sync can be added later
  // if there's a concrete user need.
  if (type === "Document") {
    const title = (data.title as string) ?? "(untitled)";
    ctx.logger.info(`Webhook acknowledged Document.${action}: ${title} — Linear documents not synced to Paperclip`);
    return;
  }
}

// ---------------------------------------------------------------------------
// Import logic
// ---------------------------------------------------------------------------

async function runImport(ctx: PluginContext): Promise<{
  imported: number;
  skipped: number;
  labels: number;
  projects: number;
}> {
  // Check if already ran
  const importDone = await ctx.state.get({
    scopeKind: "instance",
    stateKey: "initial-import-done",
  });
  if (importDone) {
    ctx.logger.info("Initial import already completed, skipping");
    return { imported: 0, skipped: 0, labels: 0, projects: 0 };
  }

  const token = await resolveToken(ctx);
  const teamId = await getTeamId(ctx);
  const companyId = await getCompanyId(ctx);
  if (!companyId) {
    throw new Error("No company ID stored. Connect via OAuth settings first.");
  }

  const fetch = ctx.http.fetch.bind(ctx.http);

  // ---- Phase 1: Sync projects from Linear ----
  ctx.logger.info("Import phase: syncing projects");
  const linearProjects = await linear.listProjects(fetch, token, teamId);
  const existingProjects = await ctx.projects.list({ companyId });
  const projectMap = new Map<string, string>(); // project name → Paperclip project ID
  for (const ep of existingProjects) {
    projectMap.set(ep.name, ep.id);
  }

  const linearStatusMap: Record<string, string> = {
    planned: "planned", backlog: "backlog",
    started: "in_progress", "in progress": "in_progress",
    completed: "completed", done: "completed",
    canceled: "cancelled", cancelled: "cancelled",
    paused: "backlog",
  };

  for (const lp of linearProjects) {
    if (!projectMap.has(lp.name)) {
      try {
        const status = linearStatusMap[lp.state?.toLowerCase() ?? ""] ?? "backlog";
        const created = await (ctx.projects as any).create({
          companyId,
          name: lp.name,
          description: lp.description ?? undefined,
          status,
          targetDate: lp.targetDate ?? undefined,
        });
        projectMap.set(lp.name, created.id);
        ctx.logger.info(`Created project: ${lp.name}`);
      } catch (err) {
        ctx.logger.warn(`Failed to create project ${lp.name}: ${err}`);
      }
    }

    // Create project link for ongoing sync (whether just created or already existed)
    const paperclipProjectId = projectMap.get(lp.name);
    if (paperclipProjectId) {
      const existingLink = await sync.getProjectLink(ctx, paperclipProjectId);
      if (!existingLink) {
        try {
          const link = await sync.createProjectLink(ctx, {
            paperclipProjectId,
            paperclipCompanyId: companyId,
            linearProjectId: lp.id,
            linearProjectName: lp.name,
            linearState: lp.state?.toLowerCase() ?? "planned",
            syncDirection: "bidirectional",
          });
          await writePaperclipProjectBackLink(
            ctx,
            token,
            link,
            await getProjectById(ctx, paperclipProjectId, companyId),
          );
        } catch (err) {
          ctx.logger.warn(`Failed to create project link/back-link for ${lp.name}: ${err}`);
        }
      }
    }
  }

  // Also push Paperclip-only projects to Linear
  for (const ep of existingProjects) {
    if (!linearProjects.some((lp) => lp.name === ep.name)) {
      try {
        const linearState = sync.paperclipProjectStateToLinear(ep.status ?? "backlog");
        const paperclipLinkOptions = await paperclipLinkOptionsForCompany(ctx, companyId);
        const created = await linear.createProject(fetch, token, {
          name: ep.name,
          description: ep.description
            ? absolutizePaperclipMarkdownLinks(
                ep.description,
                paperclipLinkOptions.baseUrl,
                paperclipLinkOptions.companyPrefix,
              )
            : undefined,
          teamIds: [teamId],
          state: linearState,
        });

        const link = await sync.createProjectLink(ctx, {
          paperclipProjectId: ep.id,
          paperclipCompanyId: companyId,
          linearProjectId: created.id,
          linearProjectName: created.name,
          linearState,
          syncDirection: "bidirectional",
        });
        await writePaperclipProjectBackLink(ctx, token, link, ep);
        ctx.logger.info(`Pushed Paperclip project to Linear: ${ep.name}`);
      } catch (err) {
        ctx.logger.warn(`Failed to push project ${ep.name} to Linear: ${err}`);
      }
    }
  }

  // ---- Phase 2: Sync labels via SDK ----
  ctx.logger.info("Import phase: syncing labels");
  const existingLabels = await (ctx as any).labels.list(companyId);
  const labelMap = new Map<string, string>(); // label name → Paperclip label ID
  for (const el of existingLabels) {
    labelMap.set(el.name, el.id);
  }

  // Default colors for labels without colors
  const defaultColors = ["#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316", "#eab308", "#22c55e", "#06b6d4"];
  let colorIdx = 0;

  // ---- Phase 3: Import issues ----
  ctx.logger.info("Import phase: importing issues");
  let existingIssueTitleIndex = new Map<string, Issue[]>();
  try {
    existingIssueTitleIndex = await listExistingIssuesByExactTitle(ctx, companyId);
  } catch (err) {
    ctx.logger.warn(`Linear import could not prefetch Paperclip issues for title-based relinking: ${err}`);
  }
  const claimedIssueIds = new Set<string>();
  let imported = 0;
  let skipped = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await linear.listOpenIssues(fetch, token, teamId, cursor);

    for (const linearIssue of page.issues) {
      // Skip if already linked
      const existing = await sync.getLinkByLinear(ctx, linearIssue.id);
      if (existing) {
        skipped++;
        continue;
      }

      const priorityMap: Record<number, string> = {
        0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
      };
      const priority = priorityMap[linearIssue.priority] ?? "medium";

      const statusMap: Record<string, string> = {
        backlog: "backlog", unstarted: "todo", started: "in_progress",
        completed: "done", canceled: "cancelled", cancelled: "cancelled",
      };
      const status = statusMap[linearIssue.state.type] ?? "backlog";

      // Ensure labels exist in Paperclip
      const issueLabelIds: string[] = [];
      for (const ll of linearIssue.labels.nodes) {
        if (!labelMap.has(ll.name)) {
          const color = ll.color || defaultColors[colorIdx % defaultColors.length];
          colorIdx++;
          const created = await (ctx as any).labels.create(companyId, ll.name, color);
          if (created) {
            labelMap.set(ll.name, created.id);
            ctx.logger.info(`Created label: ${ll.name}`);
          }
        }
        const labelId = labelMap.get(ll.name);
        if (labelId) issueLabelIds.push(labelId);
      }

      // Resolve project: prefer the Linear-project-link record (created
      // during phase 1 above), then in-flight name match (covers projects
      // created mid-import), then the configured defaultProjectId fallback.
      const projectId = await resolveProjectIdForLinearIssue(
        ctx,
        linearIssue.project,
        linearIssue.identifier,
        (name) => projectMap.get(name),
      );

      const workspaceSlug = await resolveLinearWorkspaceSlug(ctx, linearIssue.url);
      const description = linearIssue.description
        ? linkifyBareLinearIssueRefs(linearIssue.description, workspaceSlug)
        : undefined;
      const assigneeUserId = await resolvePaperclipUserIdForEmail(ctx, linearIssue.assignee?.email);

      try {
        // Host-side link dedup mirrors the webhook create path: if the host
        // already has a linear_issue_links row but plugin state is missing,
        // rebuild the plugin link and update the existing Paperclip row
        // instead of minting another issue.
        const hostLinkedIssue = await ctx.issues.getByLinearIssueId({
          linearIssueId: linearIssue.id,
          companyId,
        });
        if (hostLinkedIssue) {
          await updateExistingPaperclipIssueFromLinear(ctx, hostLinkedIssue, companyId, {
            linearIssue,
            description,
            priority: priority as Issue["priority"],
            status: status as Issue["status"],
            projectId,
            labelIds: issueLabelIds,
            assigneeUserId,
          });
          await createPluginLinkForExistingPaperclipIssue(ctx, hostLinkedIssue, companyId, linearIssue);
          claimedIssueIds.add(hostLinkedIssue.id);
          skipped++;
          ctx.logger.info(`Relinked ${linearIssue.identifier} to existing host-linked Paperclip issue ${hostLinkedIssue.identifier ?? hostLinkedIssue.id}`);
          continue;
        }

        // Idempotency: the bulk-import path can rerun against the same Linear
        // workspace. Skip Paperclip rows that already point at this Linear id.
        const existingByOrigin = await ctx.issues.list({
          companyId,
          originKind: ORIGIN_KIND_SELF,
          originId: linearIssue.id,
          limit: 1,
        });
        if (existingByOrigin.length > 0) {
          const existing = existingByOrigin[0]!;
          await updateExistingPaperclipIssueFromLinear(ctx, existing, companyId, {
            linearIssue,
            description,
            priority: priority as Issue["priority"],
            status: status as Issue["status"],
            projectId,
            labelIds: issueLabelIds,
            assigneeUserId,
          });
          await createPluginLinkForExistingPaperclipIssue(ctx, existing, companyId, linearIssue);
          claimedIssueIds.add(existing.id);
          skipped++;
          continue;
        }

        const exactTitleIssue = await findUnlinkedExactTitleIssue(
          ctx,
          existingIssueTitleIndex.get(linearIssue.title.trim()),
          claimedIssueIds,
          projectId,
        );
        if (exactTitleIssue) {
          await updateExistingPaperclipIssueFromLinear(ctx, exactTitleIssue, companyId, {
            linearIssue,
            description,
            priority: priority as Issue["priority"],
            status: status as Issue["status"],
            projectId,
            labelIds: issueLabelIds,
            assigneeUserId,
          });
          await createPluginLinkForExistingPaperclipIssue(ctx, exactTitleIssue, companyId, linearIssue);
          claimedIssueIds.add(exactTitleIssue.id);
          skipped++;
          ctx.logger.info(`Relinked ${linearIssue.identifier} to exact-title Paperclip issue ${exactTitleIssue.identifier ?? exactTitleIssue.id}`);
          continue;
        }

        const created = await ctx.issues.create({
          companyId,
          title: linearIssue.title,
          description,
          priority: priority as "critical" | "high" | "medium" | "low",
          originKind: ORIGIN_KIND_SELF,
          originId: linearIssue.id,
          ...(projectId ? { projectId } : {}),
          ...(issueLabelIds.length > 0 ? { labelIds: issueLabelIds } : {}),
          ...(assigneeUserId ? { assigneeUserId } : {}),
          linkedLinearIssue: {
            id: linearIssue.id,
            identifier: linearIssue.identifier,
          },
        });

        await applyImportedLinearStatus(ctx, created.id, companyId, status, assigneeUserId, linearIssue.identifier);

        await sync.createLink(ctx, {
          paperclipIssueId: created.id,
          paperclipCompanyId: companyId,
          linearIssueId: linearIssue.id,
          linearIdentifier: linearIssue.identifier,
          linearUrl: linearIssue.url,
          linearStateType: linearIssue.state.type,
          syncDirection: "bidirectional",
        });

        imported++;
        ctx.logger.info(`Imported ${linearIssue.identifier}: ${linearIssue.title}`);
      } catch (err) {
        ctx.logger.warn(`Failed to import ${linearIssue.identifier}: ${err}`);
      }
    }

    hasMore = page.hasNextPage;
    cursor = page.endCursor ?? undefined;
  }

  // Mark import as done
  await ctx.state.set(
    { scopeKind: "instance", stateKey: "initial-import-done" },
    new Date().toISOString(),
  );

  const companyIdForLog = companyId;
  await ctx.activity.log({
    companyId: companyIdForLog,
    message: `Linear import complete: ${imported} issues, ${labelMap.size} labels, ${projectMap.size} projects`,
    entityType: "company",
    entityId: companyIdForLog,
    metadata: { imported, skipped, labels: labelMap.size, projects: projectMap.size },
  });

  ctx.logger.info(`Import complete: ${imported} issues, ${labelMap.size} labels, ${projectMap.size} projects`);
  return { imported, skipped, labels: labelMap.size, projects: projectMap.size };
}

// ---------------------------------------------------------------------------
// Full sync (re-sync all linked issues from Linear)
// ---------------------------------------------------------------------------

const LINEAR_LINK_SYNC_PAGE_SIZE = 100;
const LINEAR_ISSUE_SYNC_BATCH_SIZE = 50;
const LINEAR_LINK_SYNC_MAX_ENTRIES_PER_RUN = 100;

function isIssueLink(value: unknown): value is sync.IssueLink {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<sync.IssueLink>;
  return typeof candidate.paperclipIssueId === "string"
    && typeof candidate.paperclipCompanyId === "string"
    && typeof candidate.linearIssueId === "string"
    && typeof candidate.linearIdentifier === "string"
    && typeof candidate.linearUrl === "string"
    && typeof candidate.syncDirection === "string";
}

function isProjectLink(value: unknown): value is sync.ProjectLink {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<sync.ProjectLink>;
  return typeof candidate.paperclipProjectId === "string"
    && typeof candidate.paperclipCompanyId === "string"
    && typeof candidate.linearProjectId === "string"
    && typeof candidate.linearProjectName === "string"
    && typeof candidate.syncDirection === "string";
}

async function runFullSync(ctx: PluginContext): Promise<{
  synced: number;
  errors: number;
  scanned: number;
  complete: boolean;
  nextOffset: number;
}> {
  let token: string;
  try {
    token = await resolveToken(ctx);
  } catch {
    return { synced: 0, errors: 0, scanned: 0, complete: true, nextOffset: 0 };
  }

  const fetch = ctx.http.fetch.bind(ctx.http);
  const teamId = await getTeamId(ctx).catch(() => "");
  let synced = 0;
  let errors = 0;
  let scanned = 0;
  let entriesScanned = 0;
  const cursorKey = { scopeKind: "instance" as const, stateKey: STATE_KEYS.periodicLinkSyncOffset };
  const storedOffset = Number(await ctx.state.get(cursorKey));
  let offset = Number.isFinite(storedOffset) && storedOffset > 0 ? Math.trunc(storedOffset) : 0;
  let complete = false;

  while (entriesScanned < LINEAR_LINK_SYNC_MAX_ENTRIES_PER_RUN) {
    const remaining = LINEAR_LINK_SYNC_MAX_ENTRIES_PER_RUN - entriesScanned;
    const page = await ctx.state.list({
      scopeKind: "instance",
      namespace: "default",
      stateKeyPrefix: STATE_KEYS.linkPrefix,
      limit: Math.min(LINEAR_LINK_SYNC_PAGE_SIZE, remaining),
      offset,
    });
    if (page.entries.length === 0) {
      offset = 0;
      complete = true;
      break;
    }

    const links = page.entries
      .map((entry) => entry.value)
      .filter(isIssueLink);
    scanned += links.length;
    entriesScanned += page.entries.length;

    let removedLinksFromPage = 0;

    for (let index = 0; index < links.length; index += LINEAR_ISSUE_SYNC_BATCH_SIZE) {
      const batch = links.slice(index, index + LINEAR_ISSUE_SYNC_BATCH_SIZE);
      const linearIds = batch.map((link) => link.linearIssueId);
      let linearIssues: linear.LinearIssue[];

      try {
        linearIssues = await linear.listIssuesByIds(fetch, token, linearIds);
      } catch (err) {
        ctx.logger.warn(`Linear issue batch fetch failed: ${err}`);
        errors += batch.length;
        continue;
      }

      const linearById = new Map(linearIssues.map((issue) => [issue.id, issue]));

      for (const link of batch) {
        const linearIssue = linearById.get(link.linearIssueId);
        if (!linearIssue) {
          const removed = await sync.removeLink(ctx, link.paperclipIssueId);
          if (removed) removedLinksFromPage++;
          ctx.logger.info(
            `Removed stale Linear link for ${link.linearIdentifier}: Linear issue ${link.linearIssueId} was not found`,
          );
          continue;
        }

        try {
          await sync.syncFromLinear(ctx, link, linearIssue);
          synced++;
        } catch (err) {
          if (sync.isPaperclipIssueNotFoundError(err)) {
            const removed = await sync.removeLink(ctx, link.paperclipIssueId);
            if (removed) removedLinksFromPage++;
            ctx.logger.info(
              `Removed stale Linear link for ${link.linearIdentifier}: Paperclip issue ${link.paperclipIssueId} was not found`,
            );
            continue;
          }
          ctx.logger.warn(`Sync failed for ${linearIssue.identifier}: ${err}`);
          errors++;
        }
      }
    }

    offset += Math.max(0, page.entries.length - removedLinksFromPage);
    if (!page.hasMore) {
      offset = 0;
      complete = true;
      break;
    }
  }

  await ctx.state.set(cursorKey, offset);

  if (!complete) {
    ctx.logger.info(
      `Full sync paused: ${synced} synced from ${scanned} linked issues, ${errors} errors, next offset ${offset}`,
    );
    return { synced, errors, scanned, complete, nextOffset: offset };
  }

  ctx.logger.info(`Full sync complete: ${synced} synced from ${scanned} linked issues, ${errors} errors`);

  // Re-push goals so status/targetDate edits land in Linear within one cron
  // tick even if the goal.updated event was missed.
  try {
    const companyId = await getCompanyId(ctx);
    if (companyId) {
      const g = await runGoalSync(ctx, companyId);
      ctx.logger.info(
        `Goal sync: ${g.processed} processed (${g.created} created, ${g.updated} updated, ${g.unchanged} unchanged${
          g.missing > 0 ? `, ${g.missing} missing` : ""
        }), ${g.errors} errors`,
      );
    }
  } catch (err) {
    ctx.logger.warn(`Goal sync pass failed: ${err}`);
  }

  // Catch up project state from Linear → Paperclip in case webhook updates
  // were missed (e.g. plugin worker was restarting). Runs in the same cron
  // tick so issues, goals, and projects all converge together.
  try {
    const companyId = await getCompanyId(ctx);
    if (companyId && teamId) {
      const projResult = await runProjectSync(ctx, companyId, teamId, token);
      const sdkSkipNotes: string[] = [];
      if (projResult.skippedDrift > 0) {
        sdkSkipNotes.push(`${projResult.skippedDrift} drift skipped (no projects.update)`);
      }
      if (projResult.skippedCreate > 0) {
        sdkSkipNotes.push(`${projResult.skippedCreate} create skipped (no projects.create)`);
      }
      const skipSuffix = sdkSkipNotes.length > 0 ? `, ${sdkSkipNotes.join(", ")}` : "";
      ctx.logger.info(
        `Project sync: ${projResult.synced} synced, ${projResult.created} created, ${projResult.errors} errors${skipSuffix}`,
      );
    }
  } catch (err) {
    ctx.logger.warn(`Project sync pass failed: ${err}`);
  }

  return { synced, errors, scanned, complete, nextOffset: offset };
}

/**
 * Periodic catch-up for projects: pulls all Linear projects for the team,
 * applies drift to linked Paperclip projects via syncProjectFromLinear, and
 * creates Paperclip mirrors for any unlinked Linear projects (Linear is
 * source of truth for project create/state).
 *
 * Webhooks handle the live path; this exists so a missed webhook (restart,
 * 502, signature mismatch) self-heals on the next 15-min tick instead of
 * leaving Paperclip and Linear permanently out of sync.
 */
async function runProjectSync(
  ctx: PluginContext,
  companyId: string,
  teamId: string,
  token: string,
): Promise<{ synced: number; created: number; errors: number; skippedDrift: number; skippedCreate: number }> {
  const fetch = ctx.http.fetch.bind(ctx.http);
  const linearProjects = await linear.listProjects(fetch, token, teamId);
  const existingProjectsByName = new Map<string, { id: string; name: string }>();
  try {
    const existingProjects = await ctx.projects.list({ companyId });
    for (const project of existingProjects) {
      if (!existingProjectsByName.has(project.name)) {
        existingProjectsByName.set(project.name, { id: project.id, name: project.name });
      }
    }
  } catch (err) {
    ctx.logger.warn(`Project sync could not prefetch Paperclip projects for name-based relinking: ${err}`);
  }

  // ctx.projects.create / .update were added after the published SDK that
  // most plugin installs pin to. Try the typed client first; if it's missing
  // fall back to the generic ctx.rpc.call escape hatch (newer SDKs only).
  // If neither is available, degrade gracefully — log skipped counts instead
  // of throwing per-project.
  const rpcCall = (ctx as any).rpc?.call as
    | (<T>(method: string, params?: unknown) => Promise<T>)
    | undefined;
  const projectsUpdate = typeof (ctx.projects as any)?.update === "function"
    ? (id: string, patch: Record<string, unknown>, companyId: string) =>
        (ctx.projects as any).update(id, patch, companyId)
    : rpcCall
      ? (id: string, patch: Record<string, unknown>, companyId: string) =>
          rpcCall("projects.update", { projectId: id, patch, companyId })
      : null;
  const projectsCreate = typeof (ctx.projects as any)?.create === "function"
    ? (input: { companyId: string; name: string; description?: string; status?: string }) =>
        (ctx.projects as any).create(input)
    : rpcCall
      ? (input: { companyId: string; name: string; description?: string; status?: string }) =>
          rpcCall<{ id: string }>("projects.create", input)
      : null;
  let supportsUpdate = projectsUpdate !== null;
  let supportsCreate = projectsCreate !== null;

  let synced = 0;
  let created = 0;
  let errors = 0;
  let skippedDrift = 0;
  let skippedCreate = 0;

  for (const lp of linearProjects) {
    // Don't mirror the goal-bridge project back — it's Paperclip-managed and
    // would round-trip on every sync tick.
    if (lp.name === GOALS_LINEAR_PROJECT_NAME) continue;

    try {
      const existing = await sync.getProjectLinkByLinear(ctx, lp.id);
      if (existing) {
        await writePaperclipProjectBackLink(ctx, token, existing);
        if (!supportsUpdate) {
          skippedDrift++;
          continue;
        }
        const result = await sync.syncProjectFromLinear(ctx, existing, {
          id: lp.id,
          name: lp.name,
          description: lp.description ?? null,
          state: lp.state,
        });
        if (result === "unavailable") {
          supportsUpdate = false;
          skippedDrift++;
          ctx.logger.warn("Project drift sync unavailable for this invocation; skipping remaining project updates");
          continue;
        }
        if (result === "failed") {
          errors++;
          continue;
        }
        synced++;
        continue;
      }

      const existingByName = existingProjectsByName.get(lp.name);
      if (existingByName) {
        const link = await sync.createProjectLink(ctx, {
          paperclipProjectId: existingByName.id,
          paperclipCompanyId: companyId,
          linearProjectId: lp.id,
          linearProjectName: lp.name,
          linearState: lp.state ?? "planned",
          syncDirection: "bidirectional",
        });
        await writePaperclipProjectBackLink(
          ctx,
          token,
          link,
          await getProjectById(ctx, existingByName.id, companyId),
        );

        if (!supportsUpdate) {
          skippedDrift++;
          continue;
        }

        const status = sync.linearProjectStateToPaperclip(lp.state?.toLowerCase() ?? "planned");
        await projectsUpdate!(existingByName.id, {
          name: lp.name,
          description: lp.description ?? undefined,
          status,
        }, companyId);
        synced++;
        continue;
      }

      if (!supportsCreate) {
        skippedCreate++;
        continue;
      }

      // New Linear project we haven't seen — create the Paperclip mirror
      // (matches the create-webhook behavior so the catch-up path is
      // symmetric with live events).
      const status = sync.linearProjectStateToPaperclip(lp.state?.toLowerCase() ?? "planned");
      let createdProj: { id: string };
      try {
        createdProj = await projectsCreate!({
          companyId,
          name: lp.name,
          description: lp.description ?? undefined,
          status,
        });
      } catch (err) {
        if (sync.isHostWriteUnavailableError(err)) {
          supportsCreate = false;
          skippedCreate++;
          ctx.logger.warn("Project create sync unavailable for this invocation; skipping remaining project creates");
          continue;
        }
        throw err;
      }
      const link = await sync.createProjectLink(ctx, {
        paperclipProjectId: createdProj.id,
        paperclipCompanyId: companyId,
        linearProjectId: lp.id,
        linearProjectName: lp.name,
        linearState: lp.state ?? "planned",
        syncDirection: "bidirectional",
      });
      await writePaperclipProjectBackLink(ctx, token, link, {
        id: createdProj.id,
        name: lp.name,
        description: lp.description ?? null,
      });
      created++;
    } catch (err) {
      ctx.logger.warn(`Project sync failed for ${lp.name}: ${err}`);
      errors++;
    }
  }

  return { synced, created, errors, skippedDrift, skippedCreate };
}

// ---------------------------------------------------------------------------
// Goal sync helpers
// ---------------------------------------------------------------------------

/** Resolve (or lazily create) the Linear project that holds synced goals. */
/** Goal description prefixed with a marker so syncs can identify Paperclip-owned initiatives. */
function goalDescription(goal: { description: string | null; level: string }): string {
  const header = `_Synced from Paperclip Goal — level: ${goal.level}_`;
  return goal.description ? `${header}\n\n${goal.description}` : header;
}

type GoalPushOutcome = "created" | "updated" | "unchanged" | "missing";

/**
 * Push a single Paperclip goal to Linear as an Initiative.
 * Falls back to a "Company Goals" project issue if the workspace plan
 * does not support initiatives (listInitiatives returns empty on 403/400).
 *
 * Idempotent — repeated calls converge on the current goal state.
 */
async function pushGoalToLinear(
  ctx: PluginContext,
  companyId: string,
  goalId: string,
): Promise<GoalPushOutcome> {
  const raw = await ctx.goals.get(goalId, companyId);
  if (!raw) {
    ctx.logger.warn(`pushGoalToLinear: goal ${goalId} not found in company ${companyId}`);
    return "missing";
  }
  const goal = raw as unknown as GoalWithTargetDate;

  const token = await resolveToken(ctx);
  const fetch = ctx.http.fetch.bind(ctx.http);
  const existing = await sync.getGoalLink(ctx, goalId);

  // Probe initiative support (cached after first call)
  const initiativesSupported = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.initiativesSupported,
  });
  const useInitiatives = initiativesSupported !== false;

  if (!existing) {
    if (useInitiatives) {
      try {
        const initiative = await linear.createInitiative(fetch, token, {
          name: goal.title,
          description: goalDescription(goal),
          targetDate: goal.targetDate ?? undefined,
        });
        // Cache that initiatives are supported
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_KEYS.initiativesSupported },
          true,
        );
        await sync.createGoalLink(ctx, {
          paperclipGoalId: goal.id,
          paperclipCompanyId: companyId,
          linearIssueId: initiative.id,
          linearIdentifier: initiative.id,
          linearUrl: `https://linear.app/initiatives/${initiative.id}`,
          linearProjectId: null,
          lastSyncAt: new Date().toISOString(),
          lastTitle: goal.title,
          lastStatus: goal.status,
          lastTargetDate: goal.targetDate ?? null,
          lastLevel: goal.level,
        });
        ctx.logger.info(`Created Linear Initiative for goal: ${initiative.name}`);
        return "created";
      } catch (err) {
        ctx.logger.warn(`Initiative creation failed (plan may not support it): ${err} — falling back to project issue`);
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_KEYS.initiativesSupported },
          false,
        );
      }
    }

    // Fallback: create issue inside "Company Goals" project
    const teamId = await getTeamId(ctx);
    const linearProjectId = await ensureGoalsLinearProject(ctx, token, teamId);
    const targetStateType = sync.paperclipGoalStatusToLinearStateType(goal.status);
    const states = await linear.getWorkflowStates(fetch, token, teamId);
    const stateId = states.find((s) => s.type === targetStateType)?.id;

    const created = await linear.createIssue(fetch, token, {
      title: goal.title,
      description: goalDescription(goal),
      teamId,
    });
    const followUp: Record<string, unknown> = { projectId: linearProjectId };
    if (goal.targetDate) followUp.dueDate = goal.targetDate;
    if (stateId) followUp.stateId = stateId;
    await linear.updateIssue(fetch, token, created.id, followUp);

    await sync.createGoalLink(ctx, {
      paperclipGoalId: goal.id,
      paperclipCompanyId: companyId,
      linearIssueId: created.id,
      linearIdentifier: created.identifier,
      linearUrl: created.url,
      linearProjectId,
      lastSyncAt: new Date().toISOString(),
      lastTitle: goal.title,
      lastStatus: goal.status,
      lastTargetDate: goal.targetDate ?? null,
      lastLevel: goal.level,
    });
    ctx.logger.info(`Created Linear issue (initiative fallback) for goal: ${goal.title} → ${created.identifier}`);
    return "created";
  }

  // Migrate issue-based link to initiative if workspace now supports them.
  // The previous mirror is a Linear issue inside the "Company Goals" project
  // (created when initiatives weren't yet supported). Once an initiative
  // exists for this goal, the old issue is orphaned and would otherwise sit
  // in the team's backlog forever — archive it (cancelled state) after the
  // link is repointed, but never roll the migration back if archive fails.
  if (existing.linearProjectId !== null && useInitiatives) {
    const oldLinearIssueId = existing.linearIssueId;
    try {
      const initiative = await linear.createInitiative(fetch, token, {
        name: goal.title,
        description: goalDescription(goal),
        targetDate: goal.targetDate ?? undefined,
      });

      // Suppress the inbound Initiative.create webhook for this initiative —
      // the link is about to be repointed at it, but Linear may deliver the
      // webhook before our updateGoalLink persists, which would otherwise
      // race the inbound handler into creating a duplicate goal.
      inFlightInitiativeCreates.add(initiative.id);

      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.initiativesSupported },
        true,
      );

      existing.linearIssueId = initiative.id;
      existing.linearIdentifier = initiative.id;
      existing.linearUrl = `https://linear.app/initiatives/${initiative.id}`;
      existing.linearProjectId = null;
      existing.lastTitle = goal.title;
      existing.lastStatus = goal.status;
      existing.lastTargetDate = goal.targetDate ?? null;
      existing.lastLevel = goal.level;
      await sync.updateGoalLink(ctx, existing);

      // Schedule clearing the in-flight guard. The 10s window matches the
      // issue path's recentlyCreatedFromLinear guard.
      setTimeout(() => inFlightInitiativeCreates.delete(initiative.id), 10_000);

      // Archive the orphaned old Linear issue. Best-effort: a failure here
      // leaves a stale ticket in Linear but does not undo the link migration.
      try {
        const teamId = await getTeamId(ctx);
        const states = await linear.getWorkflowStates(fetch, token, teamId);
        const cancelledStateId = states.find((s) => s.type === "canceled" || s.type === "cancelled")?.id;
        if (cancelledStateId) {
          await linear.updateIssue(fetch, token, oldLinearIssueId, {
            stateId: cancelledStateId,
            description: `[Migrated to Linear Initiative ${initiative.id}]\n\n${goalDescription(goal)}`,
          });
          ctx.logger.info(`Archived orphaned Linear issue ${oldLinearIssueId} after initiative migration`);
        } else {
          ctx.logger.warn(`No cancelled-type workflow state found; skipping archive of ${oldLinearIssueId}`);
        }
      } catch (archiveErr) {
        ctx.logger.warn(`Failed to archive orphaned issue ${oldLinearIssueId}: ${archiveErr}`);
      }

      ctx.logger.info(`Migrated goal to Linear Initiative: ${goal.title}`);
      return "updated";
    } catch (err) {
      ctx.logger.warn(`Initiative migration failed — keeping issue link: ${err}`);
      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.initiativesSupported },
        false,
      );
    }
  }

  // Update path — push changed fields
  const isInitiative = existing.linearProjectId === null && initiativesSupported === true;
  const update: Record<string, unknown> = {};

  if (goal.title !== existing.lastTitle) update.name = goal.title;
  if ((goal.targetDate ?? null) !== existing.lastTargetDate) {
    update.targetDate = goal.targetDate ?? null;
  }
  if (goal.level !== existing.lastLevel) {
    update.description = goalDescription(goal);
  }

  if (Object.keys(update).length === 0) {
    return "unchanged";
  }

  if (isInitiative) {
    await linear.updateInitiative(fetch, token, existing.linearIssueId, update);
  } else {
    // Issue fallback: map name→title, targetDate→dueDate
    const issueUpdate: Record<string, unknown> = {};
    if (update.name) issueUpdate.title = update.name;
    if ("targetDate" in update) issueUpdate.dueDate = update.targetDate;
    if (update.description) issueUpdate.description = update.description;
    if (Object.keys(issueUpdate).length > 0) {
      await linear.updateIssue(fetch, token, existing.linearIssueId, issueUpdate);
    }
  }

  existing.lastTitle = goal.title;
  existing.lastStatus = goal.status;
  existing.lastTargetDate = goal.targetDate ?? null;
  existing.lastLevel = goal.level;
  await sync.updateGoalLink(ctx, existing);

  ctx.logger.info(`Updated Linear ${isInitiative ? "Initiative" : "issue"} for goal: ${goal.title}`);
  return "updated";
}

async function ensureGoalsLinearProject(
  ctx: PluginContext,
  token: string,
  teamId: string,
): Promise<string> {
  const cached = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.goalsLinearProjectId,
  });
  if (cached) return String(cached);

  const fetch = ctx.http.fetch.bind(ctx.http);
  const projects = await linear.listProjects(fetch, token, teamId);
  const existing = projects.find((p) => p.name === GOALS_LINEAR_PROJECT_NAME);
  if (existing) {
    await ctx.state.set(
      { scopeKind: "instance", stateKey: STATE_KEYS.goalsLinearProjectId },
      existing.id,
    );
    return existing.id;
  }

  const created = await linear.createProject(fetch, token, {
    name: GOALS_LINEAR_PROJECT_NAME,
    description: "Paperclip-managed goals — mirrored for the Linear Gantt view.",
    teamIds: [teamId],
    state: "started",
  });
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.goalsLinearProjectId },
    created.id,
  );
  return created.id;
}

/** Push every Paperclip goal in the company to Linear, creating links as needed. */
async function runGoalSync(
  ctx: PluginContext,
  companyId: string,
): Promise<{ processed: number; created: number; updated: number; unchanged: number; missing: number; errors: number }> {
  const goals = await ctx.goals.list({ companyId });
  const tally = { created: 0, updated: 0, unchanged: 0, missing: 0 };
  let errors = 0;
  for (const goal of goals) {
    try {
      const outcome = await pushGoalToLinear(ctx, companyId, goal.id);
      tally[outcome] += 1;
    } catch (err) {
      ctx.logger.warn(`Goal sync failed for ${goal.id}: ${err}`);
      errors++;
    }
  }
  return { processed: goals.length, ...tally, errors };
}

export default plugin;
runWorker(plugin, import.meta.url);
