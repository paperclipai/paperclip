import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  costEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  issueComments,
} from "@paperclipai/db";
import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  getAgentWorkEligibility,
  isUuidLike,
  normalizeAgentApiKeyScope,
  normalizeAgentUrlKey,
  type AgentEligibilityAgent,
  type AgentApiKeyScope,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  collectSecretRefs,
  collectUserSecretRefs,
  syncAgentAdapterEnvBindings,
} from "./agent-secret-bindings.js";
import { logActivity } from "./activity-log.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";
import {
  assertClaudeOAuthBindingInvariant,
  claudeOAuthClaimRejectedError,
  CLAUDE_LOCAL_ADAPTER_TYPE,
  secretService,
  type ClaudeOAuthBindingInvariantDecision,
} from "./secrets.js";
import { createDbSetupTokenCleanupStore } from "./setup-token-session.js";
import {
  builtInAgentMarkersEqual,
  readBuiltInAgentMarker,
} from "./built-in-agent-metadata.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "icon",
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
 */
interface ClaudeLoginContext {
  storedSessionId?: string | null;
  ownerUserId?: string | null;
  allowInternalBindingOverride?: boolean;
  applyExistingWithoutClaim?: boolean;
}

interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
  allowBuiltInAgentMetadata?: boolean;
  allowPendingApprovalConfigUpdate?: boolean;
  claudeLogin?: ClaudeLoginContext;
}

interface CreateAgentOptions {
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildConfigSnapshot(
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

function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function changedPendingApprovalConfigFields(
  existing: typeof agents.$inferSelect,
  data: Partial<typeof agents.$inferInsert>,
) {
  return CONFIG_REVISION_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(data, field) && !jsonEqual(data[field], existing[field]),
  );
}

function configPatchFromApprovalPayload(payload: Record<string, unknown>) {
  const patch: Partial<typeof agents.$inferInsert> = {};
  if (typeof payload.name === "string") patch.name = payload.name;
  if (typeof payload.role === "string") patch.role = payload.role;
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

function normalizeRuntimeConfigForNewAgent(runtimeConfig: unknown): Record<string, unknown> {
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

function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
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
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
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

export function agentService(db: Db) {
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
    return withUrlKey({
      ...row,
      permissions: normalizeAgentPermissions(row.permissions, row.role),
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
      return {
        ...base,
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

  async function updateAgent(
    id: string,
    data: Partial<typeof agents.$inferInsert>,
    options?: UpdateAgentOptions,
  ) {
    const existing = await getById(id);
    if (!existing) return null;

    if (existing.status === "terminated" && data.status && data.status !== "terminated") {
      throw conflict("Terminated agents cannot be resumed");
    }
    if (
      existing.status === "pending_approval" &&
      data.status &&
      data.status !== "pending_approval" &&
      data.status !== "terminated"
    ) {
      throw conflict("Pending approval agents cannot be activated directly");
    }
    if (existing.status === "pending_approval" && !options?.allowPendingApprovalConfigUpdate) {
      const changedFields = changedPendingApprovalConfigFields(existing as typeof agents.$inferSelect, data);
      if (changedFields.length > 0) {
        throw conflict("Pending approval agent configuration cannot be changed before board approval", {
          code: "pending_approval_agent_config_frozen",
          agentId: id,
          fields: changedFields,
        });
      }
    }

    if (data.reportsTo !== undefined) {
      if (data.reportsTo) {
        await ensureManager(existing.companyId, data.reportsTo);
      }
      await assertNoCycle(id, data.reportsTo);
    }

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.companyId, data.name, { excludeAgentId: id });
      }
    }

    if (Object.prototype.hasOwnProperty.call(data, "metadata")) {
      assertBuiltInAgentMetadataMutationAllowed(existing.metadata, data.metadata, options);
    }

    const normalizedPatch = { ...data } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role);
    }
    if (
      Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterConfig") &&
      isPlainRecord(normalizedPatch.adapterConfig)
    ) {
      normalizedPatch.adapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.companyId,
        normalizedPatch.adapterConfig,
        { adapterType: (normalizedPatch.adapterType ?? existing.adapterType) as string },
      );
    }
    // Run the server-enforced binding invariant when the patch touches the
    // adapter config. The update, approval, and rollback paths keep an existing
    // fixed binding but reject a newly introduced binding, because they carry no
    // stored-session claim.
    const bindingDecision = Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterConfig")
      ? assertClaudeOAuthBindingInvariant({
          adapterType: (normalizedPatch.adapterType ?? existing.adapterType) as string,
          nextConfig: normalizedPatch.adapterConfig,
          priorConfig: existing.adapterConfig,
        })
      : null;

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    type AgentUpdateResult = Awaited<ReturnType<typeof getById>>;
    const applyUpdate = async (txDb: Db): Promise<AgentUpdateResult> => {
      const updated = await txDb
        .update(agents)
        .set({ ...normalizedPatch, updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;

      if (Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterConfig")) {
        if (bindingDecision) {
          await enforceClaudeOAuthBindingClaim(txDb, {
            companyId: existing.companyId,
            decision: bindingDecision,
            consume: false,
            environmentId: null,
            claudeLogin: options?.claudeLogin,
          });
        }
        await syncAgentSecretBindings(
          updated,
          txDb,
          existing.adapterConfig,
          options?.recordRevision,
        );
      }

      const normalizedUpdated = await agentService(txDb).getById(updated.id);
      if (!normalizedUpdated) {
        throw notFound("Agent not found");
      }

      if (shouldRecordRevision && beforeConfig) {
        const afterConfig = buildConfigSnapshot(normalizedUpdated);
        const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
        if (changedKeys.length > 0) {
          await txDb.insert(agentConfigRevisions).values({
            companyId: normalizedUpdated.companyId,
            agentId: normalizedUpdated.id,
            createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
            createdByUserId: options?.recordRevision?.createdByUserId ?? null,
            source: options?.recordRevision?.source ?? "patch",
            rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
            changedKeys,
            beforeConfig: beforeConfig as unknown as Record<string, unknown>,
            afterConfig: afterConfig as unknown as Record<string, unknown>,
          });
        }
      }

      return normalizedUpdated;
    };

    const transaction = (db as unknown as {
      transaction?: (callback: (tx: unknown) => Promise<AgentUpdateResult>) => Promise<AgentUpdateResult>;
    }).transaction;
    if (typeof transaction !== "function") return applyUpdate(db);
    return transaction.call(db, async (tx) => applyUpdate(tx as unknown as Db));
  }

  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const [rows, allCompanyRows] = await Promise.all([
        db.select().from(agents).where(and(...conditions)),
        listCompanyAgentRows(companyId),
      ]);
      const hydrated = await hydrateAgentSpend(rows);
      return normalizeAgentRows(hydrated, allCompanyRows);
    },

    getById,

    create: async (companyId: string, data: Omit<typeof agents.$inferInsert, "companyId">, options?: CreateAgentOptions) => {
      assertBuiltInAgentMetadataMutationAllowed(null, data.metadata, options);
      if (data.reportsTo) {
        await ensureManager(companyId, data.reportsTo);
      }

      const existingAgents = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const uniqueName = deduplicateAgentName(data.name, existingAgents);

      const role = data.role ?? "general";
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, role);
      const runtimeConfig = normalizeRuntimeConfigForNewAgent(data.runtimeConfig);
      const adapterType = data.adapterType ?? "process";
      const adapterConfig = isPlainRecord(data.adapterConfig)
        ? await secretsSvc.normalizeAdapterConfigForPersistence(companyId, data.adapterConfig, { adapterType })
        : {};
      // Run the server-enforced binding invariant after generic normalization
      // and before any database write. A create has no prior config.
      const bindingDecision = assertClaudeOAuthBindingInvariant({
        adapterType,
        nextConfig: adapterConfig,
        priorConfig: null,
      });
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // Consume the stored-session claim and create the fixed definition inside
        // the same transaction that inserts the binding. A rejected claim rolls
        // back the whole transaction and inserts no binding.
        await enforceClaudeOAuthBindingClaim(txDb, {
          companyId,
          decision: bindingDecision,
          consume: true,
          environmentId: (data.defaultEnvironmentId as string | null | undefined) ?? null,
          claudeLogin: options?.claudeLogin,
        });
        const created = await tx
          .insert(agents)
          .values({
            ...data,
            name: uniqueName,
            companyId,
            role,
            adapterType,
            adapterConfig,
            permissions: normalizedPermissions,
            runtimeConfig,
          })
          .returning()
          .then((rows) => rows[0]);
        await syncAgentSecretBindings(created, txDb);
        const normalizedCreated = await agentService(txDb).getById(created.id);
        if (!normalizedCreated) {
          throw notFound("Agent not found");
        }
        return normalizedCreated;
      });
    },

    update: updateAgent,

    pause: async (id: string, reason: "manual" | "budget" | "system" = "manual") => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot pause terminated agent");

      const updated = await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: reason,
          pausedAt: new Date(),
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? getById(updated.id) : null;
    },

    resume: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot resume terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot be resumed");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? getById(updated.id) : null;
    },

    clearError: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot clear error on terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot have errors cleared");
      }
      if (existing.status !== "error") {
        throw conflict("Only agents in error status can have their error cleared");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, id), eq(agents.status, "error")))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        throw conflict("Only agents in error status can have their error cleared");
      }
      return getById(updated.id);
    },

    terminate: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      await db
        .update(agents)
        .set({
          status: "terminated",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id));

      await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.agentId, id));

      return getById(id);
    },

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      const builtInMarker = readBuiltInAgentMarker(existing.metadata);
      if (builtInMarker) {
        throw conflict("Built-in agents cannot be deleted; pause them instead", {
          code: "built_in_agent_undeletable",
          key: builtInMarker.key,
          featureKeys: builtInMarker.featureKeys,
        });
      }

      return db.transaction(async (tx) => {
        await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, id))
          .for("update");
        await issueThreadInteractionService(tx as unknown as Db)
          .cancelPendingForDeletedAddressee(existing.companyId, id);
        await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
        await tx
          .update(issues)
          .set({ assigneeAgentId: null, createdByAgentId: null })
          .where(or(eq(issues.assigneeAgentId, id), eq(issues.createdByAgentId, id)));
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(activityLog).where(
          or(
            eq(activityLog.agentId, id),
            sql`${activityLog.runId} in (select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${id})`,
          ),
        );
        await tx.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.actorAgentId, id));
        await tx.delete(issueComments).where(eq(issueComments.authorAgentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
    },

    activatePendingApproval: async (id: string, approvedPayload?: Record<string, unknown> | null) => {
      const activatedAgent = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const existing = await agentService(txDb).getById(id);
        if (!existing || existing.status !== "pending_approval") return null;
        const approvedPatch = approvedPayload ? configPatchFromApprovalPayload(approvedPayload) : {};
        let patch = { ...approvedPatch } as Partial<typeof agents.$inferInsert>;
        let approvalBindingDecision: ClaudeOAuthBindingInvariantDecision | null = null;
        if (
          Object.prototype.hasOwnProperty.call(patch, "adapterConfig") &&
          isPlainRecord(patch.adapterConfig)
        ) {
          patch.adapterConfig = await secretService(txDb).normalizeAdapterConfigForPersistence(
            existing.companyId,
            patch.adapterConfig,
            { adapterType: (patch.adapterType ?? existing.adapterType) as string },
          );
          // The approval activation keeps an existing fixed binding but rejects a
          // newly introduced binding, because it carries no stored-session claim.
          approvalBindingDecision = assertClaudeOAuthBindingInvariant({
            adapterType: (patch.adapterType ?? existing.adapterType) as string,
            nextConfig: patch.adapterConfig,
            priorConfig: existing.adapterConfig,
          });
        }
        if (patch.permissions !== undefined) {
          patch.permissions = normalizeAgentPermissions(
            patch.permissions,
            (patch.role ?? existing.role) as string,
          );
        }
        const updated = await tx
          .update(agents)
          .set({ ...patch, status: "idle", updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.status, "pending_approval")))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        if (approvalBindingDecision) {
          await enforceClaudeOAuthBindingClaim(txDb, {
            companyId: existing.companyId,
            decision: approvalBindingDecision,
            consume: false,
            environmentId: null,
          });
        }
        await syncAgentSecretBindings(updated, txDb, existing.adapterConfig);
        const agent = await agentService(txDb).getById(updated.id);
        if (!agent) {
          throw notFound("Agent not found");
        }
        return agent;
      });

      if (activatedAgent) {
        return { agent: activatedAgent, activated: true };
      }

      const existing = await getById(id);
      return existing ? { agent: existing, activated: false } : null;
    },

    updatePermissions: async (id: string, permissions: Record<string, unknown> & { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agent permissions cannot be changed before board approval", {
          code: "pending_approval_agent_config_frozen",
          agentId: id,
          fields: ["permissions"],
        });
      }

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions({ ...existing.permissions, ...permissions }, existing.role),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? getById(updated.id) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (
      id: string,
      name: string,
      scope: AgentApiKeyScope = { kind: "standard" },
      options?: { responsibleUserId?: string | null },
    ) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create keys for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create keys for terminated agents");
      }

      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(agentApiKeys)
        .values({
          agentId: id,
          companyId: existing.companyId,
          name,
          keyHash,
          responsibleUserId: options?.responsibleUserId?.trim() || null,
          scopeConfig: scope.kind === "standard" ? null : scope,
        })
        .returning()
        .then((rows) => rows[0]);

      return {
        id: created.id,
        name: created.name,
        scope: normalizeAgentApiKeyScope(created.scopeConfig),
        responsibleUserId: created.responsibleUserId,
        token,
        createdAt: created.createdAt,
      };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          responsibleUserId: agentApiKeys.responsibleUserId,
          scopeConfig: agentApiKeys.scopeConfig,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id))
        .then((rows) => rows.map((row) => ({
          id: row.id,
          name: row.name,
          scope: normalizeAgentApiKeyScope(row.scopeConfig),
          responsibleUserId: row.responsibleUserId,
          createdAt: row.createdAt,
          revokedAt: row.revokedAt,
        }))),

    getKeyById: async (keyId: string) =>
      db
        .select({
          id: agentApiKeys.id,
          agentId: agentApiKeys.agentId,
          companyId: agentApiKeys.companyId,
          name: agentApiKeys.name,
          responsibleUserId: agentApiKeys.responsibleUserId,
          scopeConfig: agentApiKeys.scopeConfig,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.id, keyId))
        .then((rows) => {
          const row = rows[0] ?? null;
          return row
            ? {
              ...row,
              scope: normalizeAgentApiKeyScope(row.scopeConfig),
            }
            : null;
        }),

    revokeKey: async (agentId: string, keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.agentId, agentId)))
        .returning();
      return rows[0] ?? null;
    },

    orgForCompany: async (companyId: string) => {
      const allCompanyRows = await listCompanyAgentRows(companyId);
      const rows = allCompanyRows.filter((row) => row.status !== "terminated");
      const normalizedRows = normalizeAgentRows(rows, allCompanyRows);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key = row.reportsTo && rows.some((candidate) => candidate.id === row.reportsTo) ? row.reportsTo : null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; role: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const matches = normalizeAgentRows(rows, rows)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
  };
}
