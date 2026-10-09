import { agentAppearanceSchema, resolveAgentAppearance, agentAvatarUrl } from "@paperclipai/shared";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents } from "@paperclipai/db";
import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  agentRuntimeConfigSchema,
  getAgentWorkEligibility,
  normalizeAgentUrlKey,
  type AgentEligibilityAgent,
} from "@paperclipai/shared";

import { conflict, notFound, unprocessable } from "../errors.js";
import { collectSecretRefs, collectUserSecretRefs, syncAgentAdapterEnvBindings } from "./agent-secret-bindings.js";
import { logActivity } from "./activity-log.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";

import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";
import {
  assertClaudeOAuthBindingInvariant,
  claudeOAuthBindingsMatchExactly,
  claudeOAuthClaimRejectedError,
  CLAUDE_LOCAL_ADAPTER_TYPE,
  readClaudeOAuthBinding,
  secretService,
  type ClaudeOAuthBindingInvariantDecision,
} from "./secrets.js";
import { createDbSetupTokenCleanupStore } from "./setup-token-session.js";
import { builtInAgentMarkersEqual, readBuiltInAgentMarker } from "./built-in-agent-metadata.js";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "icon",
  "appearance",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "defaultEnvironmentId",
  "budgetMonthlyCents",
  "metadata",
] as const;

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

/**
 * The Claude login context for an agent write. The route derives the owner user
 * from the authenticated actor, not from the request body, and forwards the
 * non-secret `storedSessionId` claim from a completed Claude login session. A
 * controlled internal override permits a migration or an administrator repair to
 * bind or unbind the fixed OAuth token without a claim.
 *
 * The `applyExistingWithoutClaim` field is the user-actor apply-existing path.
 * The route sets it only for an authenticated user actor and derives the owner
 * from that actor. The path binds the fixed reference to the owner stored value
 * with no login round trip. It is distinct from `allowInternalBindingOverride`,
 * which does no ownership check.
 *
 * The `inheritedFromAgentId` field is the hire-inheritance path. The route
 * sets it only for an authenticated agent actor whose hire request inherited
 * the fixed reference from that named parent. The service re-reads the parent
 * agent inside the write transaction and binds the fixed reference only when
 * the parent exists, is in the same company, is a `claude_local` agent, and
 * already holds the exact fixed binding.
 */
interface ClaudeLoginContext {
  storedSessionId?: string | null;
  ownerUserId?: string | null;
  allowInternalBindingOverride?: boolean;
  applyExistingWithoutClaim?: boolean;
  inheritedFromAgentId?: string | null;
}

export interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
  allowBuiltInAgentMetadata?: boolean;
  allowPendingApprovalConfigUpdate?: boolean;
  claudeLogin?: ClaudeLoginContext;
}

export interface CreateAgentOptions {
  responsibleUserId?: string | null;
  createdByUserId?: string | null;
  aiConnectionInstall?: { connectionId: string; memberConnectionIds?: string[]; createdByUserId: string | null };
  allowBuiltInAgentMetadata?: boolean;
  claudeLogin?: ClaudeLoginContext;
}

interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildConfigSnapshot(
  row: Pick<typeof agents.$inferSelect, ConfigRevisionField>,
): AgentConfigSnapshot {
  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? sanitizeRecord(row.adapterConfig as Record<string, unknown>)
      : {};
  const runtimeConfig =
    typeof row.runtimeConfig === "object" && row.runtimeConfig !== null && !Array.isArray(row.runtimeConfig)
      ? sanitizeRecord(row.runtimeConfig as Record<string, unknown>)
      : {};
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? sanitizeRecord(row.metadata as Record<string, unknown>)
      : row.metadata ?? null;
  return {
    name: row.name,
    role: row.role,
    title: row.title,
    icon: row.icon,
    appearance: row.appearance,
    reportsTo: row.reportsTo,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    adapterConfig,
    runtimeConfig,
    defaultEnvironmentId: row.defaultEnvironmentId,
    budgetMonthlyCents: row.budgetMonthlyCents,
    metadata,
  };
}

export function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

export function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

export function changedPendingApprovalConfigFields(
  existing: Omit<typeof agents.$inferSelect, "lifecycleOperation" | "lifecycleRequiredPluginIds">,
  data: Partial<typeof agents.$inferInsert>,
) {
  return CONFIG_REVISION_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(data, field) && !jsonEqual(data[field], existing[field]),
  );
}

export function configPatchFromApprovalPayload(payload: Record<string, unknown>) {
  const patch: Partial<typeof agents.$inferInsert> = {};
  if (typeof payload.name === "string") patch.name = payload.name;
  if (typeof payload.role === "string") patch.role = payload.role;
  if (payload.appearance != null) patch.appearance = agentAppearanceSchema.parse(payload.appearance);
  if (Object.prototype.hasOwnProperty.call(payload, "title")) {
    patch.title = typeof payload.title === "string" ? payload.title : null;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "icon")) {
    patch.icon = typeof payload.icon === "string" ? payload.icon : null;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "reportsTo")) {
    patch.reportsTo = typeof payload.reportsTo === "string" ? payload.reportsTo : null;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "capabilities")) {
    patch.capabilities = typeof payload.capabilities === "string" ? payload.capabilities : null;
  }
  if (typeof payload.adapterType === "string") patch.adapterType = payload.adapterType;
  if (isPlainRecord(payload.adapterConfig)) patch.adapterConfig = payload.adapterConfig;
  if (isPlainRecord(payload.runtimeConfig)) patch.runtimeConfig = payload.runtimeConfig;
  if (Object.prototype.hasOwnProperty.call(payload, "defaultEnvironmentId")) {
    patch.defaultEnvironmentId =
      typeof payload.defaultEnvironmentId === "string" ? payload.defaultEnvironmentId : null;
  }
  if (typeof payload.budgetMonthlyCents === "number") {
    patch.budgetMonthlyCents = payload.budgetMonthlyCents;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "metadata")) {
    patch.metadata = isPlainRecord(payload.metadata) ? payload.metadata : null;
  }
  if (isPlainRecord(payload.permissions)) {
    patch.permissions = payload.permissions;
  }
  return patch;
}

function parseFiniteNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeRuntimeConfigForNewAgent(runtimeConfig: unknown): Record<string, unknown> {
  const normalizedRuntimeConfig = isPlainRecord(runtimeConfig) ? { ...runtimeConfig } : {};
  const heartbeat = isPlainRecord(normalizedRuntimeConfig.heartbeat)
    ? { ...normalizedRuntimeConfig.heartbeat }
    : {};
  if (parseFiniteNumberLike(heartbeat.maxConcurrentRuns) == null) {
    heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
  }
  normalizedRuntimeConfig.heartbeat = heartbeat;
  return normalizedRuntimeConfig;
}

export function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

export function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }
  const runtimeConfig = agentRuntimeConfigSchema.safeParse(
    isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
  );
  if (!runtimeConfig.success) {
    throw unprocessable("Invalid revision snapshot: runtimeConfig");
  }

  return {
    name: snapshot.name,
    role: snapshot.role,
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    adapterType: snapshot.adapterType,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: runtimeConfig.data,
    defaultEnvironmentId:
      typeof snapshot.defaultEnvironmentId === "string" || snapshot.defaultEnvironmentId === null
        ? snapshot.defaultEnvironmentId
        : null,
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return false;

  return existingAgents.some((agent) => {
    if (agent.status === "terminated") return false;
    if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
    return normalizeAgentUrlKey(agent.name) === candidateShortname;
  });
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i++) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}

export function agentRecordSupport(db: Db) {
  const secretsSvc = secretService(db);

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentBaseRow(row: typeof agents.$inferSelect) {
    const { lifecycleOperation, lifecycleRequiredPluginIds, ...publicRow } = row;
    return withUrlKey({
      ...publicRow,
      permissions: normalizeAgentPermissions(row.permissions),
    });
  }

  function toEligibilityAgent(row: Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "status" | "reportsTo">): AgentEligibilityAgent {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      status: row.status,
      reportsTo: row.reportsTo,
    };
  }

  function normalizeAgentRows(rows: (typeof agents.$inferSelect)[], allCompanyRows = rows) {
    const eligibilityAgents = allCompanyRows.map(toEligibilityAgent);
    return rows.map((row) => {
      const base = normalizeAgentBaseRow(row);
      const appearance = resolveAgentAppearance(row.appearance, row.id);
      return {
        ...base,
        appearance,
        avatarUrl: agentAvatarUrl(appearance),
        orgChainHealth: getAgentWorkEligibility({
          agent: toEligibilityAgent(row),
          agents: eligibilityAgents,
        }).orgChainHealth,
      };
    });
  }

  function normalizeAgentRow(row: typeof agents.$inferSelect, allCompanyRows?: (typeof agents.$inferSelect)[]) {
    return normalizeAgentRows([row], allCompanyRows)[0]!;
  }

  async function listCompanyAgentRows(companyId: string) {
    return db.select().from(agents).where(eq(agents.companyId, companyId));
  }

  async function getMonthlySpendByAgentIds(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await db
      .select({
        agentId: costEvents.agentId,
        spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          inArray(costEvents.agentId, agentIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.agentId);
    return new Map(rows.map((row) => [row.agentId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateAgentSpend<T extends { id: string; companyId: string; spentMonthlyCents: number }>(rows: T[]) {
    const agentIds = rows.map((row) => row.id);
    const companyId = rows[0]?.companyId;
    if (!companyId || agentIds.length === 0) return rows;
    const spendByAgentId = await getMonthlySpendByAgentIds(companyId, agentIds);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByAgentId.get(row.id) ?? 0,
    }));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [companyRows, hydrated] = await Promise.all([
      listCompanyAgentRows(row.companyId),
      hydrateAgentSpend([row]).then((rows) => rows[0]!),
    ]);
    return normalizeAgentRow(hydrated, companyRows);
  }

  async function requireGetById(id: string) {
    const agent = await getById(id);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function ensureManager(companyId: string, managerId: string) {
    const manager = await getById(managerId);
    if (!manager) throw notFound("Manager not found");
    if (manager.companyId !== companyId) {
      throw unprocessable("Manager must belong to same company");
    }
    return manager;
  }

  async function assertNoCycle(agentId: string, reportsTo: string | null | undefined) {
    if (!reportsTo) return;
    if (reportsTo === agentId) throw unprocessable("Agent cannot report to itself");

    let cursor: string | null = reportsTo;
    while (cursor) {
      if (cursor === agentId) throw unprocessable("Reporting relationship would create cycle");
      const next = await getById(cursor);
      cursor = next?.reportsTo ?? null;
    }
  }

  async function assertCompanyShortnameAvailable(
    companyId: string,
    candidateName: string,
    options?: AgentShortnameCollisionOptions,
  ) {
    const candidateShortname = normalizeAgentUrlKey(candidateName);
    if (!candidateShortname) return;

    const existingAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const hasCollision = hasAgentShortnameCollision(candidateName, existingAgents, options);
    if (hasCollision) {
      throw conflict(
        `Agent shortname '${candidateShortname}' is already in use in this company`,
      );
    }
  }

  async function syncAgentSecretBindings(
    agent: { id: string; companyId: string; adapterConfig: unknown },
    dbClient: Db = db,
    previousAdapterConfig: unknown = null,
    actor: RevisionMetadata = {},
  ) {
    const scopedSecretsSvc = dbClient === db ? secretsSvc : secretService(dbClient);
    await syncAgentAdapterEnvBindings({
      secretsSvc: scopedSecretsSvc,
      companyId: agent.companyId,
      agentId: agent.id,
      adapterConfig: agent.adapterConfig,
    });
    const previousRefs = new Set([
      ...collectSecretRefs(previousAdapterConfig).map((ref) => `secret:${ref.secretId}:${ref.configPath}`),
      ...collectUserSecretRefs(previousAdapterConfig).map((ref) => `user:${ref.definitionKey}:${ref.configPath}`),
    ]);
    const createdRefs = [
      ...collectSecretRefs(agent.adapterConfig).map((ref) => ({
        key: `secret:${ref.secretId}:${ref.configPath}`,
        configPath: ref.configPath,
        bindingType: "secret_ref",
        secretId: ref.secretId,
        definitionKey: null,
      })),
      ...collectUserSecretRefs(agent.adapterConfig).map((ref) => ({
        key: `user:${ref.definitionKey}:${ref.configPath}`,
        configPath: ref.configPath,
        bindingType: "user_secret_ref",
        secretId: null,
        definitionKey: ref.definitionKey,
      })),
    ].filter((ref) => !previousRefs.has(ref.key));
    const actorType = actor.createdByUserId ? "user" as const : actor.createdByAgentId ? "agent" as const : "system" as const;
    const actorId = actor.createdByUserId ?? actor.createdByAgentId ?? "system";
    for (const ref of createdRefs) {
      await logActivity(dbClient, {
        companyId: agent.companyId,
        actorType,
        actorId,
        agentId: actor.createdByAgentId ?? null,
        action: "secret.binding.created",
        entityType: "agent",
        entityId: agent.id,
        details: {
          targetType: "agent",
          targetId: agent.id,
          configPath: ref.configPath,
          bindingType: ref.bindingType,
          secretId: ref.secretId,
          definitionKey: ref.definitionKey,
        },
      });
    }
  }

  /**
   * Enforces the Claude OAuth binding claim inside a write transaction. It runs
   * after {@link assertClaudeOAuthBindingInvariant} decided that the write
   * introduces or keeps the fixed binding.
   *
   * When the write introduces the fixed binding:
   *   * A create or hire path (`consume: true`) consumes a stored-session claim
   *     with one conditional write. It builds the claim scope from the company,
   *     the owner user, the fixed adapter, the environment, and the
   *     `storedSessionId`. It inserts the binding only when the write returns one
   *     row; otherwise it raises the fixed claim error, which rolls back the
   *     whole transaction and inserts no binding.
   *   * An update, approval, or rollback path (`consume: false`) carries no
   *     claim, so it raises the same fixed claim error at once.
   *
   * The user-actor apply-existing path (`applyExistingWithoutClaim`) binds the
   * fixed reference with no login round trip. The route sets the flag only for
   * an authenticated user actor and derives the owner from that actor. The gate
   * permits the no-claim bind only when the owner already has a stored value for
   * the company. It reads the owner value status; it reads no token. A missing
   * owner or a missing stored value raises the same fixed claim error, so the
   * caller cannot tell the reasons apart.
   *
   * The hire-inheritance path (`inheritedFromAgentId`) binds the fixed
   * reference with no login round trip and no stored owner value, because the
   * owning user resolves per run, not from a value stored against this agent.
   * The route copies the parent's reference onto the child before this
   * transaction starts, so a concurrent version change on the parent can
   * leave the child holding a stale version. The gate re-reads the named
   * parent agent inside this transaction and permits the bind only when the
   * parent exists, is in the same company, is a `claude_local` agent, and its
   * current reference matches the child's copied reference exactly, including
   * the version selector. The gate locks the parent row with `SELECT ...
   * FOR UPDATE` before it reads the reference. The lock blocks a concurrent
   * credential rotation on the same parent row until this transaction
   * commits or rolls back, so the compare-and-bind check stays atomic with
   * the parent's current state. The route derives the parent identifier
   * from the authenticated agent actor, never from the request body, so the
   * gate treats it as a claim to verify, not a trusted value.
   *
   * A controlled internal override skips the claim for a migration or an
   * administrator repair. The function creates the fixed user-secret definition
   * before the caller runs the declaration synchronization, so the synchronized
   * declaration always references an existing definition.
   */
  async function enforceClaudeOAuthBindingClaim(
    txDb: Db,
    input: {
      companyId: string;
      decision: ClaudeOAuthBindingInvariantDecision;
      consume: boolean;
      environmentId: string | null;
      claudeLogin?: ClaudeLoginContext;
      /**
       * The adapter config the write is about to persist. The
       * `inheritedFromAgentId` path reads the child's copied
       * `CLAUDE_CODE_OAUTH_TOKEN` reference from it, to compare against the
       * parent's current reference.
       */
      childAdapterConfig?: unknown;
    },
  ): Promise<void> {
    const ownerUserId = input.claudeLogin?.ownerUserId ?? null;
    if (input.decision.introducesBinding && !input.claudeLogin?.allowInternalBindingOverride) {
      if (input.claudeLogin?.applyExistingWithoutClaim) {
        // The user-actor apply-existing path. The route derived the owner from
        // the authenticated user actor. The gate binds the fixed reference only
        // when that owner already has a stored value. It reads no token.
        if (!ownerUserId) {
          throw claudeOAuthClaimRejectedError();
        }
        const stored = await secretService(txDb).readClaudeOAuthUserSecretStatus(
          input.companyId,
          ownerUserId,
        );
        if (!stored) {
          throw claudeOAuthClaimRejectedError();
        }
      } else if (input.claudeLogin?.inheritedFromAgentId) {
        // The hire-inheritance path. Re-read the named parent inside this
        // transaction; a caller-supplied identifier never binds on its own.
        // Compare the parent's current reference against the reference
        // already copied onto the child, including the version selector, so
        // a concurrent version change on the parent cannot leave the child
        // bound to a stale version.
        const parentId = input.claudeLogin.inheritedFromAgentId;
        const parent = await txDb
          .select({
            companyId: agents.companyId,
            adapterType: agents.adapterType,
            adapterConfig: agents.adapterConfig,
          })
          .from(agents)
          .where(eq(agents.id, parentId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        const parentBinding = readClaudeOAuthBinding(parent?.adapterConfig ?? null);
        const childBinding = readClaudeOAuthBinding(input.childAdapterConfig ?? null);
        if (
          !parent ||
          parent.companyId !== input.companyId ||
          parent.adapterType !== CLAUDE_LOCAL_ADAPTER_TYPE ||
          !claudeOAuthBindingsMatchExactly(parentBinding, childBinding)
        ) {
          throw claudeOAuthClaimRejectedError();
        }
      } else if (!input.consume) {
        throw claudeOAuthClaimRejectedError();
      } else {
        const consumed = await createDbSetupTokenCleanupStore(txDb).consumeStoredClaim({
          sessionId: input.claudeLogin?.storedSessionId ?? "",
          companyId: input.companyId,
          ownerUserId: ownerUserId ?? "",
          adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
        });
        if (!consumed) {
          throw claudeOAuthClaimRejectedError();
        }
      }
    }
    if (input.decision.introducesBinding || input.decision.keepsBinding) {
      // Create the fixed definition before declaration synchronization.
      await secretService(txDb).ensureClaudeOAuthUserSecretDefinition(input.companyId, {
        userId: ownerUserId,
      });
    }
  }

  function assertBuiltInAgentMetadataMutationAllowed(
    beforeMetadata: unknown,
    afterMetadata: unknown,
    options?: { allowBuiltInAgentMetadata?: boolean },
  ) {
    if (options?.allowBuiltInAgentMetadata) return;
    const beforeMarker = readBuiltInAgentMarker(beforeMetadata);
    const afterMarker = readBuiltInAgentMarker(afterMetadata);
    if (builtInAgentMarkersEqual(beforeMarker, afterMarker)) return;
    throw conflict("Built-in agent marker is managed by Paperclip and cannot be edited directly", {
      code: "built_in_agent_marker_readonly",
      key: beforeMarker?.key ?? afterMarker?.key ?? null,
    });
  }

  return {
    secretsSvc,
    normalizeAgentRows,
    normalizeAgentRow,
    listCompanyAgentRows,
    hydrateAgentSpend,
    getById,
    ensureManager,
    assertNoCycle,
    assertCompanyShortnameAvailable,
    syncAgentSecretBindings,
    enforceClaudeOAuthBindingClaim,
    assertBuiltInAgentMetadataMutationAllowed,
  };
}
