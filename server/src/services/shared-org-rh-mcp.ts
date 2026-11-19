/**
 * Per-org rh-mcp service token for SHARED orgs (TECH-8066).
 *
 * A company whose `visibility` is `shared` gets ONE bot-token connection to rh-mcp, named `rh-mcp-service`, with no
 * manual step: no person signs in, and no agent depends on one person's OAuth session. The token is minted through the
 * ownership API (the platform's single place that issues rh-auth credentials, see
 * `docs/design/agent-runtime-isolation.md` in rh-data-platform), never by Paperclip itself, and carries only the closed
 * read-scope set `RH_MCP_SERVICE_TOKEN_SCOPES`. rh-mcp enforces one scope per tool, so the token's scopes decide what
 * runs; the `rh-mcp-service` spec entry makes the OFFERED tools match (`RH_MCP_SERVICE_REVIEWED_TOOLS`).
 *
 * Per company, idempotently: mint (or rotate when the registry already holds the sub) -> connect through the same
 * service the Apps wizard uses (vault secret, discovery) -> enable exactly the reviewed tools -> install the
 * connection on every live agent. New agents of an org that already has the connection get it from the spec entry's
 * `defaultEnabled` at creation. Later ticks only keep that true and re-issue the token before it expires.
 *
 * Gated by the default-MCP spec flag, `PAPERCLIP_SHARED_ORG_RH_MCP_ENABLED`, the company rollout scope, an rh-mcp URL
 * (`PAPERCLIP_DEFAULT_MCP_RH_MCP_URL`, the same endpoint the personal OAuth seed uses) and the ownership API
 * credentials. An archived `rh-mcp-service` connection is an org opt-out and is never re-created. No token, secret
 * value, header or upstream text is ever logged or returned: outcomes carry closed reason codes only.
 */
import { tailnetAwareFetch } from "./remote-http-fetch.js";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { agents, companies, companySecrets, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolProfileEntries, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  isCompanyInDefaultMcpTemplateScope,
  readDefaultMcpTemplateScope,
  type DefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import { logActivity } from "./activity-log.js";
import {
  mintRhMcpServiceCredential,
  resolveCommsBoardProvisionerConfig,
  rotateRhMcpServiceCredential,
  type FetchLike,
} from "./comms-board-provisioner-client.js";
import { validOAuthSeedEndpoint } from "./default-mcp-oauth-seed.js";
import { isCompanyVisibilityShared } from "./default-mcp-setup.js";
import { pickTemplateOwner } from "./default-mcp-template.js";
import { RH_MCP_SERVICE_REVIEWED_TOOLS, RH_MCP_SERVICE_REVIEWED_TOOLS_VERSION, isDefaultMcpSpecEnabled } from "./default-mcp-spec.js";
import { secretService } from "./secrets.js";
import { toolAccessService } from "./tool-access.js";

export const SHARED_ORG_RH_MCP_ENABLED_ENV = "PAPERCLIP_SHARED_ORG_RH_MCP_ENABLED";
/** The rh-mcp MCP endpoint. Shared with the personal OAuth seed (`rh-mcp` spec entry), so one setting covers both. */
export const SHARED_ORG_RH_MCP_URL_ENV = "PAPERCLIP_DEFAULT_MCP_RH_MCP_URL";
export const SHARED_ORG_RH_MCP_CONNECTION_NAME = "rh-mcp-service";
export const SHARED_ORG_RH_MCP_INTERVAL_MS = 5 * 60_000;
export const SHARED_ORG_RH_MCP_SWEEP_PAGE_SIZE = 50;
/** Re-issue the token once it has this long left. Tokens last 365 days (ownership API default for bot credentials). */
export const SHARED_ORG_RH_MCP_REFRESH_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
/** Non-secret expiry of the stored token, on the connection's `config`. */
export const SHARED_ORG_RH_MCP_EXPIRY_CONFIG_KEY = "rhMcpServiceTokenExpiresAt";
/** Stored reviewed-tools version on the connection's `config`. */
export const SHARED_ORG_RH_MCP_REVIEWED_TOOLS_VERSION_CONFIG_KEY = "rhMcpServiceReviewedToolsVersion";

const ACTOR = { actorType: "system", actorId: "shared-org-rh-mcp" } as const;
/** `connectGalleryApp`'s credential slot for a pasted-URL connection with `authMode: "bearer"`. */
const TOKEN_CREDENTIAL_PATH = "credentials.authorization";

type ToolAccessOptions = NonNullable<Parameters<typeof toolAccessService>[1]>;

export interface SharedOrgRhMcpContext {
  db: Db;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Company rollout scope. Production uses the boot-frozen scope; tests inject one. */
  templateScope?: DefaultMcpTemplateScope;
  toolAccessOptions?: ToolAccessOptions;
}

export type SharedOrgRhMcpOutcome =
  | { kind: "skipped"; reason: "disabled" | "out_of_scope" | "company_inactive" | "not_shared" | "opted_out" }
  | { kind: "waiting"; reason: "not_configured" | "owner_required" }
  | { kind: "ready"; installed: number }
  | { kind: "provisioned"; installed: number }
  | { kind: "rotated"; installed: number }
  | { kind: "reconciled"; installed: number }
  | {
      kind: "error";
      reason:
        | "ambiguous_connection"
        | "mint_failed"
        | "rotate_failed"
        | "connect_failed"
        | "finish_failed"
        | "secret_store_failed"
        | "tools_missing";
    };

type Connection = typeof toolConnections.$inferSelect;

function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "yes"].includes((env[SHARED_ORG_RH_MCP_ENABLED_ENV] ?? "").trim().toLowerCase());
}

function parseExpiry(config: unknown): Date | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const raw = (config as Record<string, unknown>)[SHARED_ORG_RH_MCP_EXPIRY_CONFIG_KEY];
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseReviewedToolsVersion(config: unknown): number | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const raw = (config as Record<string, unknown>)[SHARED_ORG_RH_MCP_REVIEWED_TOOLS_VERSION_CONFIG_KEY];
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

async function recordReviewedToolsVersion(db: Db, connectionId: string, version: number): Promise<void> {
  await db
    .update(toolConnections)
    .set({
      config: sql`jsonb_set(coalesce(${toolConnections.config}, '{}'::jsonb), ARRAY[${SHARED_ORG_RH_MCP_REVIEWED_TOOLS_VERSION_CONFIG_KEY}::text], to_jsonb(${version}::int), true)`,
    })
    .where(eq(toolConnections.id, connectionId));
}

async function recordExpiry(db: Db, connectionId: string, expiresAt: string): Promise<void> {
  await db
    .update(toolConnections)
    .set({
      config: sql`jsonb_set(coalesce(${toolConnections.config}, '{}'::jsonb), ARRAY[${SHARED_ORG_RH_MCP_EXPIRY_CONFIG_KEY}::text], to_jsonb(${expiresAt}::text), true)`,
    })
    .where(eq(toolConnections.id, connectionId));
}

/**
 * Mint the org's credential, or re-issue it when the registry already holds the sub (a crashed or unknown earlier
 * attempt). An unknown mint outcome is never retried in the same tick: the next tick's mint finds the sub and rotates.
 */
async function obtainToken(
  ctx: SharedOrgRhMcpContext,
  config: Extract<ReturnType<typeof resolveCommsBoardProvisionerConfig>, { ok: true }>["config"],
  companyId: string,
  ownerEmail: string,
): Promise<{ ok: true; token: string; expiresAt: string | null; rotated: boolean } | { ok: false; reason: "mint_failed" | "rotate_failed" }> {
  const fetchImpl = ctx.fetchImpl ?? tailnetAwareFetch;
  const minted = await mintRhMcpServiceCredential(config, { companyId, ownerEmail }, fetchImpl);
  if (minted.ok) return { ok: true, token: minted.boardToken, expiresAt: minted.tokenExpiresAt, rotated: false };
  if (minted.reason !== "ownership_conflict") return { ok: false, reason: "mint_failed" };
  const rotated = await rotateRhMcpServiceCredential(config, { companyId }, fetchImpl);
  if (!rotated.ok) return { ok: false, reason: "rotate_failed" };
  return { ok: true, token: rotated.boardToken, expiresAt: rotated.tokenExpiresAt, rotated: true };
}

/** Enable exactly the reviewed tools the connection's catalog lists; every other discovered action stays off. */
async function finishConnection(ctx: SharedOrgRhMcpContext, connection: Connection): Promise<"ok" | "tools_missing" | "finish_failed"> {
  let catalog = await ctx.db
    .select({ id: toolCatalogEntries.id, toolName: toolCatalogEntries.toolName, status: toolCatalogEntries.status })
    .from(toolCatalogEntries)
    .where(and(eq(toolCatalogEntries.companyId, connection.companyId), eq(toolCatalogEntries.connectionId, connection.id)));
  const allow = new Set(RH_MCP_SERVICE_REVIEWED_TOOLS);
  let haveNames = new Set(catalog.map((entry) => entry.toolName));
  let missingReviewed = RH_MCP_SERVICE_REVIEWED_TOOLS.filter((name) => !haveNames.has(name));
  if (missingReviewed.length > 0 && connection.status === "active") {
    try {
      await toolAccessService(ctx.db, ctx.toolAccessOptions).refreshCatalog(connection.id, ACTOR);
      catalog = await ctx.db
        .select({ id: toolCatalogEntries.id, toolName: toolCatalogEntries.toolName, status: toolCatalogEntries.status })
        .from(toolCatalogEntries)
        .where(and(eq(toolCatalogEntries.companyId, connection.companyId), eq(toolCatalogEntries.connectionId, connection.id)));
      haveNames = new Set(catalog.map((entry) => entry.toolName));
      missingReviewed = RH_MCP_SERVICE_REVIEWED_TOOLS.filter((name) => !haveNames.has(name));
    } catch (err) {
      logger.warn({ companyId: connection.companyId, errorClass: errorClass(err) }, "shared-org rh-mcp refresh catalog failed");
      return "finish_failed";
    }
  }
  if (missingReviewed.length > 0) {
    logger.warn(
      { companyId: connection.companyId, missing: missingReviewed, listed: catalog.length, reviewed: allow.size },
      "shared-org rh-mcp catalog missing reviewed tools",
    );
    return "tools_missing";
  }
  const enabled = catalog.filter((entry) => allow.has(entry.toolName));

  // Preserve existing agent bindings so reconciliation does not drop agent access,
  // filtering out truly orphaned/non-existent install rows (e.g. agent deleted or belongs
  // to a different company) so assertAgentsInCompany does not reject non-existent agents.
  // We do not apply any liveness/status policy here: status-based install eligibility is
  // a decision for the install-granting paths (e.g. installOnLiveAgents, which proactively
  // grants new installs), not for this preserve-existing-access path.
  const existingAgentInstalls = await ctx.db
    .select({ targetId: toolConnectionInstalls.targetId })
    .from(toolConnectionInstalls)
    .where(
      and(
        eq(toolConnectionInstalls.companyId, connection.companyId),
        eq(toolConnectionInstalls.connectionId, connection.id),
        eq(toolConnectionInstalls.targetType, "agent"),
      ),
    );
  const installedAgentIds = [...new Set(existingAgentInstalls.map((row) => row.targetId))];
  let liveInstalledAgentIds: string[] = [];
  if (installedAgentIds.length > 0) {
    const liveAgents = await ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, connection.companyId),
          inArray(agents.id, installedAgentIds),
        ),
      );
    liveInstalledAgentIds = liveAgents.map((a) => a.id);
  }

  try {
    await toolAccessService(ctx.db, ctx.toolAccessOptions).finishGalleryAppConnection(
      connection.companyId,
      connection.id,
      {
        enabledCatalogEntryIds: enabled.map((entry) => entry.id),
        askFirstCatalogEntryIds: [],
        // Every currently quarantined action gets a settled review decision: allowlisted tools activate and the rest are recorded as reviewed-declined.
        reviewedCatalogEntryIds: catalog.filter((entry) => entry.status === "quarantined").map((entry) => entry.id),
        access: { agentIds: liveInstalledAgentIds },
      },
      ACTOR,
    );
  } catch (err) {
    logger.warn({ companyId: connection.companyId, errorClass: errorClass(err) }, "shared-org rh-mcp finish failed");
    return "finish_failed";
  }

  // Verify post-finish that every tool currently in RH_MCP_SERVICE_REVIEWED_TOOLS is actually present and enabled in toolProfileEntries
  const profileEntries = await ctx.db
    .select({ toolName: toolCatalogEntries.toolName, effect: toolProfileEntries.effect })
    .from(toolProfileEntries)
    .innerJoin(toolCatalogEntries, eq(toolCatalogEntries.id, toolProfileEntries.catalogEntryId))
    .where(
      and(
        eq(toolProfileEntries.companyId, connection.companyId),
        eq(toolProfileEntries.connectionId, connection.id),
      ),
    );
  const enabledNames = new Set(profileEntries.filter((p) => p.effect === "include").map((p) => p.toolName));
  const stillMissing = RH_MCP_SERVICE_REVIEWED_TOOLS.filter((name) => !enabledNames.has(name));
  if (stillMissing.length > 0) {
    logger.warn(
      { companyId: connection.companyId, missing: stillMissing },
      "shared-org rh-mcp reviewed tools missing from profile after finish",
    );
    return "tools_missing";
  }

  return "ok";
}

/** Installs the connection on every live agent that does not have it yet. Returns how many were added. */
async function installOnLiveAgents(ctx: SharedOrgRhMcpContext, connection: Connection): Promise<number> {
  const service = toolAccessService(ctx.db, ctx.toolAccessOptions);
  const [liveAgents, existing] = await Promise.all([
    ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, connection.companyId), ne(agents.status, "terminated"), ne(agents.status, "pending_approval"))),
    ctx.db
      .select({ targetId: toolConnectionInstalls.targetId })
      .from(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, connection.companyId),
          eq(toolConnectionInstalls.connectionId, connection.id),
          eq(toolConnectionInstalls.targetType, "agent"),
        ),
      ),
  ]);
  const have = new Set(existing.map((row) => row.targetId));
  let added = 0;
  for (const agent of liveAgents) {
    if (have.has(agent.id)) continue;
    await service.addAgentConnectionInstall(ctx.db, connection, agent.id, undefined, {
      install: true,
      bindingSource: "default_mcp_spec",
    });
    added += 1;
  }
  return added;
}

async function reloadConnection(db: Db, connectionId: string): Promise<Connection> {
  const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).limit(1);
  if (!row) throw new Error("connection disappeared");
  return row;
}

async function logOutcome(db: Db, companyId: string, action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: ACTOR.actorId,
      action,
      entityType: "company",
      entityId: companyId,
      // Non-secret facts only: ids, counts, closed reason codes and an expiry. Never a token, header or upstream text.
      details,
    });
  } catch (err) {
    logger.warn({ companyId, errorClass: errorClass(err) }, "shared-org rh-mcp activity log failed");
  }
}

export async function ensureSharedOrgRhMcp(ctx: SharedOrgRhMcpContext, companyId: string): Promise<SharedOrgRhMcpOutcome> {
  const env = ctx.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env) || !isEnabled(env)) return { kind: "skipped", reason: "disabled" };
  if (!isCompanyInDefaultMcpTemplateScope(ctx.templateScope ?? readDefaultMcpTemplateScope(), companyId)) {
    return { kind: "skipped", reason: "out_of_scope" };
  }

  const [company] = await ctx.db
    .select({ status: companies.status, visibility: companies.visibility })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company || (company.status !== "active" && company.status !== "paused")) return { kind: "skipped", reason: "company_inactive" };
  // Only an explicitly shared org. An unclassified (NULL) company is private, never silently upgraded.
  if (!isCompanyVisibilityShared(company.visibility)) return { kind: "skipped", reason: "not_shared" };

  const rows = await ctx.db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, SHARED_ORG_RH_MCP_CONNECTION_NAME)));
  const live = rows.filter((row) => row.status !== "archived");
  // An archived row is the org's opt-out, exactly like an archived OAuth seed.
  if (live.length === 0 && rows.length > 0) return { kind: "skipped", reason: "opted_out" };
  if (live.length > 1) return { kind: "error", reason: "ambiguous_connection" };

  const url = env[SHARED_ORG_RH_MCP_URL_ENV]?.trim();
  const provisioner = resolveCommsBoardProvisionerConfig(env);
  if (!url || !validOAuthSeedEndpoint(url) || !provisioner.ok) return { kind: "waiting", reason: "not_configured" };

  const service = toolAccessService(ctx.db, ctx.toolAccessOptions);
  let connection = live[0] ?? null;
  let kind: "ready" | "provisioned" = "ready";
  let reconciled = false;
  let reconcileError: "finish_failed" | "tools_missing" | null = null;
  let previousVersion: number | null = null;

  if (!connection) {
    const owner = await pickTemplateOwner(ctx.db, companyId);
    if (!owner) return { kind: "waiting", reason: "owner_required" };
    const credential = await obtainToken(ctx, provisioner.config, companyId, owner.emailNorm);
    if (!credential.ok) return { kind: "error", reason: credential.reason };
    try {
      const connected = await service.connectGalleryApp(
        companyId,
        {
          link: url,
          name: SHARED_ORG_RH_MCP_CONNECTION_NAME,
          authMode: "bearer",
          credentialValues: { [TOKEN_CREDENTIAL_PATH]: credential.token },
        },
        ACTOR,
      );
      connection = await reloadConnection(ctx.db, connected.connectionId);
    } catch (err) {
      // Only the class: the error text could echo the upstream response. The minted token is simply re-issued next tick.
      logger.warn({ companyId, errorClass: errorClass(err) }, "shared-org rh-mcp connect failed");
      return { kind: "error", reason: "connect_failed" };
    }
    const expiresAt = credential.expiresAt ?? new Date((ctx.now?.() ?? new Date()).getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    await recordExpiry(ctx.db, connection.id, expiresAt);
    kind = "provisioned";
  }

  // A draft (or otherwise unfinished) connection is a resumed setup: no new token, just the finish.
  if (connection.status !== "active" || !connection.enabled) {
    const finished = await finishConnection(ctx, connection);
    if (finished !== "ok") return { kind: "error", reason: finished };
    await recordReviewedToolsVersion(ctx.db, connection.id, RH_MCP_SERVICE_REVIEWED_TOOLS_VERSION);
    connection = await reloadConnection(ctx.db, connection.id);
    if (kind === "ready") kind = "provisioned";
  } else {
    // Healthy and active: check if the reviewed tools set needs reconciliation (TECH-9109).
    const storedVersion = parseReviewedToolsVersion(connection.config);
    if (storedVersion === null || storedVersion < RH_MCP_SERVICE_REVIEWED_TOOLS_VERSION) {
      previousVersion = storedVersion;
      const finished = await finishConnection(ctx, connection);
      if (finished !== "ok") {
        reconcileError = finished;
      } else {
        await recordReviewedToolsVersion(ctx.db, connection.id, RH_MCP_SERVICE_REVIEWED_TOOLS_VERSION);
        connection = await reloadConnection(ctx.db, connection.id);
        reconciled = true;
        logger.info(
          { companyId, previousVersion, version: RH_MCP_SERVICE_REVIEWED_TOOLS_VERSION },
          "shared-org rh-mcp reconciled reviewed tools",
        );
      }
    }
  }

  // Keep the token valid (runs even if reconciliation was skipped or failed, so a reconcile failure does not block rotation).
  let rotated = false;
  const expiresAt = parseExpiry(connection.config);
  const now = ctx.now?.() ?? new Date();
  if (expiresAt && expiresAt.getTime() - now.getTime() < SHARED_ORG_RH_MCP_REFRESH_WINDOW_MS) {
    const rotateResult = await rotateRhMcpServiceCredential(provisioner.config, { companyId }, ctx.fetchImpl ?? tailnetAwareFetch);
    if (!rotateResult.ok) return { kind: "error", reason: "rotate_failed" };
    const secretId = connection.credentialSecretRefs?.[0]?.secretId;
    if (!secretId) return { kind: "error", reason: "secret_store_failed" };
    try {
      const [secret] = await ctx.db
        .select({ latestVersion: companySecrets.latestVersion })
        .from(companySecrets)
        .where(and(eq(companySecrets.id, secretId), eq(companySecrets.companyId, companyId)))
        .limit(1);
      if (!secret) return { kind: "error", reason: "secret_store_failed" };
      const owner = await pickTemplateOwner(ctx.db, companyId);
      await secretService(ctx.db).rotate(
        secretId,
        { value: rotateResult.boardToken, expectedLatestVersion: secret.latestVersion },
        { userId: owner?.userId ?? null },
      );
    } catch (err) {
      logger.warn({ companyId, errorClass: errorClass(err) }, "shared-org rh-mcp token storage failed");
      return { kind: "error", reason: "secret_store_failed" };
    }
    await recordExpiry(
      ctx.db,
      connection.id,
      rotateResult.tokenExpiresAt ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    );
    rotated = true;
  }

  if (reconcileError) {
    if (rotated) {
      logger.warn(
        { companyId, reason: reconcileError },
        "shared-org rh-mcp reviewed tools reconciliation failed while token rotation succeeded",
      );
    } else {
      return { kind: "error", reason: reconcileError };
    }
  }

  const installed = await installOnLiveAgents(ctx, connection);

  if (reconciled) {
    await logOutcome(ctx.db, companyId, "company.shared_org_rh_mcp.reconciled", {
      connectionId: connection.id,
      installed,
      previousVersion,
      version: RH_MCP_SERVICE_REVIEWED_TOOLS_VERSION,
    });
  }

  if (rotated) {
    await logOutcome(ctx.db, companyId, "company.shared_org_rh_mcp.rotated", {
      connectionId: connection.id,
      installed,
      version: parseReviewedToolsVersion(connection.config),
    });
  } else if (kind === "provisioned") {
    await logOutcome(ctx.db, companyId, "company.shared_org_rh_mcp.provisioned", {
      connectionId: connection.id,
      installed,
      version: RH_MCP_SERVICE_REVIEWED_TOOLS_VERSION,
    });
  }

  if (rotated) {
    return { kind: "rotated", installed };
  }
  if (reconciled) {
    return { kind: "reconciled", installed };
  }
  if (kind === "provisioned") {
    return { kind: "provisioned", installed };
  }
  return { kind: "ready", installed };
}

/** Every shared, active/paused company inside the rollout scope, visited in keyset pages so none is starved. */
export async function sweepSharedOrgRhMcp(ctx: SharedOrgRhMcpContext & { pageSize?: number }): Promise<number> {
  const env = ctx.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env) || !isEnabled(env)) return 0;
  const pageSize = ctx.pageSize ?? SHARED_ORG_RH_MCP_SWEEP_PAGE_SIZE;
  let visited = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows: Array<{ id: string }> = await ctx.db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          inArray(companies.status, ["active", "paused"]),
          eq(companies.visibility, "shared"),
          cursor ? gt(companies.id, cursor) : undefined,
        ),
      )
      .orderBy(companies.id)
      .limit(pageSize);
    for (const row of rows) {
      try {
        const outcome = await ensureSharedOrgRhMcp(ctx, row.id);
        if (outcome.kind === "error") {
          logger.warn({ companyId: row.id, reason: outcome.reason }, "shared-org rh-mcp setup incomplete");
        }
      } catch (err) {
        logger.warn({ companyId: row.id, errorClass: errorClass(err) }, "shared-org rh-mcp sweep item failed");
      }
    }
    visited += rows.length;
    if (rows.length < pageSize) return visited;
    cursor = rows[rows.length - 1]!.id;
  }
}

/** Periodic backstop: startup plus every few minutes, unref'd, cleared on shutdown. A flag-gated no-op when off. */
export function startSharedOrgRhMcpSweep(db: Db, ctx: Omit<SharedOrgRhMcpContext, "db"> = {}): () => void {
  const env = ctx.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env) || !isEnabled(env)) return () => {};

  let active = true;
  let timer: NodeJS.Timeout | null = null;
  let initialImmediate: NodeJS.Immediate | null = null;

  const tick = () => {
    initialImmediate = null;
    if (!active) return;
    sweepSharedOrgRhMcp({ db, ...ctx })
      .catch((err) => logger.warn({ errorClass: errorClass(err) }, "shared-org rh-mcp sweep failed"))
      .finally(() => {
        if (!active) return;
        timer = setTimeout(tick, SHARED_ORG_RH_MCP_INTERVAL_MS);
        timer.unref?.();
      });
  };
  initialImmediate = setImmediate(tick);

  return () => {
    active = false;
    if (initialImmediate) clearImmediate(initialImmediate);
    if (timer) clearTimeout(timer);
  };
}
