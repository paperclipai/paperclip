import { randomUUID } from "node:crypto";
import { SECRET_PROPOSAL_BINDING_GROUP_LIMIT, withAgentAppearance } from "@paperclipai/shared";
import { and, asc, count, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySecretBindings,
  companySecretProposals,
  companySecrets,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
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

  async function creationQuotaDenial(dbClient: Db, input: CreationQuotaInput, creating = 1) {
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
    // Both caps bound rows, and a group writes one row per binding. Counting the
    // whole batch keeps the bound honest: a group that fits only by being one
    // card would otherwise raise the number of undecided rows an agent can hold.
    const denial = pending + creating > MAX_PENDING_PROPOSALS_PER_AGENT
      ? { code: "pending_cap", message: `Agents may have at most ${MAX_PENDING_PROPOSALS_PER_AGENT} pending secret proposals` }
      : recent + creating > MAX_PROPOSALS_PER_MINUTE
        ? { code: "rate_limit", message: `Agents may create at most ${MAX_PROPOSALS_PER_MINUTE} secret proposals per minute` }
        : null;
    return denial ? { ...denial, pending, recent } : null;
  }

  async function createWithinQuota<T>(input: CreationQuotaInput, create: (txDb: Db) => Promise<T>, creating = 1) {
    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.companyId}), hashtext(${input.agentId}))`);
      const denial = await creationQuotaDenial(txDb, input, creating);
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

  // One card per ask. A grouped ask raises one card for its anchor and lists
  // every binding it covers, because the human decides the group, not the rows:
  // seven cards asking about seven keys is the cost this grouping removes.
  async function createBindingInteraction(
    txDb: Db,
    proposal: Proposal,
    members: Array<{ proposal: Proposal; sourceSecretLabel: string; configPath: string }>,
  ) {
    if (!proposal.originIssueId || !proposal.targetId || !proposal.configPath) return proposal;
    const target = await txDb
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, proposal.targetId), eq(agents.companyId, proposal.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!target) throw notFound("Target agent not found");

    const anchorLabel = members.find((member) => member.proposal.id === proposal.id)?.sourceSecretLabel
      ?? proposal.configPath;
    const grouped = members.length > 1;
    const [interaction] = await txDb
      .insert(issueThreadInteractions)
      .values({
        companyId: proposal.companyId,
        issueId: proposal.originIssueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        resolverPolicyProvenance: "explicit",
        effectiveResolverPolicySource: "governed_action",
        idempotencyKey: `secret-proposal:${proposal.id}`,
        sourceRunId: proposal.originRunId,
        title: grouped ? `Confirm ${members.length} secret bindings` : "Confirm secret binding",
        summary: grouped
          ? `Bind ${members.length} secrets to ${target.name}`
          : `Bind ${anchorLabel} to ${target.name} as ${proposal.configPath}`,
        createdByAgentId: proposal.proposedByAgentId,
        addresseeAgentId: null,
        payload: {
          version: 1,
          prompt: grouped
            ? `Bind ${members.length} secrets to ${target.name}?`
            : `Bind secret ${anchorLabel} to ${target.name} as ${proposal.configPath}?`,
          acceptLabel: grouped ? "Create bindings" : "Create binding",
          rejectLabel: "Reject",
          rejectRequiresReason: true,
          rejectReasonLabel: grouped
            ? "Why should these bindings not be created?"
            : "Why should this binding not be created?",
          allowDeclineReason: true,
          supersedeOnUserComment: false,
          secretProposal: {
            version: 1,
            proposalId: proposal.id,
            sourceSecretLabel: anchorLabel,
            configPath: proposal.configPath,
            targetAgentId: proposal.targetId,
            targetAgentName: target.name,
            justification: proposal.justification,
            expiresAt: proposal.expiresAt.toISOString(),
            ...(grouped
              ? {
                  proposalIds: members.map((member) => member.proposal.id),
                  bindings: members.map((member) => ({
                    proposalId: member.proposal.id,
                    sourceSecretLabel: member.sourceSecretLabel,
                    configPath: member.configPath,
                  })),
                }
              : {}),
          },
        },
      })
      .returning();

    const [linked] = await txDb
      .update(companySecretProposals)
      .set({ interactionId: interaction.id, updatedAt: new Date() })
      .where(eq(companySecretProposals.id, proposal.id))
      .returning();
    await txDb.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, proposal.originIssueId));
    await logActivity(txDb, {
      companyId: proposal.companyId,
      actorType: "agent",
      actorId: proposal.proposedByAgentId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: proposal.originIssueId,
      agentId: proposal.proposedByAgentId,
      runId: proposal.originRunId,
      details: {
        interactionId: interaction.id,
        interactionKind: "request_confirmation",
        interactionStatus: "pending",
        continuationPolicy: "wake_assignee",
        addresseeAgentId: null,
        requestedResolverPolicy: "board_only",
        effectiveResolverPolicy: "board_only",
        serverOwnedPayload: "secretProposal",
      },
    });
    return linked;
  }

  async function reflectProposalLifecycleOnInteraction(
    txDb: Db,
    proposal: Proposal,
    outcome: "approved" | "rejected" | "withdrawn" | "expired",
    input: { resolvedByUserId?: string | null; reason?: string | null } = {},
  ) {
    if (!proposal.interactionId) return;
    const current = await txDb
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.id, proposal.interactionId),
        eq(issueThreadInteractions.companyId, proposal.companyId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!current || (current.status !== "pending" && !(outcome === "approved" && current.status === "accepted"))) return;
    const payload = asRecord(current.payload);
    const linked = asRecord(payload.secretProposal);
    if (linked.proposalId !== proposal.id) return;

    const now = new Date();
    const currentResult = asRecord(current.result);
    const status = outcome === "approved"
      ? "accepted"
      : outcome === "rejected"
        ? "rejected"
        : outcome === "withdrawn"
          ? "cancelled"
          : "expired";
    const resultOutcome = outcome === "approved"
      ? "accepted"
      : outcome === "rejected"
        ? "rejected"
        : "withdrawn";
    await txDb
      .update(issueThreadInteractions)
      .set({
        status,
        result: {
          ...currentResult,
          version: 1,
          outcome: resultOutcome,
          ...(input.reason ? { reason: input.reason } : {}),
          secretProposal: {
            version: 1,
            status: outcome === "approved" ? "executed" : outcome,
            updatedAt: now.toISOString(),
          },
        },
        resolvedByUserId: input.resolvedByUserId ?? current.resolvedByUserId ?? null,
        resolvedAt: current.resolvedAt ?? now,
        updatedAt: now,
      })
      .where(and(
        eq(issueThreadInteractions.id, current.id),
        inArray(issueThreadInteractions.status, outcome === "approved" ? ["pending", "accepted"] : ["pending"]),
      ));
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

  type BindingEntryInput = {
    secretId?: string | null;
    sourceConfigPath?: string | null;
    secretProposalId?: string | null;
    configPath: string;
  };
  type BindingTargetInput = { targetAgentId?: string | null };
  type BindingProposalContext = Pick<ProposalRunContext, "companyId" | "heartbeatRunId">;

  function assertBindingEntryShape(entry: BindingEntryInput) {
    const referenceCount = [entry.secretId, entry.sourceConfigPath, entry.secretProposalId]
      .filter((value) => Boolean(value)).length;
    if (referenceCount !== 1) {
      throw badRequest(
        "Binding proposals require exactly one of secretId, sourceConfigPath, or secretProposalId",
      );
    }
    if (!CONFIG_PATH_RE.test(entry.configPath)) throw unprocessable("configPath must use env.<KEY> or access.<ALIAS>");
    if (entry.sourceConfigPath && !CONFIG_PATH_RE.test(entry.sourceConfigPath)) {
      throw unprocessable("sourceConfigPath must use env.<KEY> or access.<ALIAS>");
    }
  }

  function assertBindingJustification(justification: string) {
    if (!justification.trim()) throw unprocessable("Justification is required");
    if (justification.trim().length > 20_000) throw unprocessable("Justification must be at most 20000 characters");
  }

  // Resolves the secret a binding entry points at, without the dependency row:
  // a secretProposalId reference is resolved inside the creating transaction,
  // where its pending row is locked.
  async function resolveBindingEntrySecret(
    context: BindingProposalContext,
    run: { agentId: string; responsibleUserId: string | null },
    entry: BindingEntryInput,
  ) {
    let resolvedSecretId = entry.secretId ?? null;
    let sourceSecretLabel: string | null = null;
    if (entry.sourceConfigPath) {
      const sourceBinding = await db.select({ secretId: companySecretBindings.secretId })
        .from(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, context.companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, run.agentId),
          eq(companySecretBindings.configPath, entry.sourceConfigPath),
        ))
        .then((rows) => rows[0] ?? null);
      if (sourceBinding) {
        resolvedSecretId = sourceBinding.secretId;
      } else if (run.responsibleUserId) {
        const sourceDeclaration = await db
          .select({ secretId: companySecrets.id })
          .from(userSecretDeclarations)
          .innerJoin(companySecrets, and(
            eq(companySecrets.companyId, context.companyId),
            eq(companySecrets.scope, "user"),
            eq(companySecrets.ownerUserId, run.responsibleUserId),
            eq(companySecrets.userSecretDefinitionId, userSecretDeclarations.userSecretDefinitionId),
            eq(companySecrets.status, "active"),
          ))
          .where(and(
            eq(userSecretDeclarations.companyId, context.companyId),
            eq(userSecretDeclarations.targetType, "agent"),
            eq(userSecretDeclarations.targetId, run.agentId),
            eq(userSecretDeclarations.configPath, entry.sourceConfigPath),
          ))
          .then((rows) => rows[0] ?? null);
        resolvedSecretId = sourceDeclaration?.secretId ?? null;
      }
      if (!resolvedSecretId) throw notFound("Source secret binding not found");
    }
    if (resolvedSecretId) {
      const secret = await db.select().from(companySecrets).where(and(
        eq(companySecrets.id, resolvedSecretId),
        eq(companySecrets.companyId, context.companyId),
      )).then((rows) => rows[0] ?? null);
      const sourceBindingAllowsUserSecret = Boolean(entry.sourceConfigPath) && secret?.scope === "user";
      if (
        !secret
        || secret.status === "deleted"
        || (secret.scope !== "company" && !sourceBindingAllowsUserSecret)
      ) {
        throw notFound("Secret not found");
      }
      sourceSecretLabel = secret.name;
    }
    return { resolvedSecretId, sourceSecretLabel };
  }

  // Labels a secretProposalId entry from its dependency row and locks that row.
  // Callers hold the creating transaction, so the dependency cannot be resolved
  // between the check and the insert.
  async function resolveBindingEntryDependency(
    txDb: Db,
    companyId: string,
    entry: BindingEntryInput,
  ) {
    if (!entry.secretProposalId) return null;
    const dependency = await txDb.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.id, entry.secretProposalId),
      eq(companySecretProposals.companyId, companyId),
    )).for("update").then((rows) => rows[0] ?? null);
    if (!dependency || dependency.kind !== "secret") throw notFound("Secret proposal not found");
    if (dependency.status !== "pending") {
      throw unprocessable(
        "Prerequisite secret proposal is no longer pending; use secretId to reference an approved secret",
      );
    }
    return dependency.proposedName;
  }

  async function createBinding(context: BindingProposalContext, input: {
    secretId?: string | null;
    sourceConfigPath?: string | null;
    secretProposalId?: string | null;
    targetAgentId?: string | null;
    configPath: string;
    justification: string;
    bindingTargetPolicy: "self_and_reports";
  }) {
    assertBindingEntryShape(input);
    assertBindingJustification(input.justification);
    const { run, originIssueId } = await loadRunContext(db, context);
    const targetAgentId = input.targetAgentId ?? run.agentId;
    const [proposerAncestors, targetAncestors] = await Promise.all([
      ancestorIds(db, context.companyId, run.agentId),
      ancestorIds(db, context.companyId, targetAgentId),
    ]);
    if (!bindingTargetAllowed(run.agentId, targetAgentId, targetAncestors)) {
      throw forbidden("Binding proposals may target only the proposing agent or its reports");
    }
    const { resolvedSecretId, sourceSecretLabel: resolvedLabel } = await resolveBindingEntrySecret(context, run, input);
    return createWithinQuota(
      { companyId: context.companyId, agentId: run.agentId, runId: run.id, issueId: originIssueId },
      async (txDb) => {
        const dependencyLabel = await resolveBindingEntryDependency(txDb, context.companyId, input);
        const sourceSecretLabel = dependencyLabel ?? resolvedLabel;
        const proposal = await txDb.insert(companySecretProposals).values({
          companyId: context.companyId,
          kind: "binding",
          justification: input.justification.trim(),
          secretId: resolvedSecretId,
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
        if (!sourceSecretLabel) throw conflict("Binding proposal source secret label is unavailable");
        return createBindingInteraction(txDb, proposal, [{
          proposal,
          sourceSecretLabel,
          configPath: input.configPath,
        }]);
      },
    );
  }

  // One ask for N bindings. Every binding stays its own proposal row, so the
  // config-path validation, the secret reference and its foreign key, the
  // chain-of-command snapshot and the per-binding audit entry are unchanged.
  // What the group adds is the unit the human decides: one card, one expiry,
  // one resolution, with each binding still separately rejectable.
  async function createBindingGroup(context: BindingProposalContext, input: {
    bindings: BindingEntryInput[];
    targetAgentId?: string | null;
    justification: string;
    bindingTargetPolicy: "self_and_reports";
  }) {
    if (input.bindings.length === 0) throw badRequest("A binding group requires at least one binding");
    if (input.bindings.length > SECRET_PROPOSAL_BINDING_GROUP_LIMIT) {
      throw unprocessable(`A binding group may carry at most ${SECRET_PROPOSAL_BINDING_GROUP_LIMIT} bindings`);
    }
    assertBindingJustification(input.justification);
    const seen = new Set<string>();
    for (const entry of input.bindings) {
      assertBindingEntryShape(entry);
      if (seen.has(entry.configPath)) throw unprocessable(`Duplicate configPath in binding group: ${entry.configPath}`);
      seen.add(entry.configPath);
    }
    const { run, originIssueId } = await loadRunContext(db, context);
    const targetAgentId = input.targetAgentId ?? run.agentId;
    const [proposerAncestors, targetAncestors] = await Promise.all([
      ancestorIds(db, context.companyId, run.agentId),
      ancestorIds(db, context.companyId, targetAgentId),
    ]);
    if (!bindingTargetAllowed(run.agentId, targetAgentId, targetAncestors)) {
      throw forbidden("Binding proposals may target only the proposing agent or its reports");
    }
    const resolved: Array<{
      entry: BindingEntryInput;
      resolvedSecretId: string | null;
      sourceSecretLabel: string | null;
    }> = [];
    for (const entry of input.bindings) {
      resolved.push({
        entry,
        ...(await resolveBindingEntrySecret(context, run, entry)),
      });
    }
    const groupId = randomUUID();
    // One expiry for the whole group: they are one ask, so they lapse together
    // and a re-raised ask is again one card rather than one per binding.
    const expiresAt = new Date(Date.now() + PENDING_EXPIRY_MS);
    return createWithinQuota(
      { companyId: context.companyId, agentId: run.agentId, runId: run.id, issueId: originIssueId },
      async (txDb) => {
        const members: Array<{ proposal: Proposal; sourceSecretLabel: string; configPath: string }> = [];
        let anchor: Proposal | null = null;
        for (const { entry, resolvedSecretId, sourceSecretLabel: resolvedLabel } of resolved) {
          const dependencyLabel = await resolveBindingEntryDependency(txDb, context.companyId, entry);
          const sourceSecretLabel = dependencyLabel ?? resolvedLabel;
          if (!sourceSecretLabel) throw conflict("Binding proposal source secret label is unavailable");
          const proposal = await txDb.insert(companySecretProposals).values({
            companyId: context.companyId,
            kind: "binding",
            justification: input.justification.trim(),
            secretId: resolvedSecretId,
            secretProposalId: entry.secretProposalId ?? null,
            targetType: "agent",
            targetId: targetAgentId,
            configPath: entry.configPath,
            groupId,
            bindingTargetPolicySnapshot: input.bindingTargetPolicy,
            proposerAncestorIdsSnapshot: proposerAncestors,
            targetAncestorIdsSnapshot: targetAncestors,
            proposedByAgentId: run.agentId,
            originIssueId,
            originRunId: run.id,
            expiresAt,
          }).returning().then((rows) => rows[0]);
          await recordCreated(proposal, txDb);
          anchor ??= proposal;
          members.push({ proposal, sourceSecretLabel, configPath: entry.configPath });
        }
        if (!anchor) throw conflict("Binding group is empty");
        return createBindingInteraction(txDb, anchor, members);
      },
      input.bindings.length,
    );
  }

  async function enrich(proposal: Proposal) {
    const [proposer, target, originIssue, secret, secretProposal] = await Promise.all([
      db.select({ id: agents.id, name: agents.name, icon: agents.icon, appearance: agents.appearance }).from(agents)
        .where(eq(agents.id, proposal.proposedByAgentId)).then((rows) => rows[0] ?? null),
      proposal.targetId
        ? db.select({ id: agents.id, name: agents.name, icon: agents.icon, appearance: agents.appearance }).from(agents)
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
      proposedBy: withAgentAppearance(proposer),
      target: target ? withAgentAppearance(target) : null,
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
    // A grouped ask reflects its whole outcome on the one card once, at the end
    // of the group's resolution, so a member does not mark the card accepted
    // while its siblings are still undecided.
    reflectInteraction?: boolean;
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
    if (input.reflectInteraction !== false) {
      await reflectProposalLifecycleOnInteraction(txDb, proposal, "approved", {
        resolvedByUserId: input.resolvedByUserId,
      });
    }
    return updated;
  }

  async function applyBindingApproval(
    txDb: Db,
    proposal: Proposal,
    secret: typeof companySecrets.$inferSelect,
    resolvedByUserId: string,
  ) {
    if (!proposal.targetId || !proposal.configPath) throw conflict("Binding proposal is incomplete");
    const agentSvc = agentService(txDb);
    const target = await agentSvc.getById(proposal.targetId);
    if (!target || target.companyId !== proposal.companyId) throw notFound("Target agent not found");
    const adapterConfig = { ...asRecord(target.adapterConfig) };
    const [namespace, key] = proposal.configPath.split(".", 2);
    const userSecretDefinition = secret.scope === "user" && secret.userSecretDefinitionId
      ? await txDb.select({ key: userSecretDefinitions.key }).from(userSecretDefinitions).where(and(
          eq(userSecretDefinitions.id, secret.userSecretDefinitionId),
          eq(userSecretDefinitions.companyId, proposal.companyId),
          eq(userSecretDefinitions.status, "active"),
        )).then((rows) => rows[0] ?? null)
      : null;
    if (secret.scope === "user" && !userSecretDefinition) {
      throw conflict("Binding proposal user secret definition is not active");
    }
    const binding = userSecretDefinition
      ? {
          type: "user_secret_ref",
          key: userSecretDefinition.key,
          version: "latest",
          required: true,
          allowMissingOverride: false,
        }
      : { type: "secret_ref", secretId: secret.id, version: "latest" };
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

  // The row set a resolution acts on: one proposal on its own, or every member
  // of its group. Locked in id order so two paths that resolve the same group
  // take the same locks in the same sequence.
  async function lockResolutionSet(txDb: Db, companyId: string, proposal: Proposal) {
    return txDb.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.companyId, companyId),
      proposal.groupId
        ? eq(companySecretProposals.groupId, proposal.groupId)
        : eq(companySecretProposals.id, proposal.id),
    )).orderBy(asc(companySecretProposals.id)).for("update");
  }

  // The rows a past decision covered, read after the fact: one proposal on its
  // own, or every member of its group.
  async function resolutionSet(companyId: string, proposal: Proposal) {
    if (!proposal.groupId) return [proposal];
    return db.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.companyId, companyId),
      eq(companySecretProposals.groupId, proposal.groupId),
    )).orderBy(asc(companySecretProposals.id));
  }

  async function rejectPending(txDb: Db, proposal: Proposal, input: {
    resolvedByUserId?: string | null;
    reason?: string | null;
  }) {
    if (proposal.status !== "pending") throw conflict("Proposal is no longer pending");
    const now = new Date();
    const [updated] = await txDb.update(companySecretProposals).set({
      status: "rejected",
      resolvedByUserId: input.resolvedByUserId ?? null,
      resolvedAt: now,
      resolutionReason: input.reason ?? null,
      valueCiphertext: null,
      ciphertextScrubbedAt: now,
      updatedAt: now,
    }).where(and(
      eq(companySecretProposals.id, proposal.id),
      eq(companySecretProposals.status, "pending"),
    )).returning();
    if (!updated) throw conflict("Proposal is no longer pending");
    await logActivity(txDb, {
      companyId: proposal.companyId,
      actorType: input.resolvedByUserId ? "user" as const : "system" as const,
      actorId: input.resolvedByUserId ?? "system",
      action: "secret.proposal.rejected",
      entityType: "company_secret_proposal",
      entityId: proposal.id,
      agentId: proposal.proposedByAgentId,
      runId: proposal.originRunId,
      details: {
        ciphertextScrubbed: true,
        issueId: proposal.originIssueId,
        reason: input.reason ?? null,
        ...(proposal.groupId ? { groupId: proposal.groupId } : {}),
      },
    });
    return updated;
  }

  // One card, one outcome. The group is written up once, after every binding in
  // it is resolved, so a member does not mark the card accepted while its
  // siblings are still undecided.
  async function reflectGroupOutcomeOnInteraction(
    txDb: Db,
    anchor: Proposal,
    outcome: {
      resolvedByUserId: string;
      reason?: string | null;
      bindings: Array<{ proposalId: string; configPath: string | null; status: string }>;
    },
  ) {
    if (!anchor.interactionId) return;
    const current = await txDb
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.id, anchor.interactionId),
        eq(issueThreadInteractions.companyId, anchor.companyId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    const accepted = outcome.bindings.some((binding) => binding.status === "approved");
    // Mirror the single-proposal rule: a card still awaiting a decision is
    // written, and an accepted card may still receive the executed outcome the
    // card-accepting path records. Any other terminal card keeps its own result.
    if (!current) return;
    if (current.status !== "pending" && !(accepted && current.status === "accepted")) return;
    const payload = asRecord(current.payload);
    if (asRecord(payload.secretProposal).proposalId !== anchor.id) return;

    const now = new Date();
    const currentResult = asRecord(current.result);
    await txDb
      .update(issueThreadInteractions)
      .set({
        status: accepted ? "accepted" : "rejected",
        result: {
          ...currentResult,
          version: 1,
          outcome: accepted ? "accepted" : "rejected",
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          secretProposal: {
            version: 1,
            status: accepted ? "executed" : "rejected",
            updatedAt: now.toISOString(),
            bindings: outcome.bindings,
          },
        },
        resolvedByUserId: outcome.resolvedByUserId,
        resolvedAt: current.resolvedAt ?? now,
        updatedAt: now,
      })
      .where(and(
        eq(issueThreadInteractions.id, current.id),
        inArray(issueThreadInteractions.status, accepted ? ["pending", "accepted"] : ["pending"]),
      ));
  }

  async function applyApproval(txDb: Db, proposal: Proposal, input: {
    resolvedByUserId: string;
    cascade?: boolean;
    overrides?: { name?: string; description?: string | null; providerConfigId?: string | null };
  }, options: { reflectInteraction?: boolean } = {}) {
    if (proposal.kind === "secret") {
      const created = await applySecretApproval(txDb, proposal, input);
      return markApproved(txDb, proposal, {
        resolvedByUserId: input.resolvedByUserId,
        createdSecretId: created.id,
        reflectInteraction: options.reflectInteraction,
      });
    }

    const companyId = proposal.companyId;
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
      throw conflict("Binding proposal secret is not active");
    }
    await applyBindingApproval(txDb, proposal, liveSecret, input.resolvedByUserId);
    return markApproved(txDb, proposal, {
      resolvedByUserId: input.resolvedByUserId,
      appliedBindingConfigPath: proposal.configPath,
      reflectInteraction: options.reflectInteraction,
    });
  }

  async function approve(companyId: string, proposalId: string, input: {
    resolvedByUserId: string;
    cascade?: boolean;
    overrides?: { name?: string; description?: string | null; providerConfigId?: string | null };
    // Bindings of the group the approver declines. They are resolved in the
    // same transaction as the approvals, so the ask ends whole: the human can
    // drop one key without discarding the rest and without a second decision.
    rejectProposalIds?: string[] | null;
    rejectReason?: string | null;
    assertCanResolve?: (proposal: Proposal, txDb: Db) => Promise<void>;
  }) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // Which rows to lock is read without a lock. The group lock must be the
      // first row lock this transaction takes, and it must be taken in asc(id)
      // order: locking the addressed row first lets two approvals that name
      // different members of one group hold one row each and wait for the other,
      // which PostgreSQL aborts with 40P01. Every decision below reads the rows
      // this lock returned.
      const addressed = await getById(companyId, proposalId, txDb);
      if (!addressed) throw notFound("Secret proposal not found");

      if (!addressed.groupId) {
        const proposal = await requirePending(companyId, proposalId, txDb, true);
        assertNotExpired(proposal);
        await input.assertCanResolve?.(proposal, txDb);
        await assertBindingSnapshotCurrent(proposal, txDb, true);
        if (input.rejectProposalIds?.length) {
          throw badRequest("rejectProposalIds requires a grouped binding proposal");
        }
        return applyApproval(txDb, proposal, input);
      }

      const members = await lockResolutionSet(txDb, companyId, addressed);
      const proposal = members.find((member) => member.id === proposalId);
      if (!proposal) throw notFound("Secret proposal not found");
      if (proposal.status !== "pending") throw conflict("Only pending proposals can be resolved");
      assertNotExpired(proposal);
      const pendingMembers = members.filter((member) => member.status === "pending");
      const rejectIds = new Set(input.rejectProposalIds ?? []);
      for (const id of rejectIds) {
        if (!pendingMembers.some((member) => member.id === id)) {
          throw badRequest(`Proposal ${id} is not a pending binding of this group`);
        }
      }
      const approved = pendingMembers.filter((member) => !rejectIds.has(member.id));
      const rejected = pendingMembers.filter((member) => rejectIds.has(member.id));
      if (approved.length === 0) {
        throw badRequest("Approve at least one binding, or reject the proposal");
      }
      for (const member of approved) {
        assertNotExpired(member);
        await input.assertCanResolve?.(member, txDb);
        await assertBindingSnapshotCurrent(member, txDb, true);
      }
      for (const member of approved) {
        await applyApproval(txDb, member, input, { reflectInteraction: false });
      }
      for (const member of rejected) {
        await rejectPending(txDb, member, {
          resolvedByUserId: input.resolvedByUserId,
          reason: input.rejectReason ?? "Rejected while approving the rest of the group",
        });
      }
      // The card belongs to one member, and the approver need not have named it.
      // Reflecting on the addressed row would return early on a sibling whose
      // interactionId is null, leaving the card pending after a 200.
      const anchor = members.find((member) => member.interactionId) ?? proposal;
      await reflectGroupOutcomeOnInteraction(txDb, anchor, {
        resolvedByUserId: input.resolvedByUserId,
        reason: input.rejectReason ?? null,
        bindings: [...approved, ...rejected].map((member) => ({
          proposalId: member.id,
          configPath: member.configPath,
          status: rejectIds.has(member.id) ? "rejected" : "approved",
        })),
      });
      const resolved = await getById(companyId, proposal.id, txDb);
      if (!resolved) throw notFound("Secret proposal not found");
      return resolved;
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
    // Expiry and withdrawal are not decisions about a binding, they are the ask
    // ceasing to exist, so they take the whole group: a group that lapsed is
    // re-raised as one ask rather than six rows left hanging behind a dead card.
    // A rejection is a decision about one binding and stays with that binding.
    const cascadesToGroup = status === "expired" || status === "withdrawn";
    const now = new Date();
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const group = proposal.groupId && cascadesToGroup
        ? await lockResolutionSet(txDb, companyId, proposal)
        : [];
      const pendingMembers = group.filter((member) => member.status === "pending");
      const targets = pendingMembers.length > 0 ? pendingMembers.map((member) => member.id) : [proposalId];
      // Only the anchor carries the card, and it is not always the row the
      // caller named. Resolving a sibling still has to close the ask the human
      // sees, so reflect on whichever member owns it.
      const anchor = group.find((member) => member.interactionId) ?? proposal;
      const updated = await tx.update(companySecretProposals).set({
        status,
        resolvedByUserId: input.resolvedByUserId ?? null,
        resolvedAt: now,
        resolutionReason: input.reason ?? null,
        valueCiphertext: null,
        ciphertextScrubbedAt: now,
        updatedAt: now,
      }).where(and(inArray(companySecretProposals.id, targets), eq(companySecretProposals.status, "pending")))
        .returning();
      const target = updated.find((row) => row.id === proposalId) ?? null;
      // The addressed proposal is the one the caller asked about: whatever else
      // the group did, a caller who named a row that was already resolved gets
      // the same conflict it always got.
      if (!target) throw conflict("Proposal is no longer pending");
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
      const statusReason = input.reason ?? (status === "expired" ? "Pending proposal expired" : null);
      for (const row of updated) {
        // The addressed row is logged below with the caller's own detail; a
        // sibling records that it went with its group.
        if (row.id === proposalId) continue;
        await logActivity(txDb, {
          companyId,
          actorType,
          actorId,
          action: `secret.proposal.${status}`,
          entityType: "company_secret_proposal",
          entityId: row.id,
          agentId: row.proposedByAgentId,
          runId: row.originRunId,
          details: {
            ciphertextScrubbed: true,
            issueId: row.originIssueId,
            reason: statusReason,
            groupId: proposal.groupId,
            groupAnchorProposalId: proposalId,
          },
        });
      }
      await logActivity(txDb, {
        companyId,
        actorType,
        actorId,
        action: `secret.proposal.${status}`,
        entityType: "company_secret_proposal",
        entityId: proposal.id,
        agentId: proposal.proposedByAgentId,
        runId: proposal.originRunId,
        details: {
          ciphertextScrubbed: true,
          issueId: proposal.originIssueId,
          reason: statusReason,
          ...(updated.length > 1 ? { groupSize: updated.length, groupId: proposal.groupId } : {}),
        },
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
        await reflectProposalLifecycleOnInteraction(txDb, dependent, "rejected", {
          resolvedByUserId: input.resolvedByUserId,
          reason: dependent.resolutionReason,
        });
      }
      // The card belongs to the anchor, which is not always the row the caller
      // named: resolving a sibling still has to close the ask the human sees.
      await reflectProposalLifecycleOnInteraction(txDb, anchor, status, {
        resolvedByUserId: input.resolvedByUserId,
        reason: statusReason,
      });
      return target;
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

  return { getById, view: enrich, createSecret, createBinding, createBindingGroup, listForAgent, listForBoard, resolutionSet, assertBindingSnapshotCurrent, approve, transition, sweepExpired };
}
