/**
 * Default MCP spec runtime (TECH-7204): applies `DEFAULT_MCP_SPEC` to a NEW agent.
 *
 *  1. `snapshotDefaultMcpForNewAgent` runs INSIDE the agent-create transaction and records the
 *     agent's per-entry state under the server-managed `agents.metadata.defaultMcp` key (a
 *     `jsonb_set` of that key only). For an ordinary template it offers permission only (OFF, no
 *     install) or, for `defaultEnabled`, install + permission through the normal install helper.
 *  2. Setup hooks run AFTER commit, never inside a transaction around an external call and never
 *     awaited by agent creation. A durable sweep is the backstop. Every claim and checkpoint is a
 *     path-scoped `jsonb_set` guarded by a random `claimId`, so an owner bind or a stale claimer can
 *     neither lose nor clobber an outcome.
 *
 * Retry policy (the board and ownership POSTs are insert-only, so a lost response leaves a live
 * identity or token): pre-call checkpoints are written BEFORE each POST. A claim that finds a
 * checkpoint without its result is an UNKNOWN outcome and is terminal. Only steps that created
 * nothing external (missing config/template/owner/approval) or that follow a stored secret (the
 * dedicated connection stage, one local transaction) are retried, with bounded capped backoff.
 *
 * Effective install state is derived from install rows plus `installAppliesToAgent`
 * (default-mcp-spec.ts); a company-wide install never authorizes a managed connection.
 */
import { tailnetAwareFetch } from "./remote-http-fetch.js";
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, notInArray, sql, type SQL } from "drizzle-orm";
import type { CompanyVisibility } from "@paperclipai/shared";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  toolCatalogEntries,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { AGENT_MEMORY_ENTRY_KEY, agentMemoryHook, agentMemoryToolsEnabled, agentMemoryToolsHarness } from "./default-mcp-agent-memory.js";
import { sweepAgentMemoryRotation } from "./agent-memory-rotation.js";
import { ownerEmailFor } from "./default-mcp-owner.js";
import { isCompanyInDefaultMcpTemplateScope, readDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { logActivity } from "./activity-log.js";
import { sweepBrainBindings } from "./arcana-brain-binding.js";
import { sweepDefaultInstalls } from "./default-mcp-install-reconcile.js";
import { sweepAgentProfileRoutines } from "./default-agent-profile-routine.js";
import { ARCANA_IDENTITY_RECIPE_VERSION, composeArcanaBrainIdentity, provisionArcanaBrain, resolveArcanaProvisionerConfig, sha256Hex } from "./arcana-provisioner-client.js";
import { syncConnectionCredentialBindings } from "./connection-credential-bindings.js";
import {
  composeCommsBoardDisplayName,
  composeCommsBoardIdentity,
  COMMS_BOARD_TOKEN_SCOPES_VERSION,
  mintCommsBoardCredential,
  registerCommsBoardAgent,
  resolveCommsBoardProvisionerConfig,
  type FetchLike,
} from "./comms-board-provisioner-client.js";
import {
  DEFAULT_MCP_LEASE_MS,
  DEFAULT_MCP_MAX_ATTEMPTS,
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY,
  defaultMcpBackoffMs,
  isArcanaStaticTemplate,
  isDefaultMcpSpecEnabled,
  isManagedTemplate,
  isValidDefaultMcpTemplate,
  readDefaultMcpState,
  type DefaultMcpAgentState,
  type DefaultMcpBindingRef,
  type DefaultMcpEntrySpec,
  type DefaultMcpEntryState,
  type DefaultMcpSetupHookKey,
  type DefaultMcpSetupReason,
} from "./default-mcp-spec.js";
import {
  managedTemplateUsability,
  sweepCompanyTemplates,
  waitForScheduledCompanyTemplates,
} from "./default-mcp-template.js";
import type { DefaultMcpTemplateContext } from "./default-mcp-template.js";
import { secretService } from "./secrets.js";
import { credentialRefConfigPath, toolAccessService } from "./tool-access.js";

// The backoff curve lives with the spec constants (shared with the company-template provisioner).
export { defaultMcpBackoffMs };

type DbLike = Pick<Db, "select" | "insert" | "update" | "execute">;

/** `ARRAY['defaultMcp','entries',<key>,...rest]` as bound text parameters. */
function entryPathSql(key: string, ...rest: string[]): SQL {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", key, ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

type EntryPatch = {
  binding?: DefaultMcpBindingRef | null;
  connectionId?: string | null;
  setup?: Partial<DefaultMcpEntryState["setup"]>;
};

/**
 * Path-scoped write of only `setup.*`, `binding` and `connectionId`, and only while the entry is
 * still claimed by `claimId`. `ownerUserId`, `templateKey` and every other key are never touched.
 */
async function patchEntryUnderClaim(
  db: Pick<Db, "update">,
  agentId: string,
  key: string,
  claimId: string,
  patch: EntryPatch,
): Promise<boolean> {
  let expr: SQL = sql`${agents.metadata}`;
  const set = (rest: string[], value: unknown) => {
    expr = sql`jsonb_set(${expr}, ${entryPathSql(key, ...rest)}, ${JSON.stringify(value)}::jsonb, true)`;
  };
  if (patch.binding !== undefined) set(["binding"], patch.binding);
  if (patch.connectionId !== undefined) set(["connectionId"], patch.connectionId);
  for (const [field, value] of Object.entries(patch.setup ?? {})) set(["setup", field], value);
  const rows = await db
    .update(agents)
    .set({ metadata: expr })
    .where(
      and(
        eq(agents.id, agentId),
        sql`${agents.metadata} #>> ${entryPathSql(key, "setup", "claimId")} = ${claimId}`,
        sql`${agents.metadata} #>> ${entryPathSql(key, "setup", "state")} = 'in_progress'`,
      ),
    )
    .returning({ id: agents.id });
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Phase 1: in-transaction snapshot
// ---------------------------------------------------------------------------

type Connection = typeof toolConnections.$inferSelect;

/** The org-curated (wizard-shaped) access profile of a template, if it has one. Additive, so it never shadows company tools. */
async function curatedAppProfile(db: Pick<Db, "select">, template: Connection) {
  const [profile] = await db
    .select()
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, template.companyId), eq(toolProfiles.profileKey, `app:${template.id}`)))
    .limit(1);
  const meta = (profile?.metadata ?? {}) as Record<string, unknown>;
  return profile && meta.source === "app_gallery_finish" && meta.connectionId === template.id ? profile : null;
}

/**
 * A wizard-shaped profile offering exactly the template's ACTIVE (reviewed) actions; created only when none exists.
 *
 * With `allow` (an ordinary entry's reviewed allowlist, TECH-7792) the profile is RECONCILED every call, so a
 * pre-existing `app:<id>` profile cannot keep offering an action outside the allowlist: entries for this connection
 * that are not an allowed, active catalog action are removed, and missing allowed actions are added. Without `allow`
 * the historical create-only behaviour is unchanged.
 */
async function ensureReviewedAppProfile(
  db: Pick<Db, "select" | "insert" | "delete">,
  template: Connection,
  allow?: ReadonlySet<string>,
) {
  const [existing] = await db
    .select({ id: toolProfiles.id })
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, template.companyId), eq(toolProfiles.profileKey, `app:${template.id}`)))
    .limit(1);
  if (existing && !allow) return;
  let profileId = existing?.id;
  if (!profileId) {
    const [profile] = await db
      .insert(toolProfiles)
      .values({
        companyId: template.companyId,
        profileKey: `app:${template.id}`,
        name: template.name,
        description: `Access profile for ${template.name}.`,
        status: "active",
        defaultAction: "deny",
        metadata: { source: "app_gallery_finish", connectionId: template.id },
      })
      .onConflictDoNothing()
      .returning({ id: toolProfiles.id });
    if (!profile) return;
    profileId = profile.id;
  }
  const actions = (
    await db
      .select()
      .from(toolCatalogEntries)
      .where(
        and(
          eq(toolCatalogEntries.companyId, template.companyId),
          eq(toolCatalogEntries.connectionId, template.id),
          eq(toolCatalogEntries.status, "active"),
          eq(toolCatalogEntries.entryKind, "tool"),
        ),
      )
  ).filter((action) => !allow || allow.has(action.toolName));
  const desiredIds = new Set(actions.map((action) => action.id));
  let present = new Set<string>();
  if (allow) {
    const rows = await db
      .select({ id: toolProfileEntries.id, catalogEntryId: toolProfileEntries.catalogEntryId, effect: toolProfileEntries.effect })
      .from(toolProfileEntries)
      .where(and(eq(toolProfileEntries.companyId, template.companyId), eq(toolProfileEntries.profileId, profileId)));
    const stale = rows.filter((row) => !(row.effect === "include" && row.catalogEntryId && desiredIds.has(row.catalogEntryId)));
    if (stale.length > 0) await db.delete(toolProfileEntries).where(inArray(toolProfileEntries.id, stale.map((row) => row.id)));
    present = new Set(rows.filter((row) => !stale.includes(row)).map((row) => row.catalogEntryId!));
  }
  const missing = actions.filter((action) => !present.has(action.id));
  if (missing.length === 0) return;
  await db.insert(toolProfileEntries).values(
    missing.map((action) => ({
      companyId: template.companyId,
      profileId: profileId!,
      selectorType: "catalog_entry" as const,
      effect: "include" as const,
      applicationId: template.applicationId,
      connectionId: template.id,
      catalogEntryId: action.id,
    })),
  );
}

export async function snapshotDefaultMcpForNewAgent(
  db: DbLike,
  input: {
    companyId: string;
    agentId: string;
    /** Accepted for compatibility; the write is a path-scoped `jsonb_set`, never a whole-blob overwrite. */
    existingMetadata?: unknown;
    /** Verified human actor from the server-side request context; null for agent actors and built-ins. */
    ownerUserId?: string | null;
    status?: string;
    spec?: readonly DefaultMcpEntrySpec[];
    /** Persist an explicit exclusion without provisioning or offering these entries. */
    excludedSetupKeys?: ReadonlySet<string>;
    now?: Date;
    /**
     * Entry keys to install (ON) even though `entry.defaultEnabled` is false, same reviewed
     * install path as a default-ON entry. Used only by legacy enrollment (TECH-7339) to carry a
     * legacy agent's existing effective access (an agent or company install predating its
     * `defaultMcp` snapshot) forward as an explicit per-agent install, so becoming
     * snapshot-managed doesn't silently drop access a company-wide install previously granted it.
     * New-agent creation never passes this.
     */
    preserveEnabledKeys?: ReadonlySet<string>;
    /**
     * New-agent creation only: a dedicated entry whose spec is `defaultEnabled` or `installByDefault` installs the agent's own dedicated
     * connection when setup creates it (`installOnReady`). Backfill and legacy enrollment never pass this.
     */
    installDedicatedOnReady?: boolean;
    /**
     * New-agent creation only: entries marked `newAgentsOnly` (agent memory) are offered. Every other caller
     * (backfill, legacy and missing-entry enrollment) leaves them excluded, so an existing agent is never provisioned.
     */
    newAgentCreation?: boolean;
  },
): Promise<DefaultMcpAgentState> {
  const spec = input.spec ?? DEFAULT_MCP_SPEC;
  const nowIso = (input.now ?? new Date()).toISOString();
  const entries: Record<string, DefaultMcpEntryState> = {};
  const service = toolAccessService(db as unknown as Db);
  // A setup agent (wizard step 1) is snapshotted again when it is hired (step 2). By then its first setup run may
  // already have registered, minted and stored a credential, and that progress lives only in the entry. An entry
  // that has made progress is never rewritten: the rewrite would drop the binding and the next run would register
  // the same identity again (`board_conflict`) and collide with the stored secret (`secret_store_failed`).
  const [existingRow] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .limit(1);
  const existingEntries = readDefaultMcpState(existingRow?.metadata)?.entries ?? {};
  const keptKeys = new Set<string>();

  for (const entry of spec) {
    const prior = existingEntries[entry.key];
    if (prior && (prior.binding || prior.setup.registerAttemptedAt || prior.setup.mintAttemptedAt || !["pending", "not_required"].includes(prior.setup.state))) {
      entries[entry.key] = prior;
      keptKeys.add(entry.key);
      continue;
    }
    // A new-agents-only entry is never written for an existing agent or for an agent that is not eligible: no entry at all.
    if (entry.newAgentsOnly && (input.newAgentCreation !== true || input.excludedSetupKeys?.has(entry.key))) continue;
    const excluded = input.excludedSetupKeys?.has(entry.key) === true;
    // Scoped by company: a same-named connection in another tenant is never matched.
    const templates = excluded ? [] : await db
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, input.companyId),
          eq(toolConnections.name, entry.connectionName),
          ne(toolConnections.status, "archived"),
        ),
      );
    // An entry that declares `templateRequirements` accepts only a connection that meets ALL of them;
    // anything else (wrong transport/auth/policy/identity, or missing tag) is a missing template.
    const candidate = templates.length === 1 ? templates[0]! : null;
    const template = candidate && isValidDefaultMcpTemplate(entry, candidate) ? candidate : null;
    const dedicated = Boolean(entry.setupHook);

    let enabled = false;
    if (template && !dedicated) {
      // An entry with a reviewed allowlist reconciles its app profile on EVERY path (opt-in OFF included), so the
      // curated profile an OFF agent is bound to can never offer an action outside the allowlist either.
      const reviewedAllow = entry.reviewedTools ? new Set(entry.reviewedTools.allow) : undefined;
      if (reviewedAllow) await ensureReviewedAppProfile(db as unknown as Db, template, reviewedAllow);
      if (entry.defaultEnabled || input.preserveEnabledKeys?.has(entry.key)) {
        // Install + permission through the normal install helper (offers the reviewed actions).
        await ensureReviewedAppProfile(db as unknown as Db, template, reviewedAllow);
        await service.addAgentConnectionInstall(db as unknown as Db, template, input.agentId, undefined, {
          install: true,
          // Server-tagged (additive) so the default-ON app never narrows away company-bound profiles.
          bindingSource: "default_mcp_spec",
        });
        enabled = true;
      } else if ((await curatedAppProfile(db, template))) {
        // OFF: the agent is offered the org's curated access (visible, permitted) with NO install.
        await service.addAgentConnectionInstall(db as unknown as Db, template, input.agentId, undefined, {
          install: false,
          bindingSource: "default_mcp_spec",
        });
      }
    }

    entries[entry.key] = {
      key: entry.key,
      templateKey: entry.connectionName,
      dedicated,
      enabled,
      templateConnectionId: template?.id ?? null,
      // Ordinary entries toggle the org connection itself; dedicated ones get their own connection at setup.
      connectionId: dedicated ? null : (template?.id ?? null),
      ownerUserId: input.ownerUserId ?? null,
      ...(!excluded && dedicated && (entry.defaultEnabled || entry.installByDefault) && input.installDedicatedOnReady ? { installOnReady: true } : {}),
      setup: {
        state: excluded ? "not_required" : dedicated ? "pending" : "not_required",
        reason: excluded ? "operator_excluded" : dedicated && input.status === "pending_approval" ? "awaiting_approval" : null,
        attemptCount: 0,
        nextAttemptAt: null,
        leaseUntil: null,
        claimId: null,
        registerAttemptedAt: null,
        mintAttemptedAt: null,
        updatedAt: nowIso,
      },
      binding: null,
    };
  }

  const state: DefaultMcpAgentState = { version: 1, entries };
  // Only the protected key is written, merged into whatever metadata the row currently holds.
  if (keptKeys.size === 0) {
    await db
      .update(agents)
      .set({
        metadata: sql`jsonb_set(coalesce(${agents.metadata}, '{}'::jsonb), ARRAY[${DEFAULT_MCP_METADATA_KEY}::text], ${JSON.stringify(state)}::jsonb, true)`,
      })
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    return state;
  }
  // Entries that kept their progress are not in the write at all, so a checkpoint landing now cannot be lost.
  for (const [key, value] of Object.entries(entries)) {
    if (keptKeys.has(key)) continue;
    await db
      .update(agents)
      .set({ metadata: sql`jsonb_set(${agents.metadata}, ${entryPathSql(key)}, ${JSON.stringify(value)}::jsonb, true)` })
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  }
  return state;
}

/**
 * Sets `ownerUserId` ONLY where it is still null, by path (never touching `setup`, so a concurrent
 * claim is not disturbed). Callers must have verified the user; use `bindDefaultMcpOwnerForApproval`
 * for the approval flow, which also checks active membership of the agent's company.
 */
export async function bindDefaultMcpOwnerIfUnset(db: DbLike, agentId: string, userId: string | null | undefined) {
  if (!userId) return;
  const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId)).limit(1);
  for (const entry of Object.values(readDefaultMcpState(row?.metadata)?.entries ?? {})) {
    if (entry.setup.state === "not_required") continue;
    await db
      .update(agents)
      .set({
        metadata: sql`jsonb_set(${agents.metadata}, ${entryPathSql(entry.key, "ownerUserId")}, to_jsonb(${userId}::text), false)`,
      })
      .where(
        and(
          eq(agents.id, agentId),
          sql`jsonb_typeof(${agents.metadata} #> ${entryPathSql(entry.key, "ownerUserId")}) = 'null'`,
        ),
      );
  }
}

/**
 * Approval-time owner binding, run INSIDE the activation transaction (before any post-commit
 * schedule). The approver must be an active member of the agent's company; the creation-time owner
 * is never overridden.
 */
export async function bindDefaultMcpOwnerForApproval(
  db: DbLike,
  input: { companyId: string; agentId: string; approverUserId: string | null | undefined },
) {
  if (!input.approverUserId) return;
  const [membership] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.approverUserId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .limit(1);
  if (!membership) return;
  await bindDefaultMcpOwnerIfUnset(db, input.agentId, input.approverUserId);
}

// ---------------------------------------------------------------------------
// Phase 2: claim + hook runner
// ---------------------------------------------------------------------------

export type DefaultMcpHookResult =
  | { kind: "ready"; reason?: null }
  /** Nothing external happened yet; retried indefinitely with capped backoff. */
  | { kind: "waiting"; reason: DefaultMcpSetupReason }
  /**
   * Counts toward the bounded retry budget. Allowed before any non-idempotent call
   * (e.g. pre-tool handshake failures before any checkpoint) or once a secret is durably stored.
   */
  | { kind: "retry"; reason: DefaultMcpSetupReason }
  | { kind: "error"; reason: DefaultMcpSetupReason };

export interface DefaultMcpHookInput {
  db: Db;
  companyId: string;
  agentId: string;
  entry: DefaultMcpEntrySpec;
  /** Latest claimed entry state. Kept current by `checkpoint`. */
  current: () => DefaultMcpEntryState;
  /**
   * Durably persist progress (path-scoped, guarded by this claim). Pass `tx` to commit the write
   * together with a local transaction. Throws when the claim was lost.
   */
  checkpoint: (
    patch: {
      binding?: DefaultMcpBindingRef | null;
      connectionId?: string | null;
      registerAttemptedAt?: string;
      mintAttemptedAt?: string;
    },
    tx?: Pick<Db, "update">,
  ) => Promise<void>;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
}

export type DefaultMcpSetupHook = ((input: DefaultMcpHookInput) => Promise<DefaultMcpHookResult>) & {
  /**
   * Optional cheap, local check that a READY entry's wiring still matches reality. A drifted entry is
   * returned to `pending` so the (idempotent) local stage repairs it; nothing external is ever re-run.
   */
  verifyReady?: (db: Db, companyId: string, agentId: string, entry: DefaultMcpEntryState) => Promise<boolean>;
};

export interface DefaultMcpSetupContext {
  db: Db;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  spec?: readonly DefaultMcpEntrySpec[];
  hooks?: Partial<Record<DefaultMcpSetupHookKey, DefaultMcpSetupHook>>;
  now?: () => Date;
  /** Company-template rollout scope (TECH-7271). Production uses the boot-frozen scope; tests inject one. */
  templateScope?: DefaultMcpTemplateContext["scope"];
  toolAccessOptions?: DefaultMcpTemplateContext["toolAccessOptions"];
}

class ClaimLostError extends Error {}

/**
 * Template-unavailable reasons that are ALWAYS reversible waits (they clear on their own or by an operator action
 * on the template list): no template yet, still provisioning, or a same-name collision.
 */
const TRANSIENT_TEMPLATE_REASONS: ReadonlySet<DefaultMcpSetupReason> = new Set<DefaultMcpSetupReason>([
  "template_not_found",
  "template_provisioning",
  "template_ambiguous",
]);

/**
 * After an agent already holds its stored credential, a PAPERCLIP-MANAGED template that is failed, expired or
 * unsupported (all terminal states of the managed claim) is bounded by the retry budget and ends in `error`.
 * An org-authored (user-managed) template is never terminal in that sense: it can be temporarily disabled or
 * edited and later restored, so every reason stays a reversible wait for it (no budget burned, no register or mint).
 */
function boundsCredentialHolder(unavailable: { reason: DefaultMcpSetupReason; managedTemplate: boolean }): boolean {
  return unavailable.managedTemplate && !TRANSIENT_TEMPLATE_REASONS.has(unavailable.reason);
}

/**
 * TECH-7390: every agent inherits its company's immutable visibility for comms-board
 * classification. An unclassified (NULL, pre-backfill) company is treated as private --
 * never silently upgraded to shared just because the column hasn't been backfilled yet.
 * This is the only place that mapping happens, so a regression here can't silently
 * classify an agent as shared.
 */
export function isCompanyVisibilityShared(visibility: CompanyVisibility | null): boolean {
  return visibility === "shared";
}

/** Thrown by the local stage when the template stops being usable after the pre-check. Carries the facts needed to classify it. */
class TemplateUnavailableError extends Error {
  constructor(
    readonly reason: DefaultMcpSetupReason,
    readonly managedTemplate: boolean,
  ) {
    super("template unavailable");
  }
}

/**
 * Claims one entry: a path-scoped `jsonb_set` of `setup` only, whose WHERE clause (pending and due,
 * or in progress with an expired lease) is evaluated against the CURRENT row. Exactly one caller on
 * any instance wins, and an owner bind or other concurrent write can never invalidate it.
 */
async function claimEntry(
  db: Pick<Db, "update">,
  agentId: string,
  key: string,
  now: Date,
): Promise<DefaultMcpEntryState | null> {
  const claimId = randomUUID();
  const nowIso = now.toISOString();
  const setupPath = entryPathSql(key, "setup");
  // Server-written ISO-8601 UTC strings compare correctly as text, so a malformed stored value can
  // never raise a cast error (it just compares arbitrarily and the entry is retried or ignored).
  const stamp = (field: string) => sql`coalesce(${agents.metadata} #>> ${entryPathSql(key, "setup", field)}, '') COLLATE "C"`;
  const attemptCountSql = sql`CASE WHEN (${agents.metadata} #>> ${entryPathSql(key, "setup", "attemptCount")}) ~ '^[0-9]{1,6}$' THEN (${agents.metadata} #>> ${entryPathSql(key, "setup", "attemptCount")})::int ELSE 0 END`;
  const patch = {
    state: "in_progress",
    reason: null,
    nextAttemptAt: null,
    leaseUntil: new Date(now.getTime() + DEFAULT_MCP_LEASE_MS).toISOString(),
    claimId,
    updatedAt: nowIso,
  };
  const rows = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(${agents.metadata}, ${setupPath}, (${agents.metadata} #> ${setupPath}) || ${JSON.stringify(patch)}::jsonb || jsonb_build_object('attemptCount', ${attemptCountSql} + 1), false)`,
    })
    .where(
      and(
        eq(agents.id, agentId),
        notInArray(agents.status, ["pending_approval", "terminated"]),
        sql`(
          (${agents.metadata} #>> ${entryPathSql(key, "setup", "state")} = 'pending' AND ${stamp("nextAttemptAt")} <= ${nowIso}::text COLLATE "C")
          OR (${agents.metadata} #>> ${entryPathSql(key, "setup", "state")} = 'in_progress' AND ${stamp("leaseUntil")} <= ${nowIso}::text COLLATE "C")
        )`,
      ),
    )
    .returning({ entry: sql<DefaultMcpEntryState>`${agents.metadata} #> ${entryPathSql(key)}` });
  return rows[0]?.entry ?? null;
}

export async function runDefaultMcpSetupForAgent(
  ctx: DefaultMcpSetupContext,
  input: { companyId: string; agentId: string },
): Promise<void> {
  const spec = ctx.spec ?? DEFAULT_MCP_SPEC;
  const hooks = ctx.hooks ?? DEFAULT_MCP_SETUP_HOOKS;
  const env = ctx.env ?? process.env;
  const fetchImpl = ctx.fetchImpl ?? tailnetAwareFetch;
  // Rollout scope (TECH-7271): the SAME trusted, boot-frozen predicate that bounds the company template
  // also bounds every per-agent claim, register and mint. A company outside the scope (including an empty or
  // malformed scope, which is none) is left completely untouched: no claim, no verify-ready write, no
  // external call, even when it already has a valid template. Existing ready entries and installs stay as is.
  if (!isCompanyInDefaultMcpTemplateScope(ctx.templateScope ?? readDefaultMcpTemplateScope(), input.companyId)) return;

  for (const entry of spec) {
    if (!entry.setupHook) continue;
    const hook = hooks[entry.setupHook];
    if (!hook) continue;

    const now = ctx.now?.() ?? new Date();
    // Company scope: the claim only matches an agent of THIS company.
    const [owned] = await ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .limit(1);
    if (!owned) continue;
    if (hook.verifyReady) {
      const [row] = await ctx.db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, input.agentId)).limit(1);
      const stored = readDefaultMcpState(row?.metadata)?.entries[entry.key];
      if (stored?.setup.state === "ready" && !(await hook.verifyReady(ctx.db, input.companyId, input.agentId, stored))) {
        // Wiring drifted since it was marked ready: back to pending (guarded on `ready`) for a local repair.
        await ctx.db
          .update(agents)
          .set({
            metadata: sql`jsonb_set(${agents.metadata}, ${entryPathSql(entry.key, "setup")}, (${agents.metadata} #> ${entryPathSql(entry.key, "setup")}) || ${JSON.stringify({ state: "pending", reason: null, nextAttemptAt: null, updatedAt: now.toISOString() })}::jsonb, false)`,
          })
          .where(and(eq(agents.id, input.agentId), sql`${agents.metadata} #>> ${entryPathSql(entry.key, "setup", "state")} = 'ready'`));
      }
    }
    const claimed = await claimEntry(ctx.db, input.agentId, entry.key, now);
    if (!claimed) continue;
    const claimId = claimed.setup.claimId!;

    let current = claimed;
    const checkpoint: DefaultMcpHookInput["checkpoint"] = async (patch, tx) => {
      const setup: EntryPatch["setup"] = { updatedAt: (ctx.now?.() ?? new Date()).toISOString() };
      if (patch.registerAttemptedAt) setup.registerAttemptedAt = patch.registerAttemptedAt;
      if (patch.mintAttemptedAt) setup.mintAttemptedAt = patch.mintAttemptedAt;
      const entryPatch: EntryPatch = { setup };
      if (patch.binding !== undefined) entryPatch.binding = patch.binding;
      if (patch.connectionId !== undefined) entryPatch.connectionId = patch.connectionId;
      if (!(await patchEntryUnderClaim(tx ?? ctx.db, input.agentId, entry.key, claimId, entryPatch))) throw new ClaimLostError();
      current = {
        ...current,
        connectionId: patch.connectionId === undefined ? current.connectionId : patch.connectionId,
        binding: patch.binding === undefined ? current.binding : patch.binding,
        setup: { ...current.setup, ...setup },
      };
    };

    let result: DefaultMcpHookResult;
    try {
      result = await hook({
        db: ctx.db,
        companyId: input.companyId,
        agentId: input.agentId,
        entry,
        current: () => current,
        checkpoint,
        env,
        fetchImpl,
      });
    } catch (err) {
      if (err instanceof ClaimLostError) continue;
      // Only the error class is logged: never a message, URL, header, or body.
      logger.warn(
        { agentId: input.agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        "default MCP setup hook failed",
      );
      result = { kind: "error", reason: "provisioner_failed" };
    }

    const finished = ctx.now?.() ?? new Date();
    const attempts = current.setup.attemptCount;
    let nextState: DefaultMcpEntryState["setup"]["state"];
    const reason: DefaultMcpSetupReason | null = result.reason ?? null;
    let nextAttemptAt: string | null = null;
    if (result.kind === "ready") nextState = "ready";
    else if (result.kind === "waiting") {
      nextState = "pending";
      nextAttemptAt = new Date(finished.getTime() + defaultMcpBackoffMs(attempts)).toISOString();
    } else if (result.kind === "retry") {
      if (attempts >= DEFAULT_MCP_MAX_ATTEMPTS) nextState = "error";
      else {
        nextState = "pending";
        nextAttemptAt = new Date(finished.getTime() + defaultMcpBackoffMs(attempts)).toISOString();
      }
    } else nextState = "error";

    const stored = await patchEntryUnderClaim(ctx.db, input.agentId, entry.key, claimId, {
      setup: { state: nextState, reason, nextAttemptAt, leaseUntil: null, claimId: null, updatedAt: finished.toISOString() },
    });
    if (!stored) continue;
    if (nextState === "ready" && current.installOnReady) {
      // The install was made with the connection; record it once and consume the marker so a later repair never
      // reinstalls something the agent's owner removed.
      const flipped = await ctx.db
        .update(agents)
        .set({
          metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, ${entryPathSql(entry.key, "enabled")}, 'true'::jsonb, false), ${entryPathSql(entry.key, "installOnReady")}, 'false'::jsonb, false)`,
        })
        .where(and(eq(agents.id, input.agentId), sql`${agents.metadata} #>> ${entryPathSql(entry.key, "installOnReady")} = 'true'`))
        .returning({ id: agents.id });
      if (flipped.length === 1) {
        await logActivity(ctx.db, {
          companyId: input.companyId,
          actorType: "system",
          actorId: "default-mcp-spec",
          action: "agent.default_mcp.dedicated_installed",
          entityType: "agent",
          entityId: input.agentId,
          // Non-secret facts only.
          details: { key: entry.key, connectionId: current.connectionId },
        });
      }
    }
    await logActivity(ctx.db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "default-mcp-spec",
      action: "agent.default_mcp.setup",
      entityType: "agent",
      entityId: input.agentId,
      // Non-secret facts only.
      details: {
        key: entry.key,
        state: nextState,
        reason,
        attemptCount: attempts,
        ownerUserId: current.ownerUserId,
        baseSub: current.binding?.baseSub ?? null,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Durable sweep + non-blocking scheduling
// ---------------------------------------------------------------------------

export const DEFAULT_MCP_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_MCP_SWEEP_LIMIT = 25;

export async function sweepDefaultMcpSetups(ctx: DefaultMcpSetupContext & { limit?: number }): Promise<number> {
  const now = (ctx.now?.() ?? new Date()).toISOString();
  // Same frozen rollout scope as the per-agent run: out-of-scope companies are excluded in the query itself
  // (so they can never occupy the batch), and a `none` scope selects nothing.
  const scope = ctx.templateScope ?? readDefaultMcpTemplateScope();
  if (scope.mode === "none") return 0;
  if (scope.mode === "allowlist" && scope.companyIds.length === 0) return 0;
  const scopeSql: SQL =
    scope.mode === "allowlist"
      ? sql`and a.company_id::text in (${sql.join(scope.companyIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  // Type-guarded in the function argument itself (a WHERE guard alone can be reordered by the
  // planner), and text-compared timestamps: one malformed legacy/forged row cannot abort the batch.
  const result: unknown = await ctx.db.execute(sql`
    select a.id as id, a.company_id as company_id
    from agents a
    where a.status not in ('pending_approval', 'terminated')
      ${scopeSql}
      and jsonb_typeof(a.metadata -> ${DEFAULT_MCP_METADATA_KEY}) = 'object'
      and exists (
        select 1 from jsonb_each(
          case when jsonb_typeof(a.metadata -> ${DEFAULT_MCP_METADATA_KEY} -> 'entries') = 'object'
               then a.metadata -> ${DEFAULT_MCP_METADATA_KEY} -> 'entries'
               else '{}'::jsonb end
        ) e(key, val)
        where (val -> 'setup' ->> 'state' = 'pending'
                and coalesce(val -> 'setup' ->> 'nextAttemptAt', '') COLLATE "C" <= ${now}::text COLLATE "C")
           or (val -> 'setup' ->> 'state' = 'in_progress'
                and coalesce(val -> 'setup' ->> 'leaseUntil', '') COLLATE "C" <= ${now}::text COLLATE "C")
      )
    order by a.updated_at asc
    limit ${ctx.limit ?? DEFAULT_MCP_SWEEP_LIMIT}
  `);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
    id: string;
    company_id: string;
  }>;
  for (const row of rows) {
    try {
      await runDefaultMcpSetupForAgent(ctx, { companyId: row.company_id, agentId: row.id });
    } catch (err) {
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP setup sweep item failed");
    }
  }
  return rows.length;
}

const inFlight = new Set<Promise<unknown>>();

/** Fire-and-observe: kicks setup after the create/approval commit without blocking the request. */
export function scheduleDefaultMcpSetup(db: Db, input: { companyId: string; agentId: string }, ctx: Omit<DefaultMcpSetupContext, "db"> = {}) {
  const run = new Promise<void>((resolve) => {
    setImmediate(() => {
      runDefaultMcpSetupForAgent({ db, ...ctx }, input)
        .catch((err) =>
          logger.warn({ agentId: input.agentId, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP setup failed"),
        )
        .finally(resolve);
    });
  });
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** Test seam: resolves once every scheduled setup has finished. */
export async function waitForScheduledDefaultMcpSetups(): Promise<void> {
  await waitForScheduledCompanyTemplates();
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/** Starts the backstop sweep (startup + every 60s, unref'd). No-op unless the feature flag is on. */
export function startDefaultMcpSetupSweep(db: Db, ctx: Omit<DefaultMcpSetupContext, "db"> = {}): () => void {
  if (!isDefaultMcpSpecEnabled(ctx.env ?? process.env)) return () => {};
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    // The company template sweep runs BEFORE the agent sweep, under the same flag and the same running guard,
    // so a newly provisioned template is usable by the agents swept in the same tick.
    sweepCompanyTemplates({
      db,
      env: ctx.env,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
      spec: ctx.spec,
      scope: ctx.templateScope,
      toolAccessOptions: ctx.toolAccessOptions,
    })
      .catch((err) => logger.warn({ errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP template sweep failed"))
      .then(() => sweepDefaultMcpSetups({ db, ...ctx }))
      .catch((err) => logger.warn({ errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP setup sweep failed"))
      // After setup, so an entry that just became ready is installed in the same tick (`installByDefault`).
      .then(() => sweepDefaultInstalls(db, { env: ctx.env, spec: ctx.spec }))
      .catch((err) => logger.warn({ errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP install reconcile sweep failed"))
      // After setup, so an entry that just became ready is bound in the same tick (TECH-7693).
      .then(() => sweepBrainBindings(db, { env: ctx.env, fetchImpl: ctx.fetchImpl, now: ctx.now }))
      .catch((err) => logger.warn({ errorClass: err instanceof Error ? err.constructor.name : typeof err }, "arcana brain binding sweep failed"))
      // After setup and binding, so an agent that just became ready gets its daily one-pager routine (TECH-7713).
      .then(() => sweepAgentProfileRoutines(db, { env: ctx.env }))
      .catch((err) => logger.warn({ errorClass: err instanceof Error ? err.constructor.name : typeof err }, "agent profile routine sweep failed"))
      // Memory tokens expire after 90 days: rotate those inside the window (no-op unless agent memory is configured).
      .then(() => sweepAgentMemoryRotation(db, { env: ctx.env, fetchImpl: ctx.fetchImpl, now: ctx.now }))
      .catch((err) => logger.warn({ errorClass: err instanceof Error ? err.constructor.name : typeof err }, "agent memory rotation sweep failed"))
      .finally(() => {
        running = false;
      });
  };
  const startup = setImmediate(tick);
  const timer = setInterval(tick, DEFAULT_MCP_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearImmediate(startup);
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// Hook: comms_board_identity
// ---------------------------------------------------------------------------

/**
 * Owner for an agent that another AGENT creates (no human actor exists on that request). The new agent inherits the
 * creating agent's own frozen comms-board owner, but only while that user is still an active member of THIS company
 * with a resolvable email. Anything else (no creator, creator in another company, creator without an owner, owner no
 * longer a member) is `null`, exactly the previous behavior: never a company-wide default, never a guess.
 */
export async function resolveCreatorOwnerUserId(
  db: DbLike,
  companyId: string,
  creatorAgentId: string | null | undefined,
): Promise<string | null> {
  if (!creatorAgentId) return null;
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, creatorAgentId), eq(agents.companyId, companyId)))
    .limit(1);
  const ownerUserId = readDefaultMcpState(row?.metadata)?.entries["comms-board"]?.ownerUserId ?? null;
  if (!ownerUserId) return null;
  if (!(await ownerEmailFor(db as unknown as Db, companyId, ownerUserId))) return null;
  // The spec describes the owner as a verified human: inheriting never relaxes that.
  const [user] = await db.select({ emailVerified: authUsers.emailVerified }).from(authUsers).where(eq(authUsers.id, ownerUserId)).limit(1);
  return user?.emailVerified ? ownerUserId : null;
}

/** Read-only template lookup by the FROZEN template key. Returns a waiting reason when it can't be used. */
export async function resolveTemplate(
  db: Pick<Db, "select">,
  companyId: string,
  name: string,
  reviewed?: { version: number; allow: readonly string[] } | null,
): Promise<{ template: Connection } | { reason: DefaultMcpSetupReason; managedTemplate: boolean }> {
  const rows = await db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, name), ne(toolConnections.status, "archived")));
  if (rows.length === 0) return { reason: "template_not_found", managedTemplate: false };
  if (rows.length > 1) return { reason: "template_ambiguous", managedTemplate: false };
  const template = rows[0]!;
  const managedTemplate = isManagedTemplate(template.config);
  // The Paperclip-provisioned template (TECH-7271) is cloned only once it is verified ready: still
  // provisioning, failed, expired or drifted templates wait with a specific reason and are never cloned.
  if (isManagedTemplate(template.config)) {
    // A managed template is cloned only against its reviewed allowlist; with none, fail closed.
    if (!reviewed || reviewed.allow.length === 0) return { reason: "template_unsupported", managedTemplate };
    const usable = await managedTemplateUsability(db, template, {
      expectedAllowlistVersion: reviewed?.version ?? null,
      allowedTools: reviewed?.allow,
    });
    if (!usable.ok) return { reason: usable.reason, managedTemplate };
  }
  // An org opts in by providing an active, api-key MCP template that already carries a header credential ref.
  const header = (template.credentialRefs ?? []).find((ref) => ref.placement === "header");
  if (template.status !== "active" || template.authKind !== "api_key" || template.transport !== "mcp_remote" || !header) {
    return { reason: "template_unsupported", managedTemplate };
  }
  return { template };
}

/** Deterministic, company-scoped name: the org template name plus the agent UUID. */
export const dedicatedConnectionName = (templateName: string, agentId: string) => `${templateName}:${agentId}`;

/**
 * Copies the template's catalog and access profile onto the dedicated connection, completely and
 * idempotently (every insert is conflict-safe and missing pieces are filled in on a retry), and
 * gives ONLY this agent access. Quarantine/review status is copied as-is; the profile is always
 * default-deny. Access is not an install: the agent sees the app "permitted but not installed".
 */
export async function cloneTemplateAccess(
  db: Db,
  template: Connection,
  dedicated: Connection,
  agentId: string,
  /**
   * Reviewed allowlist of a managed template (present for every managed template, possibly empty: never "undefined
   * means everything"). The clone can never carry anything outside it, including on a re-run over an existing clone.
   */
  allow?: ReadonlySet<string>,
) {
  const templateEntries = await db
    .select()
    .from(toolCatalogEntries)
    .where(and(eq(toolCatalogEntries.companyId, template.companyId), eq(toolCatalogEntries.connectionId, template.id)))
    .orderBy(asc(toolCatalogEntries.name));
  for (const entry of templateEntries) {
    const { id: _id, ...rest } = entry;
    // Defense in depth against a mutated managed template: an action outside the reviewed allowlist is cloned DISABLED.
    const outside = allow !== undefined && !allow.has(entry.toolName);
    await db
      .insert(toolCatalogEntries)
      .values({ ...rest, ...(outside ? { status: "disabled" as const, quarantinedAt: null, quarantineReason: null } : {}), connectionId: dedicated.id })
      .onConflictDoNothing();
  }
  if (allow !== undefined) {
    // A re-run (retry) over an EXISTING clone: `onConflictDoNothing` above never touches an existing row, so any
    // action outside the allowlist that is not already disabled is downgraded here. Only ever narrows.
    await db
      .update(toolCatalogEntries)
      .set({ status: "disabled", quarantinedAt: null, quarantineReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(toolCatalogEntries.companyId, template.companyId),
          eq(toolCatalogEntries.connectionId, dedicated.id),
          ne(toolCatalogEntries.status, "disabled"),
          ...(allow.size > 0 ? [notInArray(toolCatalogEntries.toolName, [...allow])] : []),
        ),
      );
  }
  const dedicatedEntries = await db
    .select({ id: toolCatalogEntries.id, name: toolCatalogEntries.name, toolName: toolCatalogEntries.toolName })
    .from(toolCatalogEntries)
    .where(and(eq(toolCatalogEntries.companyId, template.companyId), eq(toolCatalogEntries.connectionId, dedicated.id)));
  const dedicatedIdByName = new Map(dedicatedEntries.map((entry) => [entry.name, entry.id]));
  const idMap = new Map(templateEntries.map((entry) => [entry.id, dedicatedIdByName.get(entry.name) ?? null]));

  const [templateProfile] = await db
    .select()
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, template.companyId), eq(toolProfiles.profileKey, `app:${template.id}`)))
    .limit(1);
  if (!templateProfile) return;
  await db
    .insert(toolProfiles)
    .values({
      companyId: template.companyId,
      profileKey: `app:${dedicated.id}`,
      name: dedicated.name,
      description: `Access profile for ${dedicated.name}.`,
      status: "active",
      defaultAction: "deny",
      metadata: { source: "app_gallery_finish", connectionId: dedicated.id },
    })
    .onConflictDoNothing();
  const [profile] = await db
    .select()
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, template.companyId), eq(toolProfiles.profileKey, `app:${dedicated.id}`)))
    .limit(1);
  if (!profile) throw new Error("dedicated profile missing");

  const signature = (entry: { selectorType: string; effect: string; catalogEntryId: string | null; toolName: string | null; riskLevel: string | null; connectionId: string | null }) =>
    [entry.selectorType, entry.effect, entry.catalogEntryId, entry.toolName, entry.riskLevel, entry.connectionId].join("|");
  let existing = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
  if (allow !== undefined) {
    // Stale entries of an existing clone profile (anything but an include of an allowlisted action of this clone) go.
    const allowedDedicatedIds = new Set(dedicatedEntries.filter((row) => allow.has(row.toolName)).map((row) => row.id));
    const stale = existing.filter(
      (row) => !(row.selectorType === "catalog_entry" && row.effect === "include" && row.catalogEntryId && allowedDedicatedIds.has(row.catalogEntryId)),
    );
    if (stale.length > 0) {
      await db.delete(toolProfileEntries).where(inArray(toolProfileEntries.id, stale.map((row) => row.id)));
      existing = existing.filter((row) => !stale.includes(row));
    }
  }
  const have = new Set(existing.map(signature));
  const wanted = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, templateProfile.id));
  const allowedTemplateIds = new Set(templateEntries.filter((row) => allow === undefined || allow.has(row.toolName)).map((row) => row.id));
  for (const entry of wanted) {
    // For a managed template only an include of an allowlisted action of the template is ever copied.
    if (
      allow !== undefined &&
      !(entry.selectorType === "catalog_entry" && entry.effect === "include" && entry.catalogEntryId && allowedTemplateIds.has(entry.catalogEntryId))
    ) {
      continue;
    }
    const { id: _id, profileId: _profileId, ...rest } = entry;
    const mapped = {
      ...rest,
      profileId: profile.id,
      connectionId: entry.connectionId === template.id ? dedicated.id : entry.connectionId,
      catalogEntryId: entry.catalogEntryId ? (idMap.get(entry.catalogEntryId) ?? null) : null,
    };
    // A template include whose action has no counterpart is skipped, never widened.
    if (entry.catalogEntryId && !mapped.catalogEntryId) continue;
    if (have.has(signature(mapped))) continue;
    await db.insert(toolProfileEntries).values(mapped);
    have.add(signature(mapped));
  }
  // Permission (not install) for this agent only. The binding is server-tagged, so the existing
  // precedence treats it as an additive app offering and it never drops company-bound profiles.
  await db
    .insert(toolProfileBindings)
    .values({ companyId: template.companyId, profileId: profile.id, targetType: "agent", targetId: agentId, priority: 100, metadata: { source: "default_mcp_spec", connectionId: dedicated.id } })
    .onConflictDoNothing();
}

/**
 * The whole local stage in ONE transaction: dedicated connection (find or clone), catalog + profile
 * copy, grant upsert, credential bindings, and the claim-guarded checkpoint. No network inside. The
 * per-agent advisory lock serializes a retry against a lease takeover, since connection names are
 * not unique in the database.
 */
async function ensureDedicatedStage(
  input: DefaultMcpHookInput,
  templateName: string,
  binding: DefaultMcpBindingRef,
  ownerUserId: string | null,
  credentialLabel = "Comms board token",
): Promise<void> {
  const { db, companyId, agentId } = input;
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await txDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"paperclip:default-mcp:dedicated:" + agentId}, 0))`);

    const resolved = await resolveTemplate(txDb, companyId, templateName, input.entry.reviewedTools);
    if ("reason" in resolved) throw new TemplateUnavailableError(resolved.reason, resolved.managedTemplate);
    const template = resolved.template;
    const name = dedicatedConnectionName(template.name, agentId);
    const known = input.current().connectionId;
    const existing = await txDb
      .select()
      .from(toolConnections)
      .where(
        known
          ? and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, known))
          : and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, name), ne(toolConnections.status, "archived")),
      );
    if (existing.length > 1) throw new Error("ambiguous dedicated connection");
    let dedicated = existing[0];
    if (dedicated && (dedicated.name !== name || dedicated.credentialPolicy !== "per_agent")) throw new Error("unexpected dedicated connection");
    if (!dedicated) {
      const templateRef = (template.credentialRefs ?? []).find((ref) => ref.placement === "header")!;
      dedicated = await toolAccessService(txDb).cloneConnectionFromTemplate(txDb, template, {
        name,
        credentialRefs: [{ ...templateRef, secretId: binding.secretId!, version: "latest" }],
        // A clone of ANY static-catalog template of ours (by its fixed uid) carries the server-owned marker explicitly (it also inherits it from
        // the template's config): refresh then keeps exactly the reviewed verbs active and never adds others.
        configOverlay: {
          mcpSessionRequired: true,
          ...(isArcanaStaticTemplate(template) ? { [DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY]: input.entry.key } : {}),
        },
      });
    }
    await cloneTemplateAccess(
      txDb,
      template,
      dedicated,
      agentId,
      // Fail closed: a managed template without a reviewed allowlist clones NOTHING as usable (empty allowlist).
      isManagedTemplate(template.config) ? new Set(input.entry.reviewedTools?.allow ?? []) : undefined,
    );

    const headerRefs = (dedicated.credentialRefs ?? []).filter((ref) => ref.placement === "header");
    // More than one header ref makes the credential mapping ambiguous: never pick one.
    if (headerRefs.length !== 1) throw new Error("dedicated connection must have exactly one header credential ref");
    let headerRef = headerRefs[0]!;
    if (headerRef.secretId !== binding.secretId) {
      // The agent's own vault secret is authoritative: point the connection's ref back at it.
      headerRef = { ...headerRef, secretId: binding.secretId! };
      const credentialRefs = dedicated.credentialRefs.map((ref) => (ref.placement === "header" ? headerRef : ref));
      const [fixed] = await txDb
        .update(toolConnections)
        .set({ credentialRefs, updatedAt: new Date() })
        .where(eq(toolConnections.id, dedicated.id))
        .returning();
      dedicated = fixed!;
    }
    const secretRef = {
      secretId: binding.secretId!,
      versionSelector: "latest" as const,
      configPath: credentialRefConfigPath(headerRef),
      required: true,
      label: credentialLabel,
    };
    const [grant] = await txDb
      .insert(connectionGrants)
      .values({
        companyId,
        connectionId: dedicated.id,
        kind: "agent",
        subjectAgentId: agentId,
        credentialSecretRefs: [secretRef],
        status: "active",
        createdByUserId: ownerUserId,
      })
      .onConflictDoUpdate({
        target: [connectionGrants.connectionId, connectionGrants.subjectAgentId],
        set: { credentialSecretRefs: [secretRef], status: "active", revokedAt: null, updatedAt: new Date() },
      })
      .returning({ id: connectionGrants.id });
    // The connection ref and the grant ref are the same secret at the same config path, so the
    // existing binding sync collapses them into one binding for this single agent/connection.
    await syncConnectionCredentialBindings(txDb, dedicated);
    // New default-ON agents: the agent's OWN dedicated connection is installed in the same transaction, so `ready`
    // always means installed. Idempotent; never the org template or another agent's connection.
    if (input.current().installOnReady) {
      await toolAccessService(txDb).addAgentConnectionInstall(txDb, dedicated, agentId, undefined, {
        install: true,
        bindingSource: "default_mcp_spec",
      });
    }
    await input.checkpoint({ binding: { ...binding, connectionId: dedicated.id, grantId: grant!.id }, connectionId: dedicated.id }, txDb);
  });
}

const OWNER_REQUIRED_WARN_ATTEMPTS = 24;

export const commsBoardIdentityHook: DefaultMcpSetupHook = async (input) => {
  const { db, companyId, agentId, entry } = input;
  const current = input.current();
  const templateName = current.templateKey || entry.connectionName; // the FROZEN key, never today's spec
  let binding = current.binding;

  if (!binding?.secretId) {
    // Checkpoints without their result mean a previous attempt's POST outcome is unknown. Terminal.
    if (current.setup.mintAttemptedAt) return { kind: "error", reason: "mint_unknown" };
    if (current.setup.registerAttemptedAt && !binding?.boardAgentId) return { kind: "error", reason: "board_unknown" };
  }

  // Everything that can be missing is checked BEFORE any external call, so waiting before the first call never leaves
  // an orphan. If the template becomes unusable AFTER the register/mint, managed failed/expired/unsupported states
  // share the normal eight-attempt budget, including earlier claim waits; transient managed states and every
  // org-authored-template state remain reversible waits. No register or mint is repeated either way.
  // `input.env` is the global process.env in production, which resolves to the boot snapshot (the tokens
  // are scrubbed from the live environment, TECH-7228); a genuinely injected env object is converted purely.
  const ownerEmail = current.ownerUserId ? await ownerEmailFor(db, companyId, current.ownerUserId) : null;
  if (!binding?.secretId && !ownerEmail) {
    // Retries are about hourly, so 24 attempts is roughly a day: warn once per ~day, not on every attempt. Only a log
    // line: no state or cadence change. `ownerAssigned` separates "never had an owner" from "owner no longer eligible".
    const attempts = current.setup.attemptCount;
    if (attempts >= OWNER_REQUIRED_WARN_ATTEMPTS && attempts % OWNER_REQUIRED_WARN_ATTEMPTS === 0) {
      logger.warn(
        { agentId, companyId, attemptCount: attempts, ownerAssigned: Boolean(current.ownerUserId) },
        "comms-board setup has been waiting for an eligible owner for about a day or more (owner_required)",
      );
    }
    return { kind: "waiting", reason: "owner_required" };
  }
  const resolvedConfig = resolveCommsBoardProvisionerConfig(input.env);
  const config = resolvedConfig.ok ? resolvedConfig.config : null;
  if (!binding?.secretId && !resolvedConfig.ok) return { kind: "waiting", reason: resolvedConfig.reason };
  const resolved = await resolveTemplate(db, companyId, templateName, entry.reviewedTools);
  if ("reason" in resolved) {
    // Before a credential exists nothing external has happened, so every reason may wait. Once a token is stored,
    // managed failed/expired/unsupported states share the normal eight-attempt budget (including earlier claim
    // waits) and can end in `error`; that state does not revoke or delete the existing credential or binding. An
    // org-authored template remains a reversible, uncapped wait while disabled or edited. No register or mint is
    // ever repeated either way.
    return binding?.secretId && boundsCredentialHolder(resolved)
      ? { kind: "retry", reason: resolved.reason }
      : { kind: "waiting", reason: resolved.reason };
  }

  if (!binding?.secretId) {
    if (!binding?.boardAgentId) {
      const [agentRow] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .limit(1);
      const identityGeneration = current.identityGeneration ?? 0;
      const identity = composeCommsBoardIdentity(agentId, identityGeneration);
      if (!identity) return { kind: "error", reason: "invalid_subject" };
      const [companyRow] = await db
        .select({ visibility: companies.visibility })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      // TECH-7390: a missing row here means the agent's companyId no longer
      // resolves to a company -- a data-integrity problem (the agent-company FK
      // makes this unlikely, but not impossible), distinct from a found row with
      // NULL (pre-backfill, unclassified) visibility. Don't silently fold the two
      // together into "private"; surface the former as an error.
      if (!companyRow) return { kind: "error", reason: "invalid_subject" };
      const registered = await registerCommsBoardAgent(
        config!,
        {
          boardSub: identity.boardSub,
          displayName: composeCommsBoardDisplayName(agentRow?.name, agentId, identityGeneration),
          ownerEmail: ownerEmail!,
          isShared: isCompanyVisibilityShared(companyRow.visibility),
        },
        input.fetchImpl,
        {
          beforeToolCall: async () => {
            // Pre-call checkpoint: written only AFTER handshake, before the non-idempotent tool call.
            await input.checkpoint({ registerAttemptedAt: new Date().toISOString() });
          },
        },
      );
      if (!registered.ok) {
        if (registered.retryable || registered.reason === "provisioner_failed") {
          return { kind: "retry", reason: registered.reason };
        }
        return { kind: "error", reason: registered.reason };
      }
      binding = {
        boardAgentId: registered.boardAgentId,
        baseSub: identity.baseSub,
        agentKey: null,
        boardSub: identity.boardSub,
        secretId: null,
        secretVersion: null,
        connectionId: null,
        grantId: null,
        tokenExpiresAt: null,
      };
      await input.checkpoint({ binding });
    }

    await input.checkpoint({ mintAttemptedAt: new Date().toISOString() });
    const minted = await mintCommsBoardCredential(config!, { baseSub: binding.baseSub, ownerEmail: ownerEmail! }, input.fetchImpl);
    if (!minted.ok) return { kind: "error", reason: minted.reason };

    let secretId: string;
    try {
      // A crash or a restarted setup can leave this agent's own secret behind. `getByKey` hides soft-deleted rows, so
      // look at every row for the key: an active live one is rotated to the token just minted (the old value belongs
      // to an identity this entry no longer holds); one that is not active was revoked on purpose and is never revived.
      const secretKey = `comms_board.${agentId}`;
      const rows = await db
        .select({ id: companySecrets.id, status: companySecrets.status, deletedAt: companySecrets.deletedAt, latestVersion: companySecrets.latestVersion })
        .from(companySecrets)
        .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, secretKey)));
      if (rows.length > 1) return { kind: "error", reason: "secret_unavailable" };
      const existing = rows[0];
      if (existing) {
        if (existing.status !== "active" || existing.deletedAt) return { kind: "error", reason: "secret_unavailable" };
        await secretService(db).rotate(
          existing.id,
          { value: minted.boardToken, expectedLatestVersion: existing.latestVersion },
          { userId: current.ownerUserId },
        );
        secretId = existing.id;
      } else {
        const secret = await secretService(db).create(
          companyId,
          {
            name: `Comms Board token (agent ${agentId})`,
            key: secretKey,
            provider: "local_encrypted",
            value: minted.boardToken,
            description: `Managed comms-board token for agent ${agentId}. Provisioned at agent creation.`,
          },
          { userId: current.ownerUserId },
        );
        secretId = secret.id;
      }
    } catch (err) {
      // The token cannot be fetched again; the identity stays on the entry so the orphan is identifiable.
      // Only the error class is logged: never a message, key or value.
      logger.warn(
        { agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        "comms board token storage failed",
      );
      return { kind: "error", reason: "secret_store_failed" };
    }
    binding = { ...binding, secretId, secretVersion: "latest", tokenExpiresAt: minted.tokenExpiresAt, commsScopeVersion: COMMS_BOARD_TOKEN_SCOPES_VERSION };
    await input.checkpoint({ binding });
  }

  // A deleted/disabled vault secret is an intentionally revoked credential: never re-minted or recreated.
  if (binding?.secretId && !(await vaultSecretUsable(db, companyId, binding.secretId))) {
    return { kind: "error", reason: "secret_unavailable" };
  }

  // Secret stored: the rest is one local, idempotent, retryable transaction (no external call).
  try {
    await ensureDedicatedStage(input, templateName, binding, current.ownerUserId);
    return { kind: "ready" };
  } catch (err) {
    if (err instanceof ClaimLostError) throw err;
    // The template became unusable after the pre-check. The classification is the same as the pre-check's: a terminal
    // state of a managed template is a bounded retry (ends in `error` once the shared budget is spent); everything
    // else is a reversible wait. Either way nothing external is repeated: the stored secret and binding are kept.
    if (err instanceof TemplateUnavailableError) {
      return boundsCredentialHolder(err) ? { kind: "retry", reason: err.reason } : { kind: "waiting", reason: err.reason };
    }
    // Only the error class is logged: never a message, URL, header, token or body.
    logger.warn(
      { agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
      "default MCP dedicated stage failed",
    );
    return { kind: "retry", reason: "binding_failed" };
  }
};

// ---------------------------------------------------------------------------
// Hook: arcana_brain (TECH-7252)
// ---------------------------------------------------------------------------

/**
 * Gives a new agent its private Arcana brain and a per-agent exchange key.
 *
 * Order is what makes this safe to retry: the exchange key is generated here and stored FIRST as the agent's vault
 * secret, only its sha256 is sent to Arcana, and Arcana's provision route is idempotent (a replay returns 200). So an
 * unknown outcome is simply retried with the same hash; there is no orphan key and no "unknown outcome" terminal
 * state. The local stage (dedicated connection, grant, credential binding) is the same one the comms hook uses, so
 * the key is bound to this one agent only. Nothing here logs or persists the key; metadata holds ids only.
 */
export const arcanaBrainHook: DefaultMcpSetupHook = async (input) => {
  const { db, companyId, agentId, entry } = input;
  const current = input.current();
  const templateName = current.templateKey || entry.connectionName; // the FROZEN key, never today's spec
  let binding = current.binding;

  const identity = composeArcanaBrainIdentity(companyId, agentId);
  if (!identity) return { kind: "error", reason: "invalid_subject" };
  const resolvedConfig = resolveArcanaProvisionerConfig(input.env);
  if (!resolvedConfig.ok) return { kind: "waiting", reason: resolvedConfig.reason };

  // Everything that can be missing is checked BEFORE any secret or external call, so waiting never leaves an orphan.
  const resolved = await resolveTemplate(db, companyId, templateName, entry.reviewedTools);
  if ("reason" in resolved) {
    return binding?.secretId && boundsCredentialHolder(resolved)
      ? { kind: "retry", reason: resolved.reason }
      : { kind: "waiting", reason: resolved.reason };
  }

  const secrets = secretService(db);
  if (!binding?.secretId) {
    const secretKey = `arcana_brain.${agentId}`;
    let secretId: string;
    try {
      // `getByKey` hides soft-deleted rows, so look at EVERY row for this key. A secret that exists but is not
      // active and live was revoked on purpose: never revived, never replaced. Only a key that has never had a
      // secret (a crash between create and checkpoint leaves an ACTIVE one, which is reused) gets a new one.
      const rows = await db
        .select({ id: companySecrets.id, status: companySecrets.status, deletedAt: companySecrets.deletedAt })
        .from(companySecrets)
        .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, secretKey)));
      if (rows.length > 1) return { kind: "error", reason: "secret_unavailable" };
      const existing = rows[0];
      if (existing) {
        if (existing.status !== "active" || existing.deletedAt) return { kind: "error", reason: "secret_unavailable" };
        secretId = existing.id;
      } else {
        const created = await secrets.create(
          companyId,
          {
            name: `Arcana exchange key (agent ${agentId})`,
            key: secretKey,
            provider: "local_encrypted",
            value: randomBytes(36).toString("base64url"),
            description: `Managed Arcana exchange key for agent ${agentId}. Provisioned at agent creation.`,
          },
          { userId: current.ownerUserId },
        );
        secretId = created.id;
      }
    } catch (err) {
      // Only the error class is logged: never a message, key or value.
      logger.warn(
        { agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        "arcana brain exchange key storage failed",
      );
      return { kind: "retry", reason: "secret_store_failed" };
    }
    binding = {
      boardAgentId: null,
      baseSub: identity.agentPrincipalId,
      agentKey: null,
      boardSub: null,
      secretId,
      secretVersion: "latest",
      connectionId: null,
      grantId: null,
      tokenExpiresAt: null,
    };
    await input.checkpoint({ binding });
  }

  // A deleted/disabled vault secret is an intentionally revoked credential: never recreated.
  if (!(await vaultSecretUsable(db, companyId, binding.secretId!))) return { kind: "error", reason: "secret_unavailable" };

  let exchangeKeyHash: string;
  try {
    exchangeKeyHash = sha256Hex(await secrets.resolveSecretValue(companyId, binding.secretId!, "latest"));
  } catch {
    return { kind: "error", reason: "secret_unavailable" };
  }
  const provisioned = await provisionArcanaBrain(
    resolvedConfig.config,
    {
      agentPrincipalId: identity.agentPrincipalId,
      companyId: identity.companyId,
      runtimeId: identity.runtimeId,
      exchangeKeyHash,
    },
    input.fetchImpl,
  );
  if (!provisioned.ok) return provisioned.retryable ? { kind: "retry", reason: provisioned.reason } : { kind: "error", reason: provisioned.reason };

  // Persist what was used and what Arcana returned (TECH-7693); the dedicated stage's checkpoint carries it.
  binding = { ...binding, arcanaRuntimeId: identity.runtimeId, arcanaBrainId: provisioned.brainId, arcanaRecipeVersion: ARCANA_IDENTITY_RECIPE_VERSION };

  try {
    await ensureDedicatedStage(input, templateName, binding, current.ownerUserId, "Arcana brain exchange key");
    return { kind: "ready" };
  } catch (err) {
    if (err instanceof ClaimLostError) throw err;
    if (err instanceof TemplateUnavailableError) {
      return boundsCredentialHolder(err) ? { kind: "retry", reason: err.reason } : { kind: "waiting", reason: err.reason };
    }
    logger.warn(
      { agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
      "default MCP dedicated stage failed",
    );
    return { kind: "retry", reason: "binding_failed" };
  }
};

// ---------------------------------------------------------------------------
// Hook: agent_memory_tools (TECH-8832)
// ---------------------------------------------------------------------------

/**
 * Gives a Claude or Codex agent explicit memory tools: its own dedicated gateway connection to the memory service's MCP
 * endpoint. The token is the one the `agent-memory` entry already minted and stored (`agent_memory.<agentId>`), so
 * nothing is minted here, the secret stays single and rotation (which rewrites that secret in place) reaches the gateway
 * connection too. The hook waits until that entry is ready, then runs the same local stage as the other dedicated entries.
 */
export const agentMemoryToolsHook: DefaultMcpSetupHook = async (input) => {
  const { db, companyId, agentId, entry } = input;
  const current = input.current();
  const templateName = current.templateKey || entry.connectionName; // the FROZEN key, never today's spec
  let binding = current.binding;

  if (!agentMemoryToolsEnabled(input.env)) return { kind: "waiting", reason: "provisioner_not_configured" };

  const [agentRow] = await db
    .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  if (!agentRow || !agentMemoryToolsHarness(agentRow.adapterType, agentRow.adapterConfig)) return { kind: "error", reason: "adapter_unsupported" };

  // The memory token comes from the agent's own agent-memory entry; until that is ready there is nothing to bind.
  const memory = readDefaultMcpState(agentRow.metadata)?.entries[AGENT_MEMORY_ENTRY_KEY];
  const memorySecretId = memory?.setup.state === "ready" ? memory.binding?.secretId : null;
  if (!memorySecretId) return { kind: "waiting", reason: "memory_token_unavailable" };

  if (binding?.secretId !== memorySecretId) {
    binding = {
      boardAgentId: null,
      baseSub: memory!.binding?.baseSub ?? `agent-memory-${agentId.toLowerCase()}`,
      agentKey: null,
      boardSub: null,
      secretId: memorySecretId,
      secretVersion: "latest",
      // Kept when the secret id changed under an existing connection: the stage re-points its header ref.
      connectionId: binding?.connectionId ?? null,
      grantId: binding?.grantId ?? null,
      tokenExpiresAt: memory!.binding?.tokenExpiresAt ?? null,
    };
    await input.checkpoint({ binding });
  }

  // A deleted or disabled secret is an intentionally revoked credential.
  if (!(await vaultSecretUsable(db, companyId, binding.secretId!))) return { kind: "error", reason: "secret_unavailable" };

  const resolved = await resolveTemplate(db, companyId, templateName, entry.reviewedTools);
  if ("reason" in resolved) {
    return binding.connectionId && boundsCredentialHolder(resolved)
      ? { kind: "retry", reason: resolved.reason }
      : { kind: "waiting", reason: resolved.reason };
  }

  try {
    await ensureDedicatedStage(input, templateName, binding, current.ownerUserId, "Agent memory token");
    return { kind: "ready" };
  } catch (err) {
    if (err instanceof ClaimLostError) throw err;
    if (err instanceof TemplateUnavailableError) {
      return boundsCredentialHolder(err) ? { kind: "retry", reason: err.reason } : { kind: "waiting", reason: err.reason };
    }
    logger.warn(
      { agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
      "default MCP dedicated stage failed",
    );
    return { kind: "retry", reason: "binding_failed" };
  }
};

export const DEFAULT_MCP_SETUP_HOOKS: Partial<Record<DefaultMcpSetupHookKey, DefaultMcpSetupHook>> = {
  comms_board_identity: commsBoardIdentityHook,
  arcana_brain: arcanaBrainHook,
  // Deferred: agent-memory imports the agent service, which (through agent-hiring) imports this module. Reading the
  // binding eagerly here could hit it before initialization when agent-hiring loads first.
  agent_memory: (input) => agentMemoryHook(input),
  agent_memory_tools: agentMemoryToolsHook,
};

/** The wiring a READY comms entry depends on, checked against the real rows (local reads only). */
export async function commsWiringIntact(db: Pick<Db, "select">, companyId: string, agentId: string, entry: DefaultMcpEntryState): Promise<boolean> {
  const binding = entry.binding;
  if (!binding?.secretId || !binding.connectionId || !binding.grantId) return false;
  const [connection] = await db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.id, binding.connectionId), eq(toolConnections.companyId, companyId)))
    .limit(1);
  if (!connection || connection.credentialPolicy !== "per_agent" || connection.status === "archived") return false;
  const headers = (connection.credentialRefs ?? []).filter((ref) => ref.placement === "header");
  if (headers.length !== 1 || headers[0]!.secretId !== binding.secretId) return false;
  const [grant] = await db
    .select()
    .from(connectionGrants)
    .where(
      and(
        eq(connectionGrants.id, binding.grantId),
        eq(connectionGrants.companyId, companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "agent"),
        eq(connectionGrants.subjectAgentId, agentId),
        eq(connectionGrants.status, "active"),
      ),
    )
    .limit(1);
  if (!grant || grant.credentialSecretRefs.length !== 1) return false;
  const ref = grant.credentialSecretRefs[0]!;
  if (ref.secretId !== binding.secretId || ref.configPath !== credentialRefConfigPath(headers[0]!)) return false;
  return vaultSecretUsable(db, companyId, binding.secretId);
}

/** The vault secret must exist in this company and be active and not soft-deleted (the secret service's own validity fields). */
async function vaultSecretUsable(db: Pick<Db, "select">, companyId: string, secretId: string): Promise<boolean> {
  const [secret] = await db
    .select({ id: companySecrets.id })
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.id, secretId),
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(secret);
}

commsBoardIdentityHook.verifyReady = (db, companyId, agentId, entry) => commsWiringIntact(db, companyId, agentId, entry);
arcanaBrainHook.verifyReady = (db, companyId, agentId, entry) => commsWiringIntact(db, companyId, agentId, entry);
agentMemoryToolsHook.verifyReady = (db, companyId, agentId, entry) => commsWiringIntact(db, companyId, agentId, entry);

/**
 * Fail-closed, validated lookup of an agent's comms-board binding for the wake bridge: the agent
 * must belong to `companyId`, the entry must be ready, the dedicated connection, its single header
 * path, the ACTIVE agent grant and the vault secret must all agree, and the token must not be
 * expired. Returns ids only; the token is never exported. (The pure `readCommsBoardBindingReference`
 * only reads metadata and is advisory.)
 */
export async function resolveCommsBoardBinding(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
  now: Date = new Date(),
): Promise<DefaultMcpBindingRef | null> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  const entry = readDefaultMcpState(row?.metadata)?.entries["comms-board"];
  if (!entry || entry.setup.state !== "ready" || !entry.binding) return null;
  if (entry.binding.tokenExpiresAt && Date.parse(entry.binding.tokenExpiresAt) <= now.getTime()) return null;
  if (!(await commsWiringIntact(db, companyId, agentId, entry))) return null;
  return { ...entry.binding };
}
