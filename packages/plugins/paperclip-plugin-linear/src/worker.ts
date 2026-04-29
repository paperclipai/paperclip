import crypto from "node:crypto";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";

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
  STATE_KEYS,
  LINEAR_OAUTH,
  GOALS_LINEAR_PROJECT_NAME,
} from "./constants.js";
import * as linear from "./linear.js";
import * as sync from "./sync.js";

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
      } catch {
        // Token may be expired — still show cached info if we have state
        if (connectedRaw) return { connected: true, ...info };
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
        completed: "done", cancelled: "cancelled",
      };
      const priority = priorityMap[linearIssue.priority] ?? "medium";
      const status = statusMap[linearIssue.state.type] ?? "backlog";

      const created = await ctx.issues.create({
        companyId,
        title: linearIssue.title,
        description: linearIssue.description ?? undefined,
        priority: priority as "critical" | "high" | "medium" | "low",
      });

      if (status !== "backlog") {
        await ctx.issues.update(created.id, { status: status as any }, companyId);
      }

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
      async (params: any) => {
        const { title, description, teamId: paramTeamId } = params as { title: string; description?: string; teamId?: string };
        const token = await resolveToken(ctx);
        const teamId = paramTeamId || await getTeamId(ctx).catch(() => "");
        if (!teamId) return { content: "Error: no team ID", data: { error: "No team ID specified" } };

        const issue = await linear.createIssue(ctx.http.fetch.bind(ctx.http), token, { title, description, teamId });
        return {
          content: `Created ${issue.identifier}: ${issue.title}`,
          data: { identifier: issue.identifier, title: issue.title, url: issue.url },
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
        await sync.syncToLinear(ctx, link, changes, token, teamId);
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
        const description = payload?.description as string | undefined;
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
        const description = payload?.description as string | undefined;
        const status = (payload?.status as string) ?? "backlog";

        const linearState = sync.paperclipProjectStateToLinear(status);
        const created = await linear.createProject(ctx.http.fetch.bind(ctx.http), token, {
          name, description, teamIds: [teamId], state: linearState,
        });

        await sync.createProjectLink(ctx, {
          paperclipProjectId: projectId,
          paperclipCompanyId: companyId,
          linearProjectId: created.id,
          linearProjectName: created.name,
          linearState,
          syncDirection: "bidirectional",
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
        await sync.syncProjectToLinear(ctx, link, changes, token);
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
        await sync.bridgeCommentToLinear(ctx, link, token, body, authorName);
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

      const fakeIssue: linear.LinearIssue = {
        id: linearIssueId,
        identifier: (data.identifier as string) ?? link.linearIdentifier,
        title: (data.title as string) ?? "",
        description: (data.description as string | null) ?? null,
        state: { name: stateName, type: stateType },
        priority: (data.priority as number) ?? 0,
        url: link.linearUrl,
        assignee: null,
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

    } else if (action === "create") {
      // New issue created in Linear → create in Paperclip
      const companyId = await getCompanyId(ctx);
      if (!companyId) return;

      const existing = await sync.getLinkByLinear(ctx, linearIssueId);
      if (existing) return;

      // Prevent duplicate creation from simultaneous webhook deliveries
      if (inFlightCreates.has(linearIssueId)) {
        ctx.logger.info(`Skipping duplicate webhook create for ${linearIssueId} — already in flight`);
        return;
      }
      inFlightCreates.add(linearIssueId);

      const identifier = data.identifier as string | undefined;
      const state = data.state as Record<string, unknown> | undefined;
      const stateType = (state?.type as string) ?? "backlog";

      const statusMap: Record<string, string> = {
        backlog: "backlog", unstarted: "todo", started: "in_progress",
        completed: "done", cancelled: "cancelled",
      };
      const priorityMap: Record<number, string> = {
        0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
      };

      const status = statusMap[stateType] ?? "backlog";
      const priority = priorityMap[(data.priority as number) ?? 0] ?? "medium";

      try {
        const created = await ctx.issues.create({
          companyId,
          title: (data.title as string) ?? "Untitled",
          description: (data.description as string | null) ?? undefined,
          priority: priority as "critical" | "high" | "medium" | "low",
        });

        if (status !== "backlog") {
          await ctx.issues.update(created.id, {
            status: status as any,
          }, companyId);
        }

        const url = identifier
          ? `https://linear.app/issue/${identifier}`
          : "";

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

    const userName = (data.user as Record<string, unknown>)?.name as string ?? "Linear user";

    try {
      await ctx.issues.createComment(
        link.paperclipIssueId,
        `**${userName}** (from Linear):\n\n${commentBody}`,
        link.paperclipCompanyId,
      );

      await ctx.activity.log({
        companyId: link.paperclipCompanyId,
        message: `issue.comment.synced_from_linear`,
        entityType: "issue",
        entityId: link.paperclipIssueId,
        metadata: { source: "linear", identifier: link.linearIdentifier, author: userName, bodySnippet: commentBody.slice(0, 120), action: "comment.synced" },
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

        await sync.createProjectLink(ctx, {
          paperclipProjectId: created.id,
          paperclipCompanyId: companyId,
          linearProjectId,
          linearProjectName: name,
          linearState: state,
          syncDirection: "bidirectional",
        });

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
    planned: "backlog", backlog: "backlog",
    started: "active", "in progress": "active",
    completed: "completed", done: "completed",
    canceled: "cancelled", cancelled: "cancelled",
    paused: "paused",
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
          await sync.createProjectLink(ctx, {
            paperclipProjectId,
            paperclipCompanyId: companyId,
            linearProjectId: lp.id,
            linearProjectName: lp.name,
            linearState: lp.state?.toLowerCase() ?? "planned",
            syncDirection: "bidirectional",
          });
        } catch (err) {
          ctx.logger.warn(`Failed to create project link for ${lp.name}: ${err}`);
        }
      }
    }
  }

  // Also push Paperclip-only projects to Linear
  for (const ep of existingProjects) {
    if (!linearProjects.some((lp) => lp.name === ep.name)) {
      try {
        const linearState = sync.paperclipProjectStateToLinear(ep.status ?? "backlog");
        const created = await linear.createProject(fetch, token, {
          name: ep.name,
          description: ep.description ?? undefined,
          teamIds: [teamId],
          state: linearState,
        });

        await sync.createProjectLink(ctx, {
          paperclipProjectId: ep.id,
          paperclipCompanyId: companyId,
          linearProjectId: created.id,
          linearProjectName: created.name,
          linearState,
          syncDirection: "bidirectional",
        });
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
        completed: "done", cancelled: "cancelled",
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

      // Resolve project
      const projectId = linearIssue.project?.name
        ? projectMap.get(linearIssue.project.name) ?? null
        : null;

      const description = linearIssue.description ?? undefined;

      try {
        const created = await ctx.issues.create({
          companyId,
          title: linearIssue.title,
          description,
          priority: priority as "critical" | "high" | "medium" | "low",
          ...(projectId ? { projectId } : {}),
          ...(issueLabelIds.length > 0 ? { labelIds: issueLabelIds } : {}),
        } as any);

        if (status !== "backlog") {
          await ctx.issues.update(created.id, {
            status: status as any,
          }, companyId);
        }

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

async function runFullSync(ctx: PluginContext): Promise<{
  synced: number;
  errors: number;
}> {
  let token: string;
  try {
    token = await resolveToken(ctx);
  } catch {
    return { synced: 0, errors: 0 };
  }

  const teamId = await getTeamId(ctx).catch(() => "");
  if (!teamId) return { synced: 0, errors: 0 };

  // Fetch all open Linear issues for the team
  const allLinear: linear.LinearIssue[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await linear.listOpenIssues(
      ctx.http.fetch.bind(ctx.http),
      token,
      teamId,
      cursor,
    );
    allLinear.push(...page.issues);
    hasMore = page.hasNextPage;
    cursor = page.endCursor ?? undefined;
  }

  let synced = 0;
  let errors = 0;

  for (const linearIssue of allLinear) {
    const link = await sync.getLinkByLinear(ctx, linearIssue.id);
    if (!link) continue;

    try {
      await sync.syncFromLinear(ctx, link, linearIssue);
      synced++;
    } catch (err) {
      ctx.logger.warn(`Sync failed for ${linearIssue.identifier}: ${err}`);
      errors++;
    }
  }

  ctx.logger.info(`Full sync complete: ${synced} synced, ${errors} errors`);

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
    if (companyId) {
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

  return { synced, errors };
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
  const supportsUpdate = projectsUpdate !== null;
  const supportsCreate = projectsCreate !== null;

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
        if (!supportsUpdate) {
          skippedDrift++;
          continue;
        }
        await sync.syncProjectFromLinear(ctx, existing, {
          id: lp.id,
          name: lp.name,
          description: lp.description ?? null,
          state: lp.state,
        });
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
      const createdProj = await projectsCreate!({
        companyId,
        name: lp.name,
        description: lp.description ?? undefined,
        status,
      });
      await sync.createProjectLink(ctx, {
        paperclipProjectId: createdProj.id,
        paperclipCompanyId: companyId,
        linearProjectId: lp.id,
        linearProjectName: lp.name,
        linearState: lp.state ?? "planned",
        syncDirection: "bidirectional",
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
        const cancelledStateId = states.find((s) => s.type === "cancelled")?.id;
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
