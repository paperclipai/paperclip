import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { agents, companies, connectionGrants, issueThreadInteractions, toolConnectionInstalls } from "@paperclipai/db";
import { and, eq, or } from "drizzle-orm";
import {
  APP_STORE_DEFINITIONS,
  DEFAULT_OWNERSHIP_AVAILABILITY,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  isGoogleWorkspaceConnectorProfileId,
  TOOL_ACTION_REQUEST_STATUSES,
  type DeploymentExposure,
  type DeploymentMode,
  type PermissionKey,
  type ToolConnection,
  type ToolConnectionCreateCapabilities,
  connectToolAppSchema,
  createConnectionGrantDelegationSchema,
  createToolStdioCommandTemplateSchema,
  createToolApplicationSchema,
  createToolConnectionSchema,
  createToolPolicySchema,
  createToolProfileBindingForProfileSchema,
  createToolProfileEntryForProfileSchema,
  createToolProfileWithEntriesSchema,
  deleteToolProfileSchema,
  duplicateToolPolicySchema,
  disableToolStdioCommandTemplateSchema,
  duplicateToolProfileSchema,
  finishToolAppSchema,
  finalizeOAuthAccessSchema,
  startToolOAuthSchema,
  reconnectToolAppSchema,
  replaceConnectionGrantMembersSchema,
  reviewToolProfileNewToolsSchema,
  createToolTrustRuleFromActionRequestSchema,
  importMcpJsonSchema,
  putToolConnectionInstallsSchema,
  connectionTokenRequestSchema,
  startConnectionAuthorizationSchema,
  revokeToolTrustRuleSchema,
  reorderToolPoliciesSchema,
  toolPolicyTestRequestSchema,
  toolConnectionTestCallSchema,
  unbindToolProfileBindingSchema,
  updateToolApplicationSchema,
  updateToolConnectionSchema,
  updateToolPolicySchema,
  updateToolProfileEntrySchema,
  updateToolProfileWithEntriesSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { getActorInfo, assertBoard, assertCompanyAccess, assertInstanceAdmin, getAccessibleResource, hasCompanyAccess } from "./authz.js";
import { badRequest, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { accessService, logActivity, toolAccessPolicyService, toolAccessService, vercelConnectIntegrationStatus } from "../services/index.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";
import type { ComposioClient } from "../services/composio.js";
import type { VercelConnectClient } from "../services/vercel-connect.js";
import {
  isPaperclipCloudConnectorStrategy,
  type PaperclipCloudConnector,
  paperclipCloudConnectorCapabilitiesFromEnv,
} from "../services/paperclip-cloud-connector.js";
import { runtimeCanonicalOrigin } from "../services/cloud-runtime-identity.js";
import {
  completePaperclipCloudConnectorEnrollment,
  loadPaperclipCloudConnectorIdentity,
  startPaperclipCloudConnectorEnrollment,
} from "../services/paperclip-cloud-connector-enrollment.js";
import { reconcilePaperclipCloudConnectorEnrollmentStatus } from "../services/paperclip-cloud-connector-status.js";
import {
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH,
  oauthClientIdMetadataDocument,
} from "../services/tool-access.js";
import { isLoopbackHost } from "../url-utils.js";
import { trustedBoardMutationOrigin } from "../middleware/board-mutation-guard.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { redactRemoteUrlCredential } from "../services/remote-url-credentials.js";
import { wakeConnectionIntentAfterResolution } from "./connection-intents.js";
import type { heartbeatService } from "../services/heartbeat.js";

const COMPANY_INSTALL_DENIAL_REASON =
  "Only someone who can configure this connection can choose this.";
const ORGANIZATION_GRANT_DENIAL_REASON =
  "Only a company owner, administrator, or connection manager can share this credential with the organization.";
type Heartbeat = ReturnType<typeof heartbeatService>;

/** Allowlist (e.g. Google Sheets allowed spreadsheet ids) lives in connection config. */
function allowlistIds(config: Record<string, unknown> | null | undefined): string[] {
  const raw = config?.allowedSpreadsheetIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function agentOrgDepths(rows: Array<{ id: string; reportsTo: string | null }>): Map<string, number> {
  const parentById = new Map(rows.map((row) => [row.id, row.reportsTo]));
  const depthById = new Map<string, number>();

  const depthFor = (agentId: string, path: Set<string>): number => {
    const known = depthById.get(agentId);
    if (known !== undefined) return known;
    const parentId = parentById.get(agentId);
    if (!parentId || !parentById.has(parentId) || path.has(agentId)) {
      depthById.set(agentId, 0);
      return 0;
    }
    const nextPath = new Set(path).add(agentId);
    const depth = depthFor(parentId, nextPath) + 1;
    depthById.set(agentId, depth);
    return depth;
  };

  for (const row of rows) depthFor(row.id, new Set());
  return depthById;
}

/**
 * Classify a connection PATCH into operator-visible lifecycle events so the
 * per-app Activity tab can humanize them (PAP-11284). A single update may
 * touch more than one thing (e.g. pause + allowlist), so this returns a list.
 */
function classifyConnectionUpdate(
  before: { enabled: boolean; config?: Record<string, unknown> | null },
  after: { enabled: boolean; config?: Record<string, unknown> | null },
): Array<{ lifecycle: "paused" | "resumed" | "allowlist_changed"; details: Record<string, unknown> }> {
  const events: Array<{ lifecycle: "paused" | "resumed" | "allowlist_changed"; details: Record<string, unknown> }> = [];
  if (before.enabled !== after.enabled) {
    events.push({ lifecycle: after.enabled ? "resumed" : "paused", details: { enabled: after.enabled } });
  }
  const beforeIds = allowlistIds(before.config);
  const afterIds = allowlistIds(after.config);
  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(afterIds);
  const added = afterIds.filter((id) => !beforeSet.has(id)).length;
  const removed = beforeIds.filter((id) => !afterSet.has(id)).length;
  if (added > 0 || removed > 0) {
    events.push({ lifecycle: "allowlist_changed", details: { added, removed, total: afterIds.length } });
  }
  return events;
}

export function filterVisibleToolConnections<T extends {
  status?: string;
  createdByUserId?: string | null;
}>(
  connections: T[],
  actor: { userId?: string | null; canManageConnections: boolean },
): T[] {
  return connections.filter((connection) =>
    connection.status !== "draft"
    || actor.canManageConnections
    || Boolean(actor.userId && connection.createdByUserId === actor.userId));
}

export function connectionIntentOAuthOutcomeHtml(input: {
  interactionId: string;
  issueId: string | null;
  outcome: "connected" | "declined" | "failed";
  openerOrigin?: string | null;
}) {
  // The callback window is only a signal. Connection identity and every
  // authorization URL stay server-side; the opener refreshes the task from the
  // interaction id instead of trusting provider-window data.
  const message = JSON.stringify({
    type: "paperclip.connection-intent.oauth",
    interactionId: input.interactionId,
    outcome: input.outcome,
  }).replace(/</g, "\\u003c");
  const issuePath = input.issueId
    ? `/issues/${encodeURIComponent(input.issueId)}`
    : "/issues";
  const fallback = JSON.stringify(issuePath);
  const openerOrigin = (() => {
    if (!input.openerOrigin) return null;
    try {
      const parsed = new URL(input.openerOrigin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password
        ? parsed.origin
        : null;
    } catch {
      return null;
    }
  })();
  const targetOrigin = JSON.stringify(openerOrigin ?? "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connection authorization</title></head><body><p>Returning to Paperclip…</p><script>const message=${message};const targetOrigin=${targetOrigin}||window.location.origin;if(window.opener&&window.opener!==window){window.opener.postMessage(message,targetOrigin);window.close();}else{window.location.replace(${fallback});}</script></body></html>`;
}

function normalizeCloudConnectorEnrollmentReturnTo(returnTo?: string | null): string | null {
  if (!returnTo || returnTo.length > 2_048) return null;
  try {
    const parsed = new URL(returnTo, "http://paperclip.local");
    if (
      parsed.origin !== "http://paperclip.local"
      || parsed.pathname !== "/apps/connect"
      || parsed.username
      || parsed.password
    ) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function cloudConnectorEnrollmentReturnPath(issuePrefix: string, returnTo?: string | null): string {
  const companyRoot = `/${encodeURIComponent(issuePrefix)}`;
  const normalizedReturnTo = normalizeCloudConnectorEnrollmentReturnTo(returnTo);
  if (normalizedReturnTo) {
    const parsed = new URL(normalizedReturnTo, "http://paperclip.local");
    parsed.searchParams.set("cloud_connector", "enrolled");
    return `${companyRoot}${parsed.pathname}${parsed.search}`;
  }
  return `${companyRoot}/apps/connections?cloud_connector=enrolled`;
}

export function toolAccessRoutes(
  db: Db,
  options: {
    deploymentMode?: DeploymentMode;
    deploymentExposure?: DeploymentExposure;
    authPublicBaseUrl?: string | null;
    trustedLocalStdioRuntimeHost?: string | null;
    toolGateway?: ToolGatewayService;
    /** Test-only seams forwarded to the tool access service. */
    remoteHttpEndpointLookup?: NonNullable<Parameters<typeof toolAccessService>[1]>["remoteHttpEndpointLookup"];
    remoteHttpRequest?: NonNullable<Parameters<typeof toolAccessService>[1]>["remoteHttpRequest"];
    composioClientFactory?: (apiKey: string) => ComposioClient;
    vercelConnectClient?: VercelConnectClient | null;
    paperclipCloudConnector?: PaperclipCloudConnector | null;
    connectionIntentHeartbeat?: Pick<Heartbeat, "wakeup">;
  } = {},
) {
  const router = Router();
  const svc = toolAccessService(db, options);
  const policySvc = toolAccessPolicyService(db);
  const connectionIntents = connectionIntentService(db);

  async function isConnectionIntent(interactionId: string | null | undefined) {
    if (!interactionId) return false;
    const row = await db
      .select({ kind: issueThreadInteractions.kind })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.kind === "connection_intent";
  }

  function bypassCurrentMembershipCheck(req: Request) {
    return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
  }

  async function finishConnectionIntentOAuth(input: {
    interactionId: string;
    connectionId?: string;
    userId: string;
    outcome: "connected" | "declined" | "failed";
    canManageOrganizationGrant: boolean;
    bypassCurrentMembershipCheck: boolean;
  }) {
    const loaded = await connectionIntents.loadIntent(input.interactionId);
    if (loaded.interaction.addresseeUserId !== input.userId) {
      throw forbidden("OAuth callback user does not match the connection request");
    }
    if (loaded.interaction.status !== "pending") return loaded.interaction;
    const interaction = input.outcome === "connected" && input.connectionId
      ? await connectionIntents.complete(input.interactionId, input.connectionId, input.userId, {
          canManageOrganizationGrant: input.canManageOrganizationGrant,
          bypassCurrentMembershipCheck: input.bypassCurrentMembershipCheck,
        })
      : input.outcome === "declined"
        ? await connectionIntents.decline(
            input.interactionId,
            input.userId,
            "Authorization was declined in the provider window",
            { bypassCurrentMembershipCheck: input.bypassCurrentMembershipCheck },
          )
        : await connectionIntents.updatePhase(input.interactionId, "needs_retry", input.userId, {
            bypassCurrentMembershipCheck: input.bypassCurrentMembershipCheck,
          });
    if (input.outcome !== "failed" && options.connectionIntentHeartbeat) {
      await wakeConnectionIntentAfterResolution(options.connectionIntentHeartbeat, {
        loaded,
        status: interaction.status,
        actorId: input.userId,
      });
    }
    return interaction;
  }

  function sendConnectionIntentOAuthOutcome(
    res: import("express").Response,
    input: {
      interactionId: string;
      issueId: string | null;
      outcome: "connected" | "declined" | "failed";
      openerOrigin?: string | null;
    },
  ) {
    res.type("html").send(connectionIntentOAuthOutcomeHtml(input));
  }

  function configuredPublicBaseUrl() {
    const runtimeOrigin = runtimeCanonicalOrigin();
    if (runtimeOrigin) return runtimeOrigin;
    const raw = (
      process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim()
      || process.env.BETTER_AUTH_URL?.trim()
      || process.env.BETTER_AUTH_BASE_URL?.trim()
      || options.authPublicBaseUrl?.trim()
      || process.env.PAPERCLIP_PUBLIC_URL?.trim()
      || process.env.PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL?.trim()
    );
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }

  function requestLoopbackBaseUrl(req: Request) {
    const host = req.get("host")?.trim();
    if (!host) return null;
    try {
      const parsed = new URL(`${req.protocol}://${host}`);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || parsed.username
        || parsed.password
        || !isLoopbackHost(parsed.hostname)
      ) {
        return null;
      }
      // A few otherwise standards-compliant DCR servers reject numeric
      // loopback redirect hosts while accepting localhost. In local-trusted
      // mode both names reach the same loopback-only process, so advertise the
      // interoperable spelling and retain the browser's exact origin as OAuth
      // state for popup postMessage below.
      if (
        (options.deploymentMode ?? "local_trusted") === "local_trusted"
        && parsed.protocol === "http:"
        && parsed.hostname !== "localhost"
      ) {
        parsed.hostname = "localhost";
      }
      return parsed.origin;
    } catch {
      return null;
    }
  }

  function trustedBrowserBaseUrl(req: Request) {
    const origin = trustedBoardMutationOrigin(req);
    if (!origin) return null;
    try {
      const parsed = new URL(origin);
      const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
      const routedHost = forwardedHost || req.header("host")?.trim();
      const normalizedRoutedHost = routedHost
        ? new URL(`${parsed.protocol}//${routedHost}`).host.toLowerCase()
        : null;
      if (
        parsed.host.toLowerCase() === normalizedRoutedHost
        && (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)))
      ) {
        return parsed.origin;
      }
    } catch {
      // The shared origin parser already validates this. Fail closed if its
      // contract ever changes.
    }
    return null;
  }

  function enrolledConnectorBaseUrl(req: Request) {
    // Browser-initiated mutations must prove their own same-origin HTTPS
    // request. The durable binding is only a callback/metadata fallback for
    // provider GETs, which do not carry the initiating browser's Origin.
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const identity = loadPaperclipCloudConnectorIdentity();
    if (identity?.status !== "active") return null;
    const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
    const requestHost = (forwardedHost || req.header("host")?.trim())?.toLowerCase();
    if (!requestHost) return null;
    for (const origin of identity.origins) {
      try {
        const parsed = new URL(origin);
        if (
          parsed.protocol === "https:"
          && !parsed.username
          && !parsed.password
          && parsed.host.toLowerCase() === requestHost
        ) {
          return parsed.origin;
        }
      } catch {
        // Ignore malformed legacy identity origins.
      }
    }
    return null;
  }

  function oauthRedirectUri(req: Request) {
    const baseUrl = configuredPublicBaseUrl()
      ?? trustedBrowserBaseUrl(req)
      ?? enrolledConnectorBaseUrl(req)
      ?? requestLoopbackBaseUrl(req);
    if (!baseUrl) {
      throw unprocessable(
        "This Paperclip needs a browser-reachable HTTPS address (or loopback HTTP) before browser sign-in can start.",
        { code: "oauth_redirect_origin_unsupported" },
      );
    }
    return new URL("/api/tools/oauth/callback", baseUrl).toString();
  }

  function oauthBrowserOrigin(req: Request) {
    const trustedBrowserOrigin = trustedBrowserBaseUrl(req);
    if (trustedBrowserOrigin) return trustedBrowserOrigin;
    const host = req.get("host")?.trim();
    if (!host) return null;
    try {
      const parsed = new URL(`${req.protocol}://${host}`);
      return isLoopbackHost(parsed.hostname) ? parsed.origin : null;
    } catch {
      return null;
    }
  }

  async function oauthAppPath(
    companyId: string,
    connectionId: string,
  ) {
    const [company] = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!company) throw new Error("OAuth callback connection belongs to a missing company");
    return `/${company.issuePrefix}/apps/${connectionId}/permissions`;
  }

function connectorEnrollmentPrincipal(req: Request): string {
  return req.actor.userId ? `user:${req.actor.userId}` : `source:${req.actor.source ?? "board"}`;
}

/**
   * A failed first authorization is still an incomplete setup, not an app
   * configuration task. Send it back to the same exact draft so the operator
   * can retry the missing checkpoint. Reauthorization of an already-active
   * connection keeps the established detail-page recovery route.
   */
  async function oauthRecoveryPath(
    connection: ToolConnection,
    outcome: "failed" | "denied",
    code?: string | null,
  ) {
    const detailPermissionsPath = await oauthAppPath(connection.companyId, connection.id);
    const params = new URLSearchParams({ oauth: outcome });
    if (code) params.set("code", code);
    const source = connection.config?.sourceTemplateKey
      ?? connection.transportConfig?.sourceTemplateKey;
    if (connection.status !== "draft" || typeof source !== "string" || !source.trim()) {
      return `${detailPermissionsPath}?${params.toString()}`;
    }

    const appsSegment = detailPermissionsPath.indexOf("/apps/");
    const companyPrefix = appsSegment >= 0 ? detailPermissionsPath.slice(0, appsSegment) : "";
    const setupParams = new URLSearchParams({
      source,
      resume: connection.id,
      oauth: outcome,
    });
    if (code) setupParams.set("code", code);
    const setupRoute = connection.credentialSource === "vercel_connect"
      ? "/apps/vercel-connect"
      : "/apps/connect";
    return `${companyPrefix}${setupRoute}?${setupParams.toString()}`;
  }

  const access = accessService(db);

  async function assertBoardToolPermission(req: Request, companyId: string, permissionKey: PermissionKey) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (userId && await access.hasPermission(companyId, "user", userId, permissionKey)) return;
    throw forbidden(`Missing permission: ${permissionKey}`);
  }

  function activeToolMembership(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return null;
    const membership = Array.isArray(req.actor.memberships)
      ? req.actor.memberships.find((item) => item.companyId === companyId)
      : null;
    if (!membership || membership.status !== "active") {
      throw forbidden("User does not have active company access");
    }
    if (!membership.membershipRole || membership.membershipRole === "viewer") {
      throw forbidden("Viewer access is read-only");
    }
    return membership;
  }

  async function isToolConnectionManager(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return Boolean(req.actor.userId && await access.hasPermission(
      companyId,
      "user",
      req.actor.userId,
      "tools:manage_connections",
    ));
  }

  async function assertToolConnectionConfigureAccess(
    req: Request,
    connection: { companyId: string; createdByUserId?: string | null },
  ) {
    activeToolMembership(req, connection.companyId);
    if (await isToolConnectionManager(req, connection.companyId)) return;
    if (req.actor.userId && connection.createdByUserId === req.actor.userId) return;
    throw forbidden(
      "Only the connection creator or a connection manager can configure, reconnect, or delete this connection",
    );
  }

  async function assertToolConnectionAccess(
    req: Request,
    connection: { id: string; companyId: string; createdByUserId?: string | null },
  ) {
    activeToolMembership(req, connection.companyId);
    if (await isToolConnectionManager(req, connection.companyId)) return;
    if (req.actor.userId && connection.createdByUserId === req.actor.userId) return;
    const [grant] = await db
      .select({ id: connectionGrants.id })
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.status, "active"),
        or(
          eq(connectionGrants.kind, "organization"),
          req.actor.userId
            ? and(eq(connectionGrants.kind, "user"), eq(connectionGrants.subjectUserId, req.actor.userId))
            : eq(connectionGrants.kind, "organization"),
        ),
      ))
      .limit(1);
    if (grant) return;
    throw forbidden("You need access to this connection before you can install it on an agent");
  }

  /**
   * Non-throwing membership probe for capability reporting (PAP-17835).
   *
   * `activeToolMembership` throws for viewers because it guards mutations. The
   * personal-connections UI still has to *render* for a viewer, so capability
   * computation needs the role without the 403. Returns `null` for a principal
   * with no scoped membership (local implicit / instance admin), matching
   * `activeToolMembership`'s "unrestricted" sentinel.
   */
  function toolMembershipRole(req: Request, companyId: string): {
    unrestricted: boolean;
    role: string | null;
    isViewer: boolean;
    isActive: boolean;
  } {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      return { unrestricted: true, role: null, isViewer: false, isActive: true };
    }
    const membership = Array.isArray(req.actor.memberships)
      ? req.actor.memberships.find((item) => item.companyId === companyId)
      : null;
    const isActive = Boolean(membership && membership.status === "active");
    const role = membership?.membershipRole ?? null;
    return { unrestricted: false, role, isViewer: role === "viewer", isActive };
  }

  async function isToolConnectionManagerQuiet(req: Request, companyId: string) {
    const membership = toolMembershipRole(req, companyId);
    if (membership.unrestricted) return true;
    if (!membership.isActive || membership.isViewer) return false;
    if (membership.role === "owner" || membership.role === "admin") return true;
    return Boolean(req.actor.userId && await access.hasPermission(
      companyId,
      "user",
      req.actor.userId,
      "tools:manage_connections",
    ));
  }

  async function describeConnectionCreateCapabilities(
    req: Request,
    companyId: string,
  ): Promise<ToolConnectionCreateCapabilities> {
    const canManageConnections = await isToolConnectionManagerQuiet(req, companyId);
    return {
      canCreateOrganizationGrant: canManageConnections,
      organizationGrantReason: canManageConnections ? null : ORGANIZATION_GRANT_DENIAL_REASON,
      canSetCompanyInstall: canManageConnections,
      companyInstallReason: canManageConnections ? null : COMPANY_INSTALL_DENIAL_REASON,
    };
  }

  /**
   * Server-computed capabilities for the connection identity/install surfaces.
   * The UI renders the §3 matrix from these booleans instead of reconstructing
   * policy from role strings, because creator identity and per-agent edit rights
   * are not derivable client-side.
   */
  async function describeConnectionCapabilities(
    req: Request,
    connection: { id: string; companyId: string; createdByUserId?: string | null },
  ) {
    const membership = toolMembershipRole(req, connection.companyId);
    const isManager = await isToolConnectionManagerQuiet(req, connection.companyId);
    const mutationCapable = membership.unrestricted || (membership.isActive && !membership.isViewer);
    const isCreator = Boolean(req.actor.userId && connection.createdByUserId === req.actor.userId);
    const canConfigure = isManager || (mutationCapable && isCreator);
    const editableAgentIds: string[] = [];
    if (mutationCapable) {
      const companyAgents = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, connection.companyId));
      for (const agent of companyAgents) {
        const decision = await access.decide({
          actor: req.actor,
          action: "agent_config:update",
          resource: { type: "agent", companyId: connection.companyId, agentId: agent.id },
        });
        if (decision.allowed) editableAgentIds.push(agent.id);
      }
    }
    return {
      canConfigure,
      canCreateOrganizationGrant: canConfigure,
      canSetCompanyInstall: canConfigure,
      // Personal consent belongs to the person: it needs a named board user, and
      // it is never available to a viewer or to an unauthenticated principal.
      canConnectAsCurrentUser: Boolean(req.actor.userId) && mutationCapable,
      canManageAgentInstalls: mutationCapable && editableAgentIds.length > 0,
      canViewOtherPersonalIdentities: isManager,
      editableAgentIds,
    };
  }

  /**
   * Per-grant authorization. Revoking your own identity is always allowed (the
   * consent is yours to withdraw); revoking anyone else's is manager-only — that
   * is the kill switch. Audience editing is creator-or-manager, and only for an
   * organization grant.
   */
  function describeGrantCapabilities(
    grant: { kind: string; subjectUserId: string | null; createdByUserId: string | null },
    context: { userId: string | null; isManager: boolean; mutationCapable: boolean },
  ) {
    if (!context.mutationCapable) return { canRevoke: false, canEditAudience: false };
    const isOwnGrant = Boolean(context.userId && grant.subjectUserId === context.userId);
    const isGrantCreator = Boolean(context.userId && grant.createdByUserId === context.userId);
    return {
      canRevoke: isOwnGrant || isGrantCreator || context.isManager,
      canEditAudience: grant.kind === "organization" && (isGrantCreator || context.isManager),
    };
  }

  async function assertBoardAnyToolPermission(req: Request, companyId: string, permissionKeys: PermissionKey[]) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (userId) {
      for (const permissionKey of permissionKeys) {
        if (await access.hasPermission(companyId, "user", userId, permissionKey)) return;
      }
    }
    throw forbidden(`Missing one of permissions: ${permissionKeys.join(", ")}`);
  }

  async function assertCanTestAsAgent(req: Request, companyId: string, agentId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: null,
        projectId: null,
        parentIssueId: null,
        assigneeAgentId: agentId,
        assigneeUserId: null,
      },
      scope: {
        assigneeAgentId: agentId,
        assigneeUserId: null,
      },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation);
  }

  function sendToolGatewayError(res: import("express").Response, error: unknown) {
    if (error instanceof ToolGatewayHttpError) {
      res.status(error.status).json({ error: error.message, reasonCode: error.reasonCode, ...error.details });
      return true;
    }
    return false;
  }

  async function assertToolsAdmin(req: Request, companyId: string) {
    await assertBoardToolPermission(req, companyId, "tools:admin");
  }

  async function assertToolsRuntimeManage(req: Request, companyId: string) {
    await assertBoardToolPermission(req, companyId, "tools:manage_runtime");
  }

  router.post("/agents/me/connections/:connectionId/start-authorization", validate(startConnectionAuthorizationSchema), async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId || !req.actor.runId) {
      res.status(401).json({ error: "Active agent run authentication required" });
      return;
    }
    const result = await svc.startAuthorizationForAgent({
      companyId: req.actor.companyId,
      connectionId: req.params.connectionId as string,
      agentId: req.actor.agentId,
      runId: req.actor.runId,
      subjectUserId: req.body.subjectUserId,
      scopes: req.body.scopes,
      returnTo: req.body.returnTo,
      redirectUri: oauthRedirectUri(req),
    });
    res.json({ url: result.authorizationUrl, ...(result.handoff ? { handoff: result.handoff } : {}) });
  });

  router.post("/agents/me/connections/:connectionId/token", validate(connectionTokenRequestSchema), async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    if (!req.actor.runId) {
      res.status(401).json({ error: "Agent run id required", code: "run_id_required" });
      return;
    }
    const headerRunId = req.get("X-Paperclip-Run-Id")?.trim();
    if (headerRunId && headerRunId !== req.actor.runId) {
      res.status(403).json({ error: "Run id header does not match agent token", code: "run_id_mismatch" });
      return;
    }
    const result = await svc.mintConnectionTokenForAgent({
      connectionId: req.params.connectionId as string,
      companyId: req.actor.companyId,
      agentId: req.actor.agentId,
      runId: req.actor.runId,
      body: req.body,
    });
    res.status(result.status === "use_env_lease" ? 409 : 200).json(result);
  });

  function assertToolAppMutationAccess(req: Request, companyId: string) {
    activeToolMembership(req, companyId);
  }

  router.get("/companies/:companyId/tools/gallery", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const advertisedProfiles = options.paperclipCloudConnector === undefined
      ? await paperclipCloudConnectorCapabilitiesFromEnv()
      : options.paperclipCloudConnector
        ? await options.paperclipCloudConnector.getCapabilities()
        : [];
    const googleConnectorProfiles = new Set(advertisedProfiles);
    const vercelConnect = vercelConnectIntegrationStatus();
    res.json({
      capabilities: await describeConnectionCreateCapabilities(req, companyId),
      credentialSources: {
        vercelConnect: {
          available: vercelConnect.enabled && vercelConnect.configured,
          enabled: vercelConnect.enabled,
          authentication: vercelConnect.authentication,
          manageUrl: vercelConnect.manageUrl,
          reason: vercelConnect.enabled
            ? vercelConnect.configured
              ? null
              : "Vercel Connect needs workload OIDC or PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN."
            : "Vercel Connect setup is disabled on this Paperclip instance.",
        },
      },
      apps: APP_STORE_DEFINITIONS.map((app) => {
        const methods = app.methods.filter((method) =>
          !isPaperclipCloudConnectorStrategy(method.oauthStrategy)
          || Boolean(method.connectorProfile && googleConnectorProfiles.has(method.connectorProfile as never))
        );
        return {
          ...app,
          methods,
          ownershipAvailability: {
            ...DEFAULT_OWNERSHIP_AVAILABILITY,
            platform_shared: methods.some((method) => isPaperclipCloudConnectorStrategy(method.oauthStrategy)),
          },
        };
      }),
    });
  });

  router.get("/companies/:companyId/tools/apps/:galleryKey/preflight", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const methodKey = typeof req.query.methodKey === "string" ? req.query.methodKey.trim() || null : null;
    res.json(await svc.preflightGalleryAppMetadata(req.params.galleryKey as string, methodKey));
  });

  /**
   * Paperclip's Client ID Metadata Document (PAP-17087).
   *
   * The document's own URL is the `client_id` Paperclip presents to an
   * authorization server that supports CIMD, so this endpoint has to be publicly
   * readable — an authorization server fetches it server-to-server with no
   * Paperclip session. It contains only this deployment's callback and the
   * grant/response/auth methods Paperclip uses: no company, connection or secret
   * data of any kind.
   */
  router.get(OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH.replace(/^\/api/, ""), (_req, res) => {
    const redirectUri = oauthRedirectUri(_req);
    const clientId = new URL(OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH, new URL(redirectUri).origin).toString();
    res.type("application/json").json(oauthClientIdMetadataDocument({ clientId, redirectUri }));
  });

  router.post("/companies/:companyId/tools/apps/connect", validate(connectToolAppSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    // An omitted grant kind is the backward-compatible organization default.
    // On resume, the persisted connection identity is authoritative: accepting
    // a contradictory `grantKind: "user"` here could otherwise let a creator
    // replace the credential behind an existing organization grant.
    const resumedConnection = req.body.resumeConnectionId
      ? await svc.getConnection(req.body.resumeConnectionId, companyId)
      : null;
    const effectiveGrantKind = resumedConnection
      ? resumedConnection.credentialPolicy === "per_user" ? "user" : "organization"
      : req.body.grantKind ?? "organization";
    // Personal connection creation remains available to ordinary active
    // members, but sharing a credential with every human is a manager
    // operation and must be enforced here, not inferred by the client.
    const createsOrganizationGrant = effectiveGrantKind === "organization";
    if (createsOrganizationGrant && !await isToolConnectionManagerQuiet(req, companyId)) {
      throw forbidden(ORGANIZATION_GRANT_DENIAL_REASON);
    }
    try {
      const result = await svc.connectGalleryApp(companyId, req.body, getActorInfo(req));
      if (result.auth?.kind === "oauth") {
        try {
          // "Just me" must consent as the caller, not as the workspace: passing
          // `subjectUserId` is what makes the callback land the tokens on the
          // caller's personal grant instead of an organization grant
          // (PAP-17835). The service refuses any subject other than the actor,
          // so this cannot start consent on someone else's behalf.
          const personalSubjectUserId = req.body.grantKind === "user" ? req.actor.userId ?? null : null;
          const start = await svc.startOAuth(companyId, result.connectionId, {
            redirectUri: oauthRedirectUri(req),
            actor: getActorInfo(req),
            ...(personalSubjectUserId ? { subjectUserId: personalSubjectUserId } : {}),
            ...(req.body.interactionId ? { interactionId: req.body.interactionId } : {}),
          });
          result.auth.startUrl = start.authorizationUrl;
          result.auth.handoff = start.handoff;
          result.auth.issuer = start.issuer ?? result.auth.issuer ?? null;
          result.auth.resource = start.resource ?? result.auth.resource ?? null;
          result.auth.registrationSource = start.registrationSource ?? null;
        } catch (error) {
          // An unknown server whose authorization server supports neither CIMD
          // nor dynamic registration is not a failed connect: the draft
          // connection is real and usable as soon as the operator supplies a
          // client they registered themselves. Report that instead of a 4xx so
          // the wizard can ask for it rather than losing the draft.
          const code = error instanceof HttpError ? String((error.details as { code?: unknown })?.code ?? "") : "";
          if (code !== "oauth_manual_client_required" && code !== "oauth_manual_client_rebinding_required") throw error;
          result.auth.startUrl = null;
          result.auth.manualClientRequired = true;
        }
      }
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_app.connected",
        entityType: "tool_connection",
        entityId: result.connectionId,
        details: {
          galleryKey: req.body.galleryKey ?? null,
          credentialSource: result.connection.credentialSource,
          link: typeof req.body.link === "string" ? redactRemoteUrlCredential(req.body.link) : null,
          applicationId: result.application.id,
          catalogEntryCount: result.catalog.length,
          readOnlyActionCount: result.actions.readOnly.length,
          canMakeChangesActionCount: result.actions.canMakeChanges.length,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.post(
    "/companies/:companyId/tools/connections/:connectionId/start-authorization",
    validate(startConnectionAuthorizationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      activeToolMembership(req, companyId);
      if (!req.actor.userId || req.actor.userId !== req.body.subjectUserId) {
        throw forbidden("Board users may only authorize their own connection subject");
      }
      const existing = await svc.getConnection(req.params.connectionId as string, companyId);
      await assertToolConnectionAccess(req, existing);
      const result = await svc.startOAuth(companyId, existing.id, {
        redirectUri: oauthRedirectUri(req),
        actor: getActorInfo(req),
        subjectUserId: req.body.subjectUserId,
        scopes: req.body.scopes,
        returnTo: req.body.returnTo,
      });
      res.json({ url: result.authorizationUrl, ...(result.handoff ? { handoff: result.handoff } : {}) });
    },
  );

  router.post("/tools/oauth/:connectionId/start", validate(startToolOAuthSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!existing) return;
    const subjectUserId = req.body?.asCurrentUser === true ? req.actor.userId ?? null : null;
    if (req.body?.asCurrentUser === true && !subjectUserId) {
      throw forbidden("Connecting an app as yourself requires a signed-in user");
    }
    if (subjectUserId && existing.credentialPolicy === "per_user") {
      // Personal reconnect is consent owned by the fixed subject, not a manager
      // configuration action. Membership blocks viewers; the service then
      // proves this caller is the connection's retained subject before it can
      // create OAuth state. Shared reconnects keep the stricter configure gate.
      activeToolMembership(req, existing.companyId);
    } else {
      await assertToolConnectionConfigureAccess(req, existing);
    }
    const result = await svc.startOAuth(existing.companyId, existing.id, {
      redirectUri: oauthRedirectUri(req),
      actor: getActorInfo(req),
      returnTo: oauthBrowserOrigin(req) ?? undefined,
      ...(subjectUserId ? { subjectUserId } : {}),
      ...(req.body?.interactionId ? { interactionId: req.body.interactionId } : {}),
    });
    res.json(result);
  });

  router.get("/tools/oauth/cloud-connector/enrollment", async (req, res) => {
    assertBoard(req);
    res.json(await reconcilePaperclipCloudConnectorEnrollmentStatus());
  });

  router.post("/tools/oauth/cloud-connector/enrollment", async (req, res) => {
    assertInstanceAdmin(req);
    const companyId = typeof req.body?.companyId === "string" ? req.body.companyId : "";
    if (!companyId) throw badRequest("Paperclip Cloud enrollment requires a company");
    assertCompanyAccess(req, companyId);
    const origin = new URL(oauthRedirectUri(req)).origin;
    const returnTo = normalizeCloudConnectorEnrollmentReturnTo(
      typeof req.body?.returnTo === "string" ? req.body.returnTo : undefined,
    ) ?? undefined;
    let status;
    try {
      status = await startPaperclipCloudConnectorEnrollment({
        origin,
        companyId,
        initiatedBy: connectorEnrollmentPrincipal(req),
        label: typeof req.body?.label === "string" ? req.body.label : undefined,
        returnTo,
      });
    } catch {
      throw unprocessable("Paperclip Cloud enrollment could not be started", {
        code: "paperclip_cloud_connector_enrollment_failed",
      });
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "paperclip_cloud_connector.enrollment_started",
      entityType: "connector_instance",
      entityId: status.instanceId ?? "pending",
      details: { environment: status.environment, status: status.status },
    });
    res.status(201).json(status);
  });

  router.get("/tools/oauth/cloud-connector/enrollment-callback", async (req, res) => {
    assertInstanceAdmin(req);
    const enrollmentId = typeof req.query.enrollment_id === "string" ? req.query.enrollment_id : "";
    const approvalCode = typeof req.query.approval_code === "string" ? req.query.approval_code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!enrollmentId || !approvalCode || !state) throw badRequest("Invalid Paperclip Cloud enrollment callback");
    const pending = loadPaperclipCloudConnectorIdentity()?.pending;
    if (pending?.companyId && !hasCompanyAccess(req, pending.companyId)) {
      throw notFound("Paperclip Cloud enrollment not found");
    }
    if (pending?.initiatedBy && pending.initiatedBy !== connectorEnrollmentPrincipal(req)) {
      throw notFound("Paperclip Cloud enrollment not found");
    }
    const [company] = pending?.companyId
      ? await db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, pending.companyId))
        .limit(1)
      : [];
    if (!company) throw notFound("Paperclip Cloud enrollment not found");
    let status;
    try {
      status = await completePaperclipCloudConnectorEnrollment({ enrollmentId, approvalCode, state });
    } catch {
      throw badRequest("Invalid or expired Paperclip Cloud enrollment callback");
    }
    if (pending?.companyId) {
      await logActivity(db, {
        companyId: pending.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "paperclip_cloud_connector.enrollment_completed",
        entityType: "connector_instance",
        entityId: status.instanceId ?? enrollmentId,
        details: { environment: status.environment, status: status.status },
      });
    }
    res.redirect(303, cloudConnectorEnrollmentReturnPath(company.issuePrefix, pending?.returnTo));
  });

  const handlePaperclipCloudConnectorCallback = async (req: Request, res: Response) => {
    assertBoard(req);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const claimId = typeof req.query.claim_id === "string" ? req.query.claim_id : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const pendingState = state ? await svc.peekOAuthState(state) : null;
    if (!pendingState || !hasCompanyAccess(req, pendingState.companyId)) {
      throw badRequest("Invalid or expired OAuth state");
    }
    const pendingConnection = await svc.getConnection(pendingState.connectionId, pendingState.companyId);
    const pendingConnectionIntent = await isConnectionIntent(pendingState.interactionId);
    if (pendingState.subjectUserId && pendingState.subjectUserId === req.actor.userId) {
      await assertToolConnectionAccess(req, pendingConnection);
    } else {
      await assertToolConnectionConfigureAccess(req, pendingConnection);
    }
    const acceptsHtml = req.get("accept")?.includes("text/html") === true;
    try {
      const result = await svc.completePaperclipCloudConnectorCallback({
        state,
        claimId,
        error,
        actor: getActorInfo(req),
      });
      const pendingConfig = pendingConnection.config ?? {};
      const oauthConfig = pendingConfig.oauth && typeof pendingConfig.oauth === "object"
        ? pendingConfig.oauth as Record<string, unknown>
        : null;
      const connectorProfileValue = typeof oauthConfig?.connectorProfile === "string"
        ? oauthConfig.connectorProfile
        : null;
      const connectorProfile = connectorProfileValue && isGoogleWorkspaceConnectorProfileId(connectorProfileValue)
        ? connectorProfileValue
        : null;
      const connectorDefinition = connectorProfile
        ? GOOGLE_WORKSPACE_CONNECTOR_PROFILES[connectorProfile]
        : null;
      await logActivity(db, {
        companyId: result.connection.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_app.oauth_connected",
        entityType: "tool_connection",
        entityId: result.connection.id,
        details: {
          applicationId: result.application.id,
          catalogEntryCount: result.catalog.length,
          provider: connectorDefinition?.appSlug ?? "google",
          ...(connectorDefinition ? { profile: connectorProfile } : {}),
        },
      });
      if (acceptsHtml && pendingConnectionIntent && pendingState.interactionId && req.actor.userId) {
        await finishConnectionIntentOAuth({
          interactionId: pendingState.interactionId,
          connectionId: result.connection.id,
          userId: req.actor.userId,
          outcome: "connected",
          canManageOrganizationGrant: await isToolConnectionManager(req, pendingConnection.companyId),
          bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
        });
        sendConnectionIntentOAuthOutcome(res, {
          interactionId: pendingState.interactionId,
          issueId: pendingState.issueId,
          outcome: "connected",
          openerOrigin: pendingState.returnTo,
        });
        return;
      }
      if (acceptsHtml) {
        const permissionsPath = await oauthAppPath(result.connection.companyId, result.connection.id);
        res.redirect(303, `${permissionsPath}?success=1`);
        return;
      }
      res.json(result);
    } catch (callbackError) {
      if (!acceptsHtml) throw callbackError;
      const details = callbackError instanceof HttpError && callbackError.details && typeof callbackError.details === "object"
        ? callbackError.details as Record<string, unknown>
        : null;
      if (pendingConnectionIntent && pendingState.interactionId && req.actor.userId) {
        const outcome = details?.code === "oauth_authorization_denied" ? "declined" : "failed";
        await finishConnectionIntentOAuth({
          interactionId: pendingState.interactionId,
          userId: req.actor.userId,
          outcome,
          canManageOrganizationGrant: await isToolConnectionManager(req, pendingConnection.companyId),
          bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
        });
        sendConnectionIntentOAuthOutcome(res, {
          interactionId: pendingState.interactionId,
          issueId: pendingState.issueId,
          outcome,
          openerOrigin: pendingState.returnTo,
        });
        return;
      }
      const outcome = details?.code === "oauth_authorization_denied" ? "denied" : "failed";
      res.redirect(303, await oauthRecoveryPath(
        pendingConnection,
        outcome,
        typeof details?.code === "string" ? details.code : null,
      ));
    }
  };
  router.get("/tools/oauth/cloud-connector/callback", handlePaperclipCloudConnectorCallback);
  router.get("/tools/oauth/paperclip-id/callback", handlePaperclipCloudConnectorCallback);

  router.get("/tools/vercel-connect/callback", async (req, res) => {
    assertBoard(req);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const pendingState = state ? await svc.peekOAuthState(state) : null;
    if (!pendingState || !hasCompanyAccess(req, pendingState.companyId)) {
      throw badRequest("Invalid or expired Vercel Connect state");
    }
    const pendingConnection = await svc.getConnection(pendingState.connectionId, pendingState.companyId);
    const pendingConnectionIntent = await isConnectionIntent(pendingState.interactionId);
    if (pendingState.subjectUserId && pendingState.subjectUserId === req.actor.userId) {
      await assertToolConnectionAccess(req, pendingConnection);
    } else {
      await assertToolConnectionConfigureAccess(req, pendingConnection);
    }
    const acceptsHtml = req.get("accept")?.includes("text/html") === true;
    try {
      const result = await svc.completeVercelConnectCallback({
        state,
        error,
        actor: getActorInfo(req),
      });
      await logActivity(db, {
        companyId: result.connection.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_app.oauth_connected",
        entityType: "tool_connection",
        entityId: result.connection.id,
        details: {
          applicationId: result.application.id,
          catalogEntryCount: result.catalog.length,
          provider: "vercel_connect",
        },
      });
      if (acceptsHtml && pendingConnectionIntent && pendingState.interactionId && req.actor.userId) {
        await finishConnectionIntentOAuth({
          interactionId: pendingState.interactionId,
          connectionId: result.connection.id,
          userId: req.actor.userId,
          outcome: "connected",
          canManageOrganizationGrant: await isToolConnectionManager(req, pendingConnection.companyId),
          bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
        });
        sendConnectionIntentOAuthOutcome(res, {
          interactionId: pendingState.interactionId,
          issueId: pendingState.issueId,
          outcome: "connected",
          openerOrigin: pendingState.returnTo,
        });
        return;
      }
      if (acceptsHtml) {
        const permissionsPath = await oauthAppPath(result.connection.companyId, result.connection.id);
        res.redirect(303, `${permissionsPath}?success=1`);
        return;
      }
      res.json(result);
    } catch (callbackError) {
      if (!acceptsHtml) throw callbackError;
      const details = callbackError instanceof HttpError && callbackError.details && typeof callbackError.details === "object"
        ? callbackError.details as Record<string, unknown>
        : null;
      const callbackCode = typeof details?.code === "string" ? details.code : "vercel_connect_callback_failed";
      await logActivity(db, {
        companyId: pendingState.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_app.oauth_failed",
        entityType: "tool_connection",
        entityId: pendingState.connectionId,
        details: { code: callbackCode, provider: "vercel_connect" },
      });
      if (pendingConnectionIntent && pendingState.interactionId && req.actor.userId) {
        const outcome = callbackCode === "oauth_authorization_denied" ? "declined" : "failed";
        await finishConnectionIntentOAuth({
          interactionId: pendingState.interactionId,
          userId: req.actor.userId,
          outcome,
          canManageOrganizationGrant: await isToolConnectionManager(req, pendingConnection.companyId),
          bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
        });
        sendConnectionIntentOAuthOutcome(res, {
          interactionId: pendingState.interactionId,
          issueId: pendingState.issueId,
          outcome,
          openerOrigin: pendingState.returnTo,
        });
        return;
      }
      res.redirect(303, await oauthRecoveryPath(pendingConnection, "failed", callbackCode));
    }
  });

  router.get("/tools/oauth/callback", async (req, res) => {
    assertBoard(req);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    // `error_description` / `error_uri` are read from neither the query nor the
    // provider's body: they are provider-authored prose, and Paperclip maps the
    // `error` code to its own copy instead of reflecting them (PAP-17108).
    const iss = typeof req.query.iss === "string" ? req.query.iss : null;
    const pendingState = state ? await svc.peekOAuthState(state) : null;
    if (!pendingState || !hasCompanyAccess(req, pendingState.companyId)) {
      throw badRequest("Invalid or expired OAuth state");
    }
    const pendingConnection = await svc.getConnection(pendingState.connectionId, pendingState.companyId);
    const pendingConnectionIntent = await isConnectionIntent(pendingState.interactionId);
    if (!pendingState.subjectUserId) {
      if (!await isToolConnectionManagerQuiet(req, pendingConnection.companyId)) {
        throw forbidden(ORGANIZATION_GRANT_DENIAL_REASON);
      }
    } else if (pendingState.subjectUserId === req.actor.userId) {
      await assertToolConnectionAccess(req, pendingConnection);
    } else {
      await assertToolConnectionConfigureAccess(req, pendingConnection);
    }
    const acceptsHtml = req.get("accept")?.includes("text/html") === true;
    let result: Awaited<ReturnType<typeof svc.completeOAuthCallback>>;
    try {
      result = await svc.completeOAuthCallback({
        state,
        code,
        error,
        iss,
        // A provider denial is bound and consumed by state alone. Avoid
        // requiring this deployment's callback origin just to record that the
        // user declined; successful code exchange still validates the origin.
        redirectUri: error ? "" : oauthRedirectUri(req),
        actor: getActorInfo(req),
      });
    } catch (callbackError) {
      if (!acceptsHtml) throw callbackError;
      const details = callbackError instanceof HttpError
        && callbackError.details
        && typeof callbackError.details === "object"
        && !Array.isArray(callbackError.details)
        ? callbackError.details as Record<string, unknown>
        : null;
      const callbackErrorCode = typeof details?.code === "string" ? details.code : null;
      const callbackFailureCode = callbackErrorCode
        ?? (callbackError instanceof HttpError ? `oauth_callback_http_${callbackError.status}` : "oauth_callback_failed");
      await logActivity(db, {
        companyId: pendingState.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_app.oauth_failed",
        entityType: "tool_connection",
        entityId: pendingState.connectionId,
        details: {
          code: callbackFailureCode,
          status: callbackError instanceof HttpError ? callbackError.status : 500,
          // HttpError messages are Paperclip-authored. Provider-authored
          // error_description/error_uri values are never read above and cannot
          // be reflected into the activity stream.
          message: callbackError instanceof HttpError
            ? callbackError.message
            : "OAuth callback failed unexpectedly.",
        },
      });
      if (pendingConnectionIntent && pendingState.interactionId && req.actor.userId) {
        const outcome = callbackErrorCode === "oauth_authorization_denied" ? "declined" : "failed";
        await finishConnectionIntentOAuth({
          interactionId: pendingState.interactionId,
          userId: req.actor.userId,
          outcome,
          canManageOrganizationGrant: await isToolConnectionManager(req, pendingConnection.companyId),
          bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
        });
        sendConnectionIntentOAuthOutcome(res, {
          interactionId: pendingState.interactionId,
          issueId: pendingState.issueId,
          outcome,
          openerOrigin: pendingState.returnTo,
        });
        return;
      }
      res.redirect(303, await oauthRecoveryPath(
        pendingConnection,
        callbackErrorCode === "oauth_authorization_denied" ? "denied" : "failed",
        callbackFailureCode,
      ));
      return;
    }
    await logActivity(db, {
      companyId: result.connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_app.oauth_connected",
      entityType: "tool_connection",
      entityId: result.connection.id,
      details: {
        applicationId: result.application.id,
        catalogEntryCount: result.catalog.length,
      },
    });
    if (acceptsHtml && pendingConnectionIntent && pendingState.interactionId && req.actor.userId) {
      await finishConnectionIntentOAuth({
        interactionId: pendingState.interactionId,
        connectionId: result.connection.id,
        userId: req.actor.userId,
        outcome: "connected",
        canManageOrganizationGrant: await isToolConnectionManager(req, pendingConnection.companyId),
        bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
      });
      sendConnectionIntentOAuthOutcome(res, {
        interactionId: pendingState.interactionId,
        issueId: pendingState.issueId,
        outcome: "connected",
        openerOrigin: pendingState.returnTo,
      });
      return;
    }
    if (acceptsHtml) {
      const permissionsPath = await oauthAppPath(result.connection.companyId, result.connection.id);
      res.redirect(303, `${permissionsPath}?success=1`);
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/tools/apps/:connectionId/finalize-oauth-access",
    validate(finalizeOAuthAccessSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const existing = await svc.getConnection(req.params.connectionId as string, companyId);
      await assertToolConnectionConfigureAccess(req, existing);
      const result = await svc.finalizeOAuthAccess(companyId, existing.id, req.body, getActorInfo(req));
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_app.oauth_access_finalized",
        entityType: "tool_connection",
        entityId: result.connection.id,
        details: {
          grantKind: req.body.grantKind,
          profileId: result.profile.id,
          profileEntryCount: result.profileEntries.length,
        },
      });
      res.json(result);
    },
  );

  router.post("/companies/:companyId/tools/apps/:connectionId/finish", validate(finishToolAppSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const existing = await svc.getConnection(req.params.connectionId as string, companyId);
    await assertToolConnectionConfigureAccess(req, existing);
    const result = await svc.finishGalleryAppConnection(companyId, existing.id, req.body, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_app.finished",
      entityType: "tool_connection",
      entityId: result.connection.id,
      details: {
        profileId: result.profile.id,
        profileEntryCount: result.profileEntries.length,
        profileBindingCount: result.profileBindings.length,
        askFirstPolicyCount: result.policies.length,
        reviewedCatalogEntryCount: req.body.reviewedCatalogEntryIds?.length ?? 0,
        access: req.body.access,
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/tools/examples", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ examples: await svc.listExamples(companyId) });
  });

  router.get("/companies/:companyId/tools/apps/attention", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listAppsNeedingAttention(companyId));
  });

  router.get("/companies/:companyId/tools/action-requests", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const statusRaw = typeof req.query.status === "string" ? req.query.status : "pending";
    const status = (TOOL_ACTION_REQUEST_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as (typeof TOOL_ACTION_REQUEST_STATUSES)[number])
      : "pending";
    res.json({ actionRequests: await svc.listActionRequests(companyId, status) });
  });

  router.post("/companies/:companyId/tools/examples/:id/install", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    const result = await svc.installExample(companyId, req.params.id as string, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_example.installed",
      entityType: "tool_example",
      entityId: result.example.id,
      details: {
        created: result.created,
        applicationId: result.application.id,
        connectionId: result.connection.id,
        profileId: result.profile.id,
        profileEntryCount: result.profileEntries.length,
      },
    });
    res.status(result.created ? 201 : 200).json(result);
  });

  router.post("/companies/:companyId/tools/examples/:id/smoke", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.smokeExample(companyId, req.params.id as string, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_example.smoke_run",
      entityType: "tool_example",
      entityId: result.exampleId,
      details: {
        ok: result.ok,
        actor: result.actor,
        connectionId: result.connection.id,
        profileId: result.profile.id,
        checks: result.checks.map((check) => ({
          name: check.name,
          ok: check.ok,
          toolName: check.toolName ?? null,
          decision: check.decision ?? null,
          reasonCode: check.reasonCode ?? null,
        })),
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/tools/applications", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ applications: await svc.listApplications(companyId) });
  });

  router.post("/companies/:companyId/tools/applications", validate(createToolApplicationSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    try {
      const application = await svc.createApplication(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_application.created",
        entityType: "tool_application",
        entityId: application.id,
        details: { type: application.type, name: application.name },
      });
      res.status(201).json(application);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.patch("/tool-applications/:applicationId", validate(updateToolApplicationSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getApplication(req.params.applicationId as string), "Tool application not found");
    if (!existing) return;
    assertToolAppMutationAccess(req, existing.companyId);
    try {
      const application = await svc.updateApplication(existing.id, req.body);
      await logActivity(db, {
        companyId: application.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_application.updated",
        entityType: "tool_application",
        entityId: application.id,
        details: { status: application.status, name: application.name },
      });
      res.json(application);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.delete("/tool-applications/:applicationId", async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getApplication(req.params.applicationId as string), "Tool application not found");
    if (!existing) return;
    assertToolAppMutationAccess(req, existing.companyId);
    const application = await svc.deleteApplication(existing.id);
    await logActivity(db, {
      companyId: application.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_application.deleted",
      entityType: "tool_application",
      entityId: application.id,
      details: { type: application.type, name: application.name },
    });
    res.json(application);
  });

  router.get("/companies/:companyId/tools/connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const connections = await svc.listConnections(companyId);
    const canManageConnections = await isToolConnectionManagerQuiet(req, companyId);
    res.json({
      connections: filterVisibleToolConnections(connections, {
        userId: req.actor.userId,
        canManageConnections,
      }),
    });
  });

  router.post("/companies/:companyId/tools/connections", validate(createToolConnectionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    try {
      const connection = await svc.createConnection(companyId, req.body, getActorInfo(req));
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_connection.created",
        entityType: "tool_connection",
        entityId: connection.id,
        details: {
          transport: connection.transport,
          status: connection.status,
          enabled: connection.enabled,
          credentialRefCount: (connection.credentialRefs ?? []).length + connection.credentialSecretRefs.length,
        },
      });
      res.status(201).json(connection);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.get("/tool-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(
      req,
      res,
      svc.getConnection(req.params.connectionId as string),
      "Tool connection not found",
    );
    if (!connection) return;
    res.json(connection);
  });

  router.get("/tool-connections/:connectionId/services", async (req, res) => {
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    await assertToolConnectionConfigureAccess(req, connection);
    res.json(await svc.listComposioServices(connection.id, getActorInfo(req)));
  });

  router.post("/tool-connections/:connectionId/services/:toolkitSlug/connect", async (req, res) => {
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    await assertToolConnectionConfigureAccess(req, connection);
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const result = await svc.startComposioServiceConnect(connection.id, req.params.toolkitSlug as string, {
      ...(typeof body.authConfigId === "string" ? { authConfigId: body.authConfigId } : {}),
      ...(typeof body.callbackUrl === "string" ? { callbackUrl: body.callbackUrl } : {}),
    });
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "composio.service_connect_started",
      entityType: "tool_connection",
      entityId: connection.id,
      details: { toolkitSlug: req.params.toolkitSlug, authConfigId: result.authConfigId },
    });
    res.status(201).json(result);
  });

  router.get("/tool-connections/:connectionId/services/:toolkitSlug/status", async (req, res) => {
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    await assertToolConnectionConfigureAccess(req, connection);
    res.json(await svc.pollComposioService(connection.id, req.params.toolkitSlug as string, getActorInfo(req)));
  });

  router.delete("/tool-connections/:connectionId/services/:toolkitSlug", async (req, res) => {
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    await assertToolConnectionConfigureAccess(req, connection);
    const result = await svc.disconnectComposioService(connection.id, req.params.toolkitSlug as string, getActorInfo(req));
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "composio.service_disconnected",
      entityType: "tool_connection",
      entityId: connection.id,
      details: { toolkitSlug: req.params.toolkitSlug, removedChildCount: result.removedChildIds.length },
    });
    res.json(result);
  });

  router.get("/tool-connections/:connectionId/grants", async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    const listed = await svc.listConnectionGrants(connection.id, connection.companyId);
    const capabilities = await describeConnectionCapabilities(req, connection);
    const membership = toolMembershipRole(req, connection.companyId);
    const grantContext = {
      userId: req.actor.userId ?? null,
      isManager: await isToolConnectionManagerQuiet(req, connection.companyId),
      mutationCapable: membership.unrestricted || (membership.isActive && !membership.isViewer),
    };
    // A regular member has no reason to browse coworkers' personal identities;
    // the manager kill switch does. Filtering here rather than in the UI keeps
    // the list itself — not just its controls — under server policy.
    const visibleGrants = listed.grants.filter((grant) =>
      grant.kind === "organization"
      || capabilities.canViewOtherPersonalIdentities
      || (grantContext.userId !== null && grant.subjectUserId === grantContext.userId));
    res.json({
      ...listed,
      grants: visibleGrants.map((grant) => ({
        ...grant,
        capabilities: describeGrantCapabilities(grant, grantContext),
      })),
      capabilities,
      currentUserId: grantContext.userId,
      members: capabilities.canConfigure
        ? await svc.listConnectionAudienceMembers(connection.companyId)
        : [],
    });
  });

  router.put(
    "/tool-connections/:connectionId/grants/:grantId/members",
    validate(replaceConnectionGrantMembersSchema),
    async (req, res) => {
      assertBoard(req);
      const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
      if (!connection) return;
      // Viewer/inactive principals are rejected before anything else, so a
      // read-only member can never reach the audience writer.
      activeToolMembership(req, connection.companyId);
      const { grants } = await svc.listConnectionGrants(connection.id, connection.companyId);
      const target = grants.find((grant) => grant.id === req.params.grantId);
      if (!target) throw notFound("Connection grant not found");
      const isGrantCreator = Boolean(req.actor.userId && target.createdByUserId === req.actor.userId);
      if (!isGrantCreator) await assertToolConnectionConfigureAccess(req, connection);
      const memberUserIds = req.body.memberUserIds as string[];
      const grant = await svc.replaceConnectionGrantMembers(
        connection.id,
        target.id,
        memberUserIds,
        getActorInfo(req),
      );
      await logActivity(db, {
        companyId: connection.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_connection.grant_audience_replaced",
        entityType: "connection_grant",
        entityId: grant.id,
        details: { connectionId: connection.id, memberCount: memberUserIds.length },
      });
      res.json(grant);
    },
  );

  router.post("/tool-connections/:connectionId/grants/installations", async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    await assertToolConnectionConfigureAccess(req, connection);
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const credentialSecretRefs = Array.isArray(body.credentialSecretRefs) ? body.credentialSecretRefs : [];
    const providerTenant = body.providerTenant && typeof body.providerTenant === "object"
      ? body.providerTenant as { name?: string; externalId?: string }
      : undefined;
    const grant = await svc.addConnectionInstallation(connection.id, {
      providerTenant,
      credentialSecretRefs,
      isDefault: body.isDefault === true,
    }, getActorInfo(req));
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.grant_added",
      entityType: "connection_grant",
      entityId: grant.id,
      details: { connectionId: connection.id, kind: grant.kind },
    });
    res.status(201).json(grant);
  });

  router.delete("/tool-connections/:connectionId/grants/:grantId", async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    const { grants } = await svc.listConnectionGrants(connection.id, connection.companyId);
    const grantToRevoke = grants.find((grant) => grant.id === req.params.grantId);
    const canRevokeOwnGrant = Boolean(
      req.actor.userId
      && grantToRevoke
      && (grantToRevoke.subjectUserId === req.actor.userId || grantToRevoke.createdByUserId === req.actor.userId),
    );
    if (!canRevokeOwnGrant) await assertToolConnectionConfigureAccess(req, connection);
    const grant = await svc.revokeConnectionGrant(connection.id, req.params.grantId as string, getActorInfo(req));
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.grant_revoked",
      entityType: "connection_grant",
      entityId: grant.id,
      details: { connectionId: connection.id, kind: grant.kind },
    });
    res.json(grant);
  });

  router.post("/tool-connections/:connectionId/grants/:grantId/delegations", validate(createConnectionGrantDelegationSchema), async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    const ownerUserId = req.actor.userId;
    if (!ownerUserId) throw forbidden("A named user is required to delegate a personal grant");
    const agentId = req.body.agentId;
    const delegation = await svc.createConnectionGrantDelegation(
      connection.id,
      req.params.grantId as string,
      agentId,
      ownerUserId,
    );
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: ownerUserId,
      action: "tool_connection.grant_delegated",
      entityType: "connection_grant",
      entityId: req.params.grantId as string,
      details: { connectionId: connection.id, delegationId: delegation.id, agentId },
    });
    res.status(201).json(delegation);
  });

  router.delete("/tool-connections/:connectionId/grants/:grantId/delegations/:delegationId", async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    const { grants } = await svc.listConnectionGrants(connection.id, connection.companyId);
    const grant = grants.find((candidate) => candidate.id === req.params.grantId);
    if (!grant) throw notFound("Connection grant not found");
    const canRevokeOwnDelegation = Boolean(req.actor.userId && grant.subjectUserId === req.actor.userId);
    if (!canRevokeOwnDelegation && !await isToolConnectionManager(req, connection.companyId)) {
      throw forbidden("Only the personal grant owner or a connection manager can revoke a delegation");
    }
    const delegation = await svc.revokeConnectionGrantDelegation(
      connection.id,
      grant.id,
      req.params.delegationId as string,
      getActorInfo(req),
    );
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.grant_delegation_revoked",
      entityType: "connection_grant",
      entityId: grant.id,
      details: { connectionId: connection.id, delegationId: delegation.id, agentId: delegation.agentId },
    });
    res.json(delegation);
  });

  router.get("/tool-connections/:connectionId/usage", async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    const range = req.query.range === "30d" ? "30d" : req.query.range === undefined || req.query.range === "7d" ? "7d" : null;
    if (!range) throw badRequest("Usage range must be 7d or 30d");
    res.json(await svc.getConnectionUsage(connection.id, range, connection.companyId));
  });

  router.get("/tool-connections/:connectionId/installs", async (req, res) => {
    assertBoard(req);
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    res.json({ connectionId: connection.id, installs: connection.installs ?? [] });
  });

  router.put(
    "/tool-connections/:connectionId/installs",
    validate(putToolConnectionInstallsSchema),
    async (req, res) => {
      assertBoard(req);
      const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
      if (!connection) return;
      const existingInstalls = await db
        .select()
        .from(toolConnectionInstalls)
        .where(and(
          eq(toolConnectionInstalls.companyId, connection.companyId),
          eq(toolConnectionInstalls.connectionId, connection.id),
        ));
      const requestedInstalls = req.body.installs as Array<{ targetType: "company" | "agent"; targetId: string }>;
      const requestedKeys = new Set(requestedInstalls.map((install) => `${install.targetType}:${install.targetId}`));
      const existingKeys = new Set(existingInstalls.map((install) => `${install.targetType}:${install.targetId}`));
      const changedInstalls = [
        ...requestedInstalls.filter((install) => !existingKeys.has(`${install.targetType}:${install.targetId}`)),
        ...existingInstalls.filter((install) => !requestedKeys.has(`${install.targetType}:${install.targetId}`)),
      ];
      if (changedInstalls.some((install) => install.targetType === "company")) {
        await assertToolConnectionConfigureAccess(req, connection);
      }
      if (changedInstalls.some((install) => install.targetType === "agent")) {
        await assertToolConnectionAccess(req, connection);
        const changedAgentIds = [...new Set(
          changedInstalls
            .filter((install) => install.targetType === "agent")
            .map((install) => install.targetId),
        )];
        for (const agentId of changedAgentIds) {
          const [agent] = await db
            .select({ id: agents.id, companyId: agents.companyId })
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.companyId, connection.companyId)))
            .limit(1);
          if (!agent) throw forbidden("The target agent is not available in this company");
          const decision = await access.decide({
            actor: req.actor,
            action: "agent_config:update",
            resource: { type: "agent", companyId: connection.companyId, agentId: agent.id },
          });
          if (!decision.allowed) {
            throw forbidden(`You cannot edit agent ${agent.id}, so you cannot change its connection installs`);
          }
        }
      }
      const snapshot = await svc.putConnectionInstalls(connection.id, req.body, getActorInfo(req));
      await logActivity(db, {
        companyId: connection.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_connection.installs_synced",
        entityType: "tool_connection",
        entityId: connection.id,
        details: {
          installs: snapshot.installs.map((install) => ({ targetType: install.targetType, targetId: install.targetId })),
        },
      });
      res.json(snapshot);
    },
  );

  router.get("/tool-connections/:connectionId/test-agents", async (req, res) => {
    assertBoard(req);
    if (!options.toolGateway) {
      res.status(501).json({ error: "Tool gateway service is not configured" });
      return;
    }
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    await assertBoardAnyToolPermission(req, connection.companyId, ["tools:use", "tools:manage_connections"]);
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(eq(agents.companyId, connection.companyId));
    const orgDepthByAgentId = agentOrgDepths(rows);
    const candidates = [];
    for (const agent of rows) {
      try {
        await assertCanTestAsAgent(req, connection.companyId, agent.id);
      } catch {
        continue;
      }
      candidates.push({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        title: agent.title,
        status: agent.status,
        orgDepth: orgDepthByAgentId.get(agent.id) ?? 0,
      });
    }
    candidates.sort((a, b) => a.orgDepth - b.orgDepth || a.name.localeCompare(b.name));
    res.json({ agents: candidates });
  });

  router.get("/tool-connections/:connectionId/test-agents/:agentId/access", async (req, res) => {
    assertBoard(req);
    if (!options.toolGateway) {
      res.status(501).json({ error: "Tool gateway service is not configured" });
      return;
    }
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    await assertBoardAnyToolPermission(req, connection.companyId, ["tools:use", "tools:manage_connections"]);
    const agentId = req.params.agentId as string;
    await assertCanTestAsAgent(req, connection.companyId, agentId);
    const accessSummary = await options.toolGateway.summarizeConnectionAccessForAgent({
      companyId: connection.companyId,
      connectionId: connection.id,
      agentId,
    });
    res.json({ access: accessSummary });
  });

  router.post("/tool-connections/:connectionId/test-calls", validate(toolConnectionTestCallSchema), async (req, res) => {
    assertBoard(req);
    if (!options.toolGateway) {
      res.status(501).json({ error: "Tool gateway service is not configured" });
      return;
    }
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    await assertBoardAnyToolPermission(req, connection.companyId, ["tools:use", "tools:manage_connections"]);
    await assertCanTestAsAgent(req, connection.companyId, req.body.agentId);
    try {
      const result = await options.toolGateway.executeTestCall({
        companyId: connection.companyId,
        connectionId: connection.id,
        agentId: req.body.agentId,
        userId: req.actor.userId ?? "board",
        toolName: req.body.toolName,
        parameters: req.body.parameters ?? {},
      });
      res.json(result);
    } catch (error) {
      if (!sendToolGatewayError(res, error)) throw error;
    }
  });

  router.get("/tool-connections/:connectionId/test-calls/:actionRequestId", async (req, res) => {
    assertBoard(req);
    if (!options.toolGateway) {
      res.status(501).json({ error: "Tool gateway service is not configured" });
      return;
    }
    const connection = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!connection) return;
    await assertBoardAnyToolPermission(req, connection.companyId, ["tools:use", "tools:manage_connections"]);
    try {
      const status = await options.toolGateway.getTestCallStatus({
        companyId: connection.companyId,
        connectionId: connection.id,
        actionRequestId: req.params.actionRequestId as string,
      });
      res.json(status);
    } catch (error) {
      if (!sendToolGatewayError(res, error)) throw error;
    }
  });

  router.patch("/tool-connections/:connectionId", validate(updateToolConnectionSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!existing) return;
    await assertToolConnectionConfigureAccess(req, existing);
    const connection = await svc.updateConnection(existing.id, req.body);
    const lifecycleChanges = classifyConnectionUpdate(
      { enabled: existing.enabled, config: existing.config },
      { enabled: connection.enabled, config: connection.config },
    );
    const baseLog = {
      companyId: connection.companyId,
      actorType: "user" as const,
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.updated",
      entityType: "tool_connection",
      entityId: connection.id,
    };
    if (lifecycleChanges.length === 0) {
      await logActivity(db, {
        ...baseLog,
        details: {
          status: connection.status,
          enabled: connection.enabled,
          credentialRefCount: (connection.credentialRefs ?? []).length + connection.credentialSecretRefs.length,
        },
      });
    } else {
      // One activity row per lifecycle change so the Activity tab renders one
      // humanized row each (PAP-11284), e.g. a combined pause + allowlist edit.
      for (const change of lifecycleChanges) {
        await logActivity(db, {
          ...baseLog,
          details: {
            status: connection.status,
            enabled: connection.enabled,
            lifecycle: change.lifecycle,
            ...change.details,
          },
        });
      }
    }
    res.json(connection);
  });

  router.delete("/tool-connections/:connectionId", async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!existing) return;
    await assertToolConnectionConfigureAccess(req, existing);
    const applicationBefore = await svc.getApplication(existing.applicationId);
    const { connection, removal } = await svc.archiveConnection(
      existing.id,
      existing.companyId,
      getActorInfo(req),
      { confirmComposioChildren: req.query.confirmComposioChildren === "true" },
    );
    const applicationAfter = await svc.getApplication(existing.applicationId);
    // The receipt is counts and outcomes only. Removal is a revocation boundary
    // (PAP-17119) and operators need to see what it tore down, but this row is
    // company-readable activity, so it never carries a secret name or value.
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.archived",
      entityType: "tool_connection",
      entityId: connection.id,
      details: { transport: connection.transport, ...removal },
    });
    if (applicationBefore.status !== "archived" && applicationAfter.status === "archived") {
      await logActivity(db, {
        companyId: applicationAfter.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_application.archived",
        entityType: "tool_application",
        entityId: applicationAfter.id,
        details: { type: applicationAfter.type, name: applicationAfter.name, reason: "last_connection_removed" },
      });
    }
    res.json({ ...connection, removal });
  });

  router.post("/tool-connections/:connectionId/health-check", async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!existing) return;
    await assertToolConnectionConfigureAccess(req, existing);
    res.json(await svc.checkHealth(existing.id, getActorInfo(req)));
  });

  router.post(
    "/tool-connections/:connectionId/reconnect",
    validate(reconnectToolAppSchema),
    async (req, res) => {
      const existing = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
      if (!existing) return;
      await assertToolConnectionConfigureAccess(req, existing);
      const result = await svc.reconnectGalleryApp(
        existing.id,
        existing.companyId,
        req.body,
        getActorInfo(req),
      );
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_app.reconnected",
        entityType: "tool_connection",
        entityId: existing.id,
        details: { healthStatus: result.connection.healthStatus },
      });
      res.json(result);
    },
  );

  router.post("/tool-connections/:connectionId/catalog/refresh", async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!existing) return;
    await assertToolConnectionConfigureAccess(req, existing);
    const result = await svc.refreshCatalog(existing.id, getActorInfo(req));
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.catalog_refresh",
      entityType: "tool_connection",
      entityId: existing.id,
      details: {
        discoveredCount: result.discoveredCount,
        quarantinedCount: result.quarantinedCount,
      },
    });
    res.json(result);
  });

  router.get("/tool-connections/:connectionId/catalog", async (req, res) => {
    assertBoard(req);
    const existing = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!existing) return;
    res.json({ catalog: await svc.listCatalog(existing.id, existing.companyId) });
  });

  router.get("/tool-connections/:connectionId/activity", async (req, res) => {
    assertBoard(req);
    const existing = await getAccessibleResource(req, res, svc.getConnection(req.params.connectionId as string), "Tool connection not found");
    if (!existing) return;
    const limitRaw = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
    res.json(await svc.listConnectionActivity(existing.id, existing.companyId, limit));
  });

  router.get("/companies/:companyId/tools/profiles", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ profiles: await svc.listProfiles(companyId) });
  });

  router.get("/tool-profiles/:profileId/new-tools", async (req, res) => {
    assertBoard(req);
    const existing = await getAccessibleResource(req, res, svc.getProfile(req.params.profileId as string), "Tool profile not found");
    if (!existing) return;
    res.json(await svc.listProfileNewTools(existing.id, existing.companyId));
  });

  router.post("/companies/:companyId/tools/profiles", validate(createToolProfileWithEntriesSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    try {
      const profile = await svc.createProfile(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile.created",
        entityType: "tool_profile",
        entityId: profile.id,
        details: { name: profile.name, entryCount: profile.entries.length },
      });
      res.status(201).json(profile);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.get("/companies/:companyId/tools/profiles/effective/agents/:agentId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getEffectiveProfilesForAgent(companyId, req.params.agentId as string));
  });

  router.patch("/tool-profiles/:profileId", validate(updateToolProfileWithEntriesSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getProfile(req.params.profileId as string), "Tool profile not found");
    if (!existing) return;
    assertToolAppMutationAccess(req, existing.companyId);
    try {
      const profile = await svc.updateProfile(existing.id, req.body);
      await logActivity(db, {
        companyId: profile.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile.updated",
        entityType: "tool_profile",
        entityId: profile.id,
        details: { status: profile.status, entryCount: profile.entries.length },
      });
      res.json(profile);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.post("/tool-profiles/:profileId/duplicate", validate(duplicateToolProfileSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getProfile(req.params.profileId as string), "Tool profile not found");
    if (!existing) return;
    assertToolAppMutationAccess(req, existing.companyId);
    try {
      const profile = await svc.duplicateProfile(existing.id, req.body);
      await logActivity(db, {
        companyId: profile.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile.duplicated",
        entityType: "tool_profile",
        entityId: profile.id,
        details: {
          sourceProfileId: existing.id,
          name: profile.name,
          entryCount: profile.entries.length,
          assignmentCount: profile.summary.assignmentCount,
        },
      });
      res.status(201).json(profile);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.delete("/tool-profiles/:profileId", validate(deleteToolProfileSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getProfile(req.params.profileId as string), "Tool profile not found");
    if (!existing) return;
    assertToolAppMutationAccess(req, existing.companyId);
    const result = await svc.deleteProfile(existing.id, req.body);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile.deleted",
      entityType: "tool_profile",
      entityId: existing.id,
      details: {
        name: existing.name,
        summary: result.summary,
        reassignedToProfileId: result.reassignedToProfileId,
        reassignedBindingCount: result.reassignedBindingCount,
      },
    });
    res.json(result);
  });

  router.post("/tool-profiles/:profileId/new-tools/review", validate(reviewToolProfileNewToolsSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getProfile(req.params.profileId as string), "Tool profile not found");
    if (!existing) return;
    assertToolAppMutationAccess(req, existing.companyId);
    const result = await svc.reviewProfileNewTools(existing.id, req.body, getActorInfo(req));
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile.new_tools_reviewed",
      entityType: "tool_profile",
      entityId: existing.id,
      details: {
        allowedCount: result.allowedCount,
        keptBlockedCount: result.keptBlockedCount,
        reviewedCatalogEntryIds: result.reviewedCatalogEntryIds,
      },
    });
    res.json(result);
  });

  router.post("/tool-profiles/:profileId/entries", validate(createToolProfileEntryForProfileSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getProfile(req.params.profileId as string), "Tool profile not found");
    if (!existing) return;
    assertToolAppMutationAccess(req, existing.companyId);
    const entry = await svc.addProfileEntry(existing.id, req.body);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile_entry.created",
      entityType: "tool_profile_entry",
      entityId: entry.id,
      details: { profileId: entry.profileId, selectorType: entry.selectorType, effect: entry.effect },
    });
    res.status(201).json(entry);
  });

  router.patch("/tool-profile-entries/:entryId", validate(updateToolProfileEntrySchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getProfileEntry(req.params.entryId as string), "Tool profile entry not found");
    if (!existing) return;
    assertToolAppMutationAccess(req, existing.companyId);
    const entry = await svc.updateProfileEntry(existing.id, req.body);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile_entry.updated",
      entityType: "tool_profile_entry",
      entityId: entry.id,
      details: { profileId: entry.profileId, selectorType: entry.selectorType, effect: entry.effect },
    });
    res.json(entry);
  });

  router.delete("/tool-profile-entries/:entryId", async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getProfileEntry(req.params.entryId as string), "Tool profile entry not found");
    if (!existing) return;
    assertToolAppMutationAccess(req, existing.companyId);
    const entry = await svc.deleteProfileEntry(existing.id);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile_entry.deleted",
      entityType: "tool_profile_entry",
      entityId: entry.id,
      details: { profileId: entry.profileId },
    });
    res.json(entry);
  });

  router.post(
    "/companies/:companyId/tools/profiles/:profileId/bind",
    validate(createToolProfileBindingForProfileSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertToolAppMutationAccess(req, companyId);
      const existing = await svc.getProfile(req.params.profileId as string, companyId);
      try {
        const binding = await svc.bindProfile(existing.id, req.body, getActorInfo(req));
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "tool_profile_binding.created",
          entityType: "tool_profile_binding",
          entityId: binding.id,
          details: { profileId: binding.profileId, targetType: binding.targetType, targetId: binding.targetId },
        });
        res.status(201).json(binding);
      } catch (error) {
        svc.ensureNoDuplicateNameError(error);
      }
    },
  );

  router.post(
    "/companies/:companyId/tools/profiles/:profileId/unbind",
    validate(unbindToolProfileBindingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertToolAppMutationAccess(req, companyId);
      const existing = await svc.getProfile(req.params.profileId as string, companyId);
      const result = await svc.unbindProfile(existing.id, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile_binding.deleted",
        entityType: "tool_profile",
        entityId: existing.id,
        details: { targetType: req.body.targetType, targetId: req.body.targetId, unbound: result.unbound },
      });
      res.json(result);
    },
  );

  router.get("/companies/:companyId/tools/runtime-slots", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsRuntimeManage(req, companyId);
    res.json({ runtimeSlots: await svc.listRuntimeSlots(companyId) });
  });

  router.post("/companies/:companyId/tools/runtime-slots/:id/stop", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsRuntimeManage(req, companyId);
    res.json(await svc.stopRuntimeSlot(companyId, req.params.id as string, getActorInfo(req)));
  });

  router.post("/companies/:companyId/tools/runtime-slots/:id/restart", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsRuntimeManage(req, companyId);
    res.json(await svc.restartRuntimeSlot(companyId, req.params.id as string, getActorInfo(req)));
  });

  router.get("/companies/:companyId/tools/runtime-health", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getRuntimeHealth(companyId));
  });

  router.get("/companies/:companyId/tools/runs/:runId/decisions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getRunDecisionLookup(companyId, req.params.runId as string));
  });

  router.get("/companies/:companyId/tools/trust-rules", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ trustRules: await policySvc.listTrustRules(companyId) });
  });

  router.get("/companies/:companyId/tools/policies", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ policies: await policySvc.listPolicies(companyId) });
  });

  // Rules UI sentence slots map exactly onto policy selectors:
  // capability -> riskLevel, app -> applicationId, actions -> toolNames.
  router.post("/companies/:companyId/tools/policies/reorder", validate(reorderToolPoliciesSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    const policies = await policySvc.reorderPolicies(companyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_policy.reordered",
      entityType: "tool_policy",
      entityId: companyId,
      details: {
        policyIds: req.body.policyIds,
        priorityStep: 100,
      },
    });
    res.json({ policies });
  });

  router.post("/companies/:companyId/tools/policies", validate(createToolPolicySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    try {
      const policy = await policySvc.createPolicy(companyId, req.body, { userId: req.actor.userId ?? null });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_policy.created",
        entityType: "tool_policy",
        entityId: policy.id,
        details: { name: policy.name, policyType: policy.policyType, priority: policy.priority },
      });
      res.status(201).json(policy);
    } catch (error) {
      policySvc.ensureNoDuplicatePolicyNameError(error);
    }
  });

  router.post("/companies/:companyId/tools/policies/:policyId/duplicate", validate(duplicateToolPolicySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    try {
      const policy = await policySvc.duplicatePolicy({
        companyId,
        policyId: req.params.policyId as string,
        body: req.body,
        actor: { userId: req.actor.userId ?? null },
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_policy.duplicated",
        entityType: "tool_policy",
        entityId: policy.id,
        details: {
          sourcePolicyId: req.params.policyId,
          name: policy.name,
          enabled: policy.enabled,
          priority: policy.priority,
        },
      });
      res.status(201).json(policy);
    } catch (error) {
      policySvc.ensureNoDuplicatePolicyNameError(error);
    }
  });

  router.patch("/companies/:companyId/tools/policies/:policyId", validate(updateToolPolicySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    try {
      const policy = await policySvc.updatePolicy({
        companyId,
        policyId: req.params.policyId as string,
        body: req.body,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_policy.updated",
        entityType: "tool_policy",
        entityId: policy.id,
        details: { name: policy.name, policyType: policy.policyType, enabled: policy.enabled, priority: policy.priority },
      });
      res.json(policy);
    } catch (error) {
      policySvc.ensureNoDuplicatePolicyNameError(error);
    }
  });

  router.delete("/companies/:companyId/tools/policies/:policyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    const policy = await policySvc.deletePolicy({
      companyId,
      policyId: req.params.policyId as string,
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_policy.deleted",
      entityType: "tool_policy",
      entityId: policy.id,
      details: { name: policy.name, policyType: policy.policyType },
    });
    res.json(policy);
  });

  router.post(
    "/companies/:companyId/tools/action-requests/:actionRequestId/trust-rule",
    validate(createToolTrustRuleFromActionRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertToolAppMutationAccess(req, companyId);
      const policy = await policySvc.createTrustRuleFromActionRequest({
        companyId,
        actionRequestId: req.params.actionRequestId as string,
        body: req.body,
        actor: { userId: req.actor.userId ?? null },
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_trust_rule.created",
        entityType: "tool_policy",
        entityId: policy.id,
        details: {
          name: policy.name,
          selectors: policy.selectors,
          sourceActionRequestId: req.params.actionRequestId,
        },
      });
      res.status(201).json(policy);
    },
  );

  router.post("/companies/:companyId/tools/trust-rules/:policyId/revoke", validate(revokeToolTrustRuleSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    const policy = await policySvc.revokeTrustRule({
      companyId,
      policyId: req.params.policyId as string,
      body: req.body,
      actor: { userId: req.actor.userId ?? null },
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_trust_rule.revoked",
      entityType: "tool_policy",
      entityId: policy.id,
      details: { reason: req.body.reason ?? null },
    });
    res.json(policy);
  });

  router.get("/companies/:companyId/tools/stdio-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsAdmin(req, companyId);
    res.json({ templates: await svc.approvedStdioTemplates(companyId) });
  });

  router.post("/companies/:companyId/tools/stdio-templates", validate(createToolStdioCommandTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsAdmin(req, companyId);
    const template = await svc.createStdioCommandTemplate(companyId, req.body, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_stdio_command_template.created",
      entityType: "tool_stdio_command_template",
      entityId: template.id ?? template.templateId,
      details: {
        templateId: template.templateId,
        command: template.command,
        argCount: template.args.length,
        envKeyCount: template.envKeys.length,
        toolCount: template.tools.length,
      },
    });
    res.status(201).json(template);
  });

  router.post(
    "/companies/:companyId/tools/stdio-templates/:templateId/disable",
    validate(disableToolStdioCommandTemplateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertToolsAdmin(req, companyId);
      const template = await svc.disableStdioCommandTemplate(companyId, req.params.templateId as string);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_stdio_command_template.disabled",
        entityType: "tool_stdio_command_template",
        entityId: template.id ?? template.templateId,
        details: { templateId: template.templateId, reason: req.body.reason ?? null },
      });
      res.json(template);
    },
  );

  router.post("/companies/:companyId/tools/mcp/import-json", validate(importMcpJsonSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const preview = await svc.previewMcpJsonImport(req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.import_mcp_json_previewed",
      entityType: "tool_connection_import",
      entityId: companyId,
      details: { draftCount: preview.drafts.length },
    });
    res.json(preview);
  });

  router.post("/companies/:companyId/tools/policy/test", validate(toolPolicyTestRequestSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = { ...req.body, companyId };
    const decision = await policySvc.decide(input);
    let auditEvent = null;
    if (input.writeAuditEvent === true) {
      auditEvent = await policySvc.writeAudit(input, decision);
    }
    res.json({ decision, auditEvent });
  });

  return router;
}
