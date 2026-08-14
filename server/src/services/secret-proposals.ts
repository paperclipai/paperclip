import { and, count, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecretProposals, companySecrets, heartbeatRuns, issues } from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";
import { normalizeSecretKey, secretService } from "./secrets.js";

const CONFIG_PATH_RE = /^(?:env\.[A-Za-z_][A-Za-z0-9_]*|access\.[A-Za-z_][A-Za-z0-9_]*)$/;
const SECRET_NAME_RE = /^[^/\s]+(?:\/[^/\s]+)*$/;
const MAX_PENDING_PROPOSALS_PER_AGENT = 20;
const MAX_PROPOSALS_PER_MINUTE = 20;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const PENDING_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_PROPOSAL_LIST_LIMIT = 100;
const DEFAULT_EXPIRY_SWEEP_LIMIT = 100;

export type SecretProposalTerminalStatus = "approved" | "rejected" | "withdrawn" | "expired";

export type ProposalRunContext = {
  companyId: string;
  heartbeatRunId: string;
  registerForRedaction: (value: string) => void | Promise<void>;
};

type Proposal = typeof companySecretProposals.$inferSelect;

async function loadRunContext(db: Db, context: Pick<ProposalRunContext, "companyId" | "heartbeatRunId">) {
  const run = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, context.heartbeatRunId),
    eq(heartbeatRuns.companyId, context.companyId),
  )).then((rows) => rows[0] ?? null);
  if (!run) throw forbidden("Secret proposals require a verified run-bound agent token");
  const issue = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, context.companyId),
    or(eq(issues.executionRunId, run.id), eq(issues.checkoutRunId, run.id)),
  )).then((rows) => rows[0] ?? null);
  return { run, originIssueId: issue?.id ?? null };
}

async function ancestorIds(db: Db, companyId: string, agentId: string, lockForUpdate = false) {
  const query = db.select({ id: agents.id, reportsTo: agents.reportsTo }).from(agents)
    .where(eq(agents.companyId, companyId));
  const rows = lockForUpdate ? await query.for("update") : await query;
  const byId = new Map(rows.map((row) => [row.id, row.reportsTo]));
  if (!byId.has(agentId)) throw notFound("Agent not found");
  const result: string[] = [];
  const seen = new Set<string>([agentId]);
  let current = byId.get(agentId) ?? null;
  while (current && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = byId.get(current) ?? null;
  }
  return result;
}

function bindingTargetAllowed(proposerAgentId: string, targetAgentId: string, targetAncestorIds: string[]) {
  return proposerAgentId === targetAgentId || targetAncestorIds.includes(proposerAgentId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createSecretProposalsService(db: Db) {
  async function getById(companyId: string, proposalId: string, dbClient: Db = db, lockForUpdate = false) {
    const query = dbClient.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.id, proposalId),
      eq(companySecretProposals.companyId, companyId),
    ));
    if (lockForUpdate) return query.for("update").then((rows) => rows[0] ?? null);
    return query.then((rows) => rows[0] ?? null);
  }

  async function requirePending(companyId: string, proposalId: string, dbClient: Db = db, lockForUpdate = false) {
    const proposal = await getById(companyId, proposalId, dbClient, lockForUpdate);
    if (!proposal) throw notFound("Secret proposal not found");
    if (proposal.status !== "pending") throw conflict("Only pending proposals can be resolved");
    return proposal;
  }

  function assertNotExpired(proposal: Proposal) {
    if (proposal.expiresAt.getTime() <= Date.now()) {
      throw conflict("Expired proposals cannot be approved");
    }
  }

  type CreationQuotaInput = { companyId: string; agentId: string; runId: string; issueId: string | null };

  async function creationQuotaDenial(dbClient: Db, input: CreationQuotaInput) {
    const [pending, recent] = await Promise.all([
      dbClient.select({ value: count() }).from(companySecretProposals).where(and(
        eq(companySecretProposals.companyId, input.companyId),
        eq(companySecretProposals.proposedByAgentId, input.agentId),
        eq(companySecretProposals.status, "pending"),
      )).then((rows) => Number(rows[0]?.value ?? 0)),
      dbClient.select({ value: count() }).from(companySecretProposals).where(and(
        eq(companySecretProposals.companyId, input.companyId),
        eq(companySecretProposals.proposedByAgentId, input.agentId),
        gte(companySecretProposals.createdAt, new Date(Date.now() - 60_000)),
      )).then((rows) => Number(rows[0]?.value ?? 0)),
    ]);
    const denial = pending >= MAX_PENDING_PROPOSALS_PER_AGENT
      ? { code: "pending_cap", message: `Agents may have at most ${MAX_PENDING_PROPOSALS_PER_AGENT} pending secret proposals` }
      : recent >= MAX_PROPOSALS_PER_MINUTE
        ? { code: "rate_limit", message: `Agents may create at most ${MAX_PROPOSALS_PER_MINUTE} secret proposals per minute` }
        : null;
    return denial ? { ...denial, pending, recent } : null;
  }

  async function createWithinQuota<T>(input: CreationQuotaInput, create: (txDb: Db) => Promise<T>) {
    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.companyId}), hashtext(${input.agentId}))`);
      const denial = await creationQuotaDenial(txDb, input);
      if (denial) {
        await logActivity(txDb, {
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          action: "secret.proposal.denied",
          entityType: "agent",
          entityId: input.agentId,
          agentId: input.agentId,
          runId: input.runId,
          details: { code: denial.code, issueId: input.issueId, pending: denial.pending, recent: denial.recent },
        });
        return { denial, value: null };
      }
      return { denial: null, value: await create(txDb) };
    });
    if (result.denial) throw unprocessable(result.denial.message);
    return result.value as T;
  }

  async function recordCreated(proposal: Proposal, dbClient: Db = db) {
    await logActivity(dbClient, {
      companyId: proposal.companyId,
      actorType: "agent",
      actorId: proposal.proposedByAgentId,
      action: "secret.proposal.created",
      entityType: "company_secret_proposal",
      entityId: proposal.id,
      agentId: proposal.proposedByAgentId,
      runId: proposal.originRunId,
      details: {
        kind: proposal.kind,
        issueId: proposal.originIssueId,
        targetAgentId: proposal.targetId,
        configPath: proposal.configPath,
        valueFingerprintSha256: proposal.valueFingerprintSha256,
      },
    });
  }

  async function createSecret(context: ProposalRunContext, input: {
    name: string;
    key?: string | null;
    description?: string | null;
    value: string;
    justification: string;
  }) {
    const name = input.name.trim();
    const justification = input.justification.trim();
    if (!SECRET_NAME_RE.test(name)) throw unprocessable("Secret name must be a slash-separated path without empty segments");
    if (!justification) throw unprocessable("Justification is required");
    if (!input.value) throw unprocessable("Secret value is required");
    if (Buffer.byteLength(input.value, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw unprocessable(`Secret value must be at most ${MAX_SECRET_VALUE_BYTES} bytes`);
    }
    const proposedKey = normalizeSecretKey(input.key?.trim() || name.split("/").at(-1) || "");
    if (!proposedKey) throw unprocessable("Secret key is required");
    const { run, originIssueId } = await loadRunContext(db, context);
    const prepared = await getSecretProvider("local_encrypted").createSecret({ value: input.value });
    await context.registerForRedaction(input.value);
    return createWithinQuota(
      { companyId: context.companyId, agentId: run.agentId, runId: run.id, issueId: originIssueId },
      async (txDb) => {
        const proposal = await txDb.insert(companySecretProposals).values({
          companyId: context.companyId,
          kind: "secret",
          proposedName: name,
          proposedKey,
          proposedDescription: input.description?.trim() || null,
          justification,
          valueCiphertext: prepared.material,
          valueFingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          valueLength: Buffer.byteLength(input.value, "utf8"),
          proposedByAgentId: run.agentId,
          originIssueId,
          originRunId: run.id,
          expiresAt: new Date(Date.now() + PENDING_EXPIRY_MS),
        }).returning().then((rows) => rows[0]);
        await recordCreated(proposal, txDb);
        return proposal;
      },
    );
  }

  async function createBinding(context: Pick<ProposalRunContext, "companyId" | "heartbeatRunId">, input: {
    secretId?: string | null;
    secretProposalId?: string | null;
    targetAgentId?: string | null;
    configPath: string;
    justification: string;
    bindingTargetPolicy: "self_and_reports";
  }) {
    if (Boolean(input.secretId) === Boolean(input.secretProposalId)) {
      throw unprocessable("Binding proposals require exactly one of secretId or secretProposalId");
    }
    if (!CONFIG_PATH_RE.test(input.configPath)) throw unprocessable("configPath must use env.<KEY> or access.<ALIAS>");
    if (!input.justification.trim()) throw unprocessable("Justification is required");
    const { run, originIssueId } = await loadRunContext(db, context);
    const targetAgentId = input.targetAgentId ?? run.agentId;
    const [proposerAncestors, targetAncestors] = await Promise.all([
      ancestorIds(db, context.companyId, run.agentId),
      ancestorIds(db, context.companyId, targetAgentId),
    ]);
    if (!bindingTargetAllowed(run.agentId, targetAgentId, targetAncestors)) {
      throw forbidden("Binding proposals may target only the proposing agent or its reports");
    }
    if (input.secretId) {
      const secret = await db.select().from(companySecrets).where(and(
        eq(companySecrets.id, input.secretId),
        eq(companySecrets.companyId, context.companyId),
      )).then((rows) => rows[0] ?? null);
      if (!secret || secret.scope !== "company" || secret.status === "deleted") throw notFound("Secret not found");
    }
    return createWithinQuota(
      { companyId: context.companyId, agentId: run.agentId, runId: run.id, issueId: originIssueId },
      async (txDb) => {
        if (input.secretProposalId) {
          const dependency = await txDb.select().from(companySecretProposals).where(and(
            eq(companySecretProposals.id, input.secretProposalId),
            eq(companySecretProposals.companyId, context.companyId),
          )).for("update").then((rows) => rows[0] ?? null);
          if (!dependency || dependency.kind !== "secret") throw notFound("Secret proposal not found");
          if (dependency.status !== "pending") {
            throw unprocessable(
              "Prerequisite secret proposal is no longer pending; use secretId to reference an approved secret",
            );
          }
        }
        const proposal = await txDb.insert(companySecretProposals).values({
          companyId: context.companyId,
          kind: "binding",
          justification: input.justification.trim(),
          secretId: input.secretId ?? null,
          secretProposalId: input.secretProposalId ?? null,
          targetType: "agent",
          targetId: targetAgentId,
          configPath: input.configPath,
          bindingTargetPolicySnapshot: input.bindingTargetPolicy,
          proposerAncestorIdsSnapshot: proposerAncestors,
          targetAncestorIdsSnapshot: targetAncestors,
          proposedByAgentId: run.agentId,
          originIssueId,
          originRunId: run.id,
          expiresAt: new Date(Date.now() + PENDING_EXPIRY_MS),
        }).returning().then((rows) => rows[0]);
        await recordCreated(proposal, txDb);
        return proposal;
      },
    );
  }

  async function enrich(proposal: Proposal) {
    const [proposer, target, originIssue, secret, secretProposal] = await Promise.all([
      db.select({ id: agents.id, name: agents.name, icon: agents.icon }).from(agents)
        .where(eq(agents.id, proposal.proposedByAgentId)).then((rows) => rows[0] ?? null),
      proposal.targetId
        ? db.select({ id: agents.id, name: agents.name, icon: agents.icon }).from(agents)
            .where(eq(agents.id, proposal.targetId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      proposal.originIssueId
        ? db.select({ id: issues.id, key: issues.identifier, title: issues.title }).from(issues)
            .where(eq(issues.id, proposal.originIssueId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      proposal.secretId
        ? db.select({ name: companySecrets.name }).from(companySecrets)
            .where(eq(companySecrets.id, proposal.secretId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      proposal.secretProposalId
        ? db.select({ proposedName: companySecretProposals.proposedName }).from(companySecretProposals)
            .where(eq(companySecretProposals.id, proposal.secretProposalId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    if (!proposer) throw notFound("Proposal agent not found");
    const {
      valueCiphertext: _ciphertext,
      bindingTargetPolicySnapshot: _policy,
      proposerAncestorIdsSnapshot: _proposerAncestors,
      targetAncestorIdsSnapshot: _targetAncestors,
      ...safe
    } = proposal;
    return {
      ...safe,
      secretName: secret?.name ?? null,
      secretProposalName: secretProposal?.proposedName ?? null,
      proposedBy: proposer,
      target,
      originIssue,
    };
  }

  async function listForAgent(
    companyId: string,
    agentId: string,
    options: { limit?: number; offset?: number } = {},
  ) {
    const rows = await db.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.companyId, companyId),
      or(
        eq(companySecretProposals.proposedByAgentId, agentId),
        and(eq(companySecretProposals.kind, "binding"), eq(companySecretProposals.targetId, agentId)),
      ),
    )).orderBy(desc(companySecretProposals.createdAt))
      .limit(options.limit ?? DEFAULT_PROPOSAL_LIST_LIMIT)
      .offset(options.offset ?? 0);
    return Promise.all(rows.map(enrich));
  }

  async function listForBoard(
    companyId: string,
    status?: string | null,
    options: { limit?: number; offset?: number } = {},
  ) {
    const rows = await db.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.companyId, companyId),
      status ? eq(companySecretProposals.status, status) : undefined,
    )).orderBy(desc(companySecretProposals.createdAt))
      .limit(options.limit ?? DEFAULT_PROPOSAL_LIST_LIMIT)
      .offset(options.offset ?? 0);
    return Promise.all(rows.map(enrich));
  }

  async function assertBindingSnapshotCurrent(proposal: Proposal, dbClient: Db = db, lockForUpdate = false) {
    if (proposal.kind !== "binding" || !proposal.targetId) return;
    const snapshotAllowed = proposal.bindingTargetPolicySnapshot === "self_and_reports"
      && bindingTargetAllowed(proposal.proposedByAgentId, proposal.targetId, proposal.targetAncestorIdsSnapshot ?? []);
    const currentTargetAncestors = await ancestorIds(
      dbClient,
      proposal.companyId,
      proposal.targetId,
      lockForUpdate,
    );
    const currentAllowed = bindingTargetAllowed(proposal.proposedByAgentId, proposal.targetId, currentTargetAncestors);
    if (!snapshotAllowed || !currentAllowed) {
      throw conflict("Binding proposal target is no longer allowed by its proposal-time and current chain-of-command policy");
    }
  }

  async function applySecretApproval(txDb: Db, proposal: Proposal, input: {
    resolvedByUserId: string;
    overrides?: { name?: string; description?: string | null; providerConfigId?: string | null };
  }) {
    if (!proposal.valueCiphertext) throw conflict("Proposed secret value is no longer available");
    const name = input.overrides?.name?.trim() || proposal.proposedName || "";
    if (!SECRET_NAME_RE.test(name)) throw unprocessable("Secret name must be a slash-separated path without empty segments");
    const value = await getSecretProvider("local_encrypted").resolveVersion({
      material: proposal.valueCiphertext,
      externalRef: null,
    });
    const secrets = secretService(txDb);
    const providerConfigId = input.overrides?.providerConfigId ?? null;
    const providerConfig = providerConfigId
      ? await secrets.getProviderConfigById(providerConfigId)
      : null;
    if (providerConfigId && (!providerConfig || providerConfig.companyId !== proposal.companyId)) {
      throw notFound("Provider vault not found");
    }
    const provider = (providerConfig?.provider ?? "local_encrypted") as SecretProvider;
    const created = await secrets.create(
      proposal.companyId,
      {
        name,
        key: proposal.proposedKey || normalizeSecretKey(name.split("/").at(-1) || ""),
        provider,
        providerConfigId,
        value,
        description: input.overrides?.description === undefined
          ? proposal.proposedDescription
          : input.overrides.description,
      },
      { userId: input.resolvedByUserId, agentId: proposal.proposedByAgentId },
    );
    await logActivity(txDb, {
      companyId: proposal.companyId,
      actorType: "user",
      actorId: input.resolvedByUserId,
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      agentId: proposal.proposedByAgentId,
      runId: proposal.originRunId,
      details: { name: created.name, provider: created.provider, proposalId: proposal.id },
    });
    return created;
  }

  async function markApproved(txDb: Db, proposal: Proposal, input: {
    resolvedByUserId: string;
    createdSecretId?: string | null;
    appliedBindingConfigPath?: string | null;
  }) {
    const now = new Date();
    const updated = await txDb.update(companySecretProposals).set({
      status: "approved",
      resolvedByUserId: input.resolvedByUserId,
      resolvedAt: now,
      createdSecretId: input.createdSecretId ?? null,
      appliedBindingConfigPath: input.appliedBindingConfigPath ?? null,
      valueCiphertext: null,
      ciphertextScrubbedAt: now,
      updatedAt: now,
    }).where(and(
      eq(companySecretProposals.id, proposal.id),
      eq(companySecretProposals.status, "pending"),
    )).returning().then((rows) => rows[0] ?? null);
    if (!updated) throw conflict("Proposal is no longer pending");
    await logActivity(txDb, {
      companyId: proposal.companyId,
      actorType: "user",
      actorId: input.resolvedByUserId,
      action: "secret.proposal.approved",
      entityType: "company_secret_proposal",
      entityId: proposal.id,
      agentId: proposal.proposedByAgentId,
      runId: proposal.originRunId,
      details: {
        issueId: proposal.originIssueId,
        createdSecretId: input.createdSecretId ?? null,
        appliedBindingConfigPath: input.appliedBindingConfigPath ?? null,
        ciphertextScrubbed: true,
      },
    });
    return updated;
  }

  async function applyBindingApproval(txDb: Db, proposal: Proposal, secretId: string, resolvedByUserId: string) {
    if (!proposal.targetId || !proposal.configPath) throw conflict("Binding proposal is incomplete");
    const agentSvc = agentService(txDb);
    const target = await agentSvc.getById(proposal.targetId);
    if (!target || target.companyId !== proposal.companyId) throw notFound("Target agent not found");
    const adapterConfig = { ...asRecord(target.adapterConfig) };
    const [namespace, key] = proposal.configPath.split(".", 2);
    const binding = { type: "secret_ref", secretId, version: "latest" };
    if (namespace === "env") {
      const env = { ...asRecord(adapterConfig.env) };
      const existing = env[key];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(binding)) {
        throw conflict(`Agent config path already exists: ${proposal.configPath}`);
      }
      adapterConfig.env = { ...env, [key]: binding };
    } else {
      const existing = adapterConfig[proposal.configPath];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(binding)) {
        throw conflict(`Agent config path already exists: ${proposal.configPath}`);
      }
      adapterConfig[proposal.configPath] = binding;
    }
    const updated = await agentSvc.update(target.id, { adapterConfig }, {
      recordRevision: { createdByUserId: resolvedByUserId, source: "patch" },
    });
    if (!updated) throw notFound("Target agent not found");
    await logActivity(txDb, {
      companyId: proposal.companyId,
      actorType: "user",
      actorId: resolvedByUserId,
      action: "agent.updated",
      entityType: "agent",
      entityId: target.id,
      details: { adapterConfig: true, proposalId: proposal.id, configPath: proposal.configPath },
    });
  }

  async function approve(companyId: string, proposalId: string, input: {
    resolvedByUserId: string;
    cascade?: boolean;
    overrides?: { name?: string; description?: string | null; providerConfigId?: string | null };
  }) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const proposal = await requirePending(companyId, proposalId, txDb, true);
      assertNotExpired(proposal);
      await assertBindingSnapshotCurrent(proposal, txDb, true);
      if (proposal.kind === "secret") {
        const created = await applySecretApproval(txDb, proposal, input);
        return markApproved(txDb, proposal, {
          resolvedByUserId: input.resolvedByUserId,
          createdSecretId: created.id,
        });
      }

      let secretId = proposal.secretId;
      if (proposal.secretProposalId) {
        const dependency = await getById(companyId, proposal.secretProposalId, txDb, true);
        if (!dependency || dependency.kind !== "secret") throw notFound("Prerequisite secret proposal not found");
        if (dependency.status !== "pending") {
          if (dependency.status !== "approved" || !dependency.createdSecretId) {
            throw conflict(`Prerequisite secret proposal ${dependency.id} is not approvable`);
          }
          secretId = dependency.createdSecretId;
        } else {
          if (!input.cascade) {
            throw conflict(`Binding proposal requires pending secret proposal ${dependency.id}; retry with cascade=true`);
          }
          assertNotExpired(dependency);
          const created = await applySecretApproval(txDb, dependency, input);
          await markApproved(txDb, dependency, {
            resolvedByUserId: input.resolvedByUserId,
            createdSecretId: created.id,
          });
          secretId = created.id;
        }
      }
      if (!secretId) throw conflict("Binding proposal has no approved secret");
      const liveSecret = await secretService(txDb).getById(secretId);
      if (!liveSecret || liveSecret.companyId !== companyId || liveSecret.status !== "active") {
        throw conflict("Binding proposal secret is not an active company secret");
      }
      await applyBindingApproval(txDb, proposal, secretId, input.resolvedByUserId);
      return markApproved(txDb, proposal, {
        resolvedByUserId: input.resolvedByUserId,
        appliedBindingConfigPath: proposal.configPath,
      });
    });
  }

  async function transition(companyId: string, proposalId: string, status: Exclude<SecretProposalTerminalStatus, "approved">, input: {
    resolvedByUserId?: string | null;
    reason?: string | null;
    proposerAgentId?: string | null;
  } = {}) {
    const proposal = await requirePending(companyId, proposalId);
    if (status === "withdrawn" && proposal.proposedByAgentId !== input.proposerAgentId) {
      throw forbidden("Only the proposer can withdraw this proposal");
    }
    const now = new Date();
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const updated = await tx.update(companySecretProposals).set({
        status,
        resolvedByUserId: input.resolvedByUserId ?? null,
        resolvedAt: now,
        resolutionReason: input.reason ?? null,
        valueCiphertext: null,
        ciphertextScrubbedAt: now,
        updatedAt: now,
      }).where(and(eq(companySecretProposals.id, proposalId), eq(companySecretProposals.status, "pending")))
        .returning().then((rows) => rows[0] ?? null);
      if (!updated) throw conflict("Proposal is no longer pending");
      const dependents = proposal.kind === "secret" && (status === "rejected" || status === "expired" || status === "withdrawn")
        ? await tx.update(companySecretProposals).set({
            status: "rejected",
            resolvedByUserId: input.resolvedByUserId ?? null,
            resolvedAt: now,
            resolutionReason: `Dependent secret proposal ${proposal.id} was ${status}`,
            valueCiphertext: null,
            ciphertextScrubbedAt: now,
            updatedAt: now,
          }).where(and(
            eq(companySecretProposals.companyId, companyId),
            eq(companySecretProposals.status, "pending"),
            eq(companySecretProposals.secretProposalId, proposal.id),
          )).returning()
        : [];
      const actorType = input.resolvedByUserId ? "user" as const : status === "withdrawn" ? "agent" as const : "system" as const;
      const actorId = input.resolvedByUserId ?? input.proposerAgentId ?? "system";
      await logActivity(txDb, {
        companyId,
        actorType,
        actorId,
        action: `secret.proposal.${status}`,
        entityType: "company_secret_proposal",
        entityId: proposal.id,
        agentId: proposal.proposedByAgentId,
        runId: proposal.originRunId,
        details: { ciphertextScrubbed: true, issueId: proposal.originIssueId, reason: input.reason ?? null },
      });
      for (const dependent of dependents) {
        await logActivity(txDb, {
          companyId,
          actorType,
          actorId,
          action: "secret.proposal.rejected",
          entityType: "company_secret_proposal",
          entityId: dependent.id,
          agentId: dependent.proposedByAgentId,
          runId: dependent.originRunId,
          details: {
            ciphertextScrubbed: true,
            issueId: dependent.originIssueId,
            reason: dependent.resolutionReason,
            cascadeFromProposalId: proposal.id,
          },
        });
      }
      return updated;
    });
  }

  async function sweepExpired(
    now = new Date(),
    limit = DEFAULT_EXPIRY_SWEEP_LIMIT,
    expireProposal: (companyId: string, proposalId: string) => Promise<unknown> =
      (companyId, proposalId) => transition(companyId, proposalId, "expired", { reason: "Pending proposal expired" }),
  ) {
    const expired = await db.select({ id: companySecretProposals.id, companyId: companySecretProposals.companyId })
      .from(companySecretProposals)
      .where(and(eq(companySecretProposals.status, "pending"), lte(companySecretProposals.expiresAt, now)))
      .orderBy(companySecretProposals.expiresAt)
      .limit(limit);
    let expiredCount = 0;
    for (const proposal of expired) {
      try {
        await expireProposal(proposal.companyId, proposal.id);
        expiredCount += 1;
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) continue;
        throw error;
      }
    }
    return expiredCount;
  }

  return { getById, view: enrich, createSecret, createBinding, listForAgent, listForBoard, assertBindingSnapshotCurrent, approve, transition, sweepExpired };
}
