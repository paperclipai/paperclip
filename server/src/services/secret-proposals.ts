import { and, eq, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecretProposals, heartbeatRuns, issues } from "@paperclipai/db";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { logActivity } from "./activity-log.js";
import { normalizeSecretKey } from "./secrets.js";

const CONFIG_PATH_RE = /^(?:env\.[A-Za-z_][A-Za-z0-9_]*|access\.[A-Za-z_][A-Za-z0-9_]*)$/;
const SECRET_NAME_RE = /^[^/\s]+(?:\/[^/\s]+)*$/;
export type SecretProposalTerminalStatus = "approved" | "rejected" | "withdrawn" | "expired";

export type ProposalRunContext = {
  companyId: string;
  heartbeatRunId: string;
  registerForRedaction: (value: string) => void | Promise<void>;
};

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

async function ancestorIds(db: Db, companyId: string, agentId: string) {
  const rows = await db.select({ id: agents.id, reportsTo: agents.reportsTo }).from(agents)
    .where(eq(agents.companyId, companyId));
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

export function createSecretProposalsService(db: Db) {
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
    const proposedKey = normalizeSecretKey(input.key?.trim() || name.split("/").at(-1) || "");
    if (!proposedKey) throw unprocessable("Secret key is required");
    const { run, originIssueId } = await loadRunContext(db, context);
    const prepared = await getSecretProvider("local_encrypted").createSecret({ value: input.value });
    await context.registerForRedaction(input.value);
    return db.insert(companySecretProposals).values({
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
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    }).returning().then((rows) => rows[0]);
  }

  async function createBinding(context: Pick<ProposalRunContext, "companyId" | "heartbeatRunId">, input: {
    secretId?: string | null;
    secretProposalId?: string | null;
    targetAgentId?: string | null;
    configPath: string;
    justification: string;
    bindingTargetPolicy: string;
  }) {
    if (Boolean(input.secretId) === Boolean(input.secretProposalId)) throw unprocessable("Exactly one secret reference is required");
    if (!CONFIG_PATH_RE.test(input.configPath)) throw unprocessable("configPath must use env.<KEY> or access.<ALIAS>");
    if (!input.justification.trim()) throw unprocessable("Justification is required");
    const { run, originIssueId } = await loadRunContext(db, context);
    const targetAgentId = input.targetAgentId ?? run.agentId;
    const [proposerAncestors, targetAncestors] = await Promise.all([
      ancestorIds(db, context.companyId, run.agentId),
      ancestorIds(db, context.companyId, targetAgentId),
    ]);
    return db.insert(companySecretProposals).values({
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
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    }).returning().then((rows) => rows[0]);
  }

  async function transition(companyId: string, proposalId: string, status: SecretProposalTerminalStatus, input: {
    resolvedByUserId?: string | null;
    reason?: string | null;
    proposerAgentId?: string | null;
  } = {}) {
    const proposal = await db.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.id, proposalId),
      eq(companySecretProposals.companyId, companyId),
    )).then((rows) => rows[0] ?? null);
    if (!proposal) throw notFound("Secret proposal not found");
    if (proposal.status !== "pending") throw unprocessable("Only pending proposals can be resolved");
    if (status === "withdrawn" && proposal.proposedByAgentId !== input.proposerAgentId) {
      throw forbidden("Only the proposer can withdraw this proposal");
    }
    const now = new Date();
    return db.transaction(async (tx) => {
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
      if (!updated) throw unprocessable("Proposal is no longer pending");
      if (proposal.kind === "secret" && (status === "rejected" || status === "expired")) {
        await tx.update(companySecretProposals).set({
          status: "rejected",
          resolvedAt: now,
          resolutionReason: `Dependent secret proposal ${proposal.id} was ${status}`,
          valueCiphertext: null,
          ciphertextScrubbedAt: now,
          updatedAt: now,
        }).where(and(
          eq(companySecretProposals.companyId, companyId),
          eq(companySecretProposals.status, "pending"),
          eq(companySecretProposals.secretProposalId, proposal.id),
        ));
      }
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: input.resolvedByUserId ? "user" : "system",
        actorId: input.resolvedByUserId ?? "system",
        action: `secret.proposal.${status}`,
        entityType: "company_secret_proposal",
        entityId: proposal.id,
        details: { ciphertextScrubbed: true },
      });
      return updated;
    });
  }

  async function sweepExpired(now = new Date()) {
    const expired = await db.select({ id: companySecretProposals.id, companyId: companySecretProposals.companyId })
      .from(companySecretProposals)
      .where(and(eq(companySecretProposals.status, "pending"), lte(companySecretProposals.expiresAt, now)));
    for (const proposal of expired) {
      await transition(proposal.companyId, proposal.id, "expired", { reason: "Pending proposal expired" });
    }
    return expired.length;
  }

  return { createSecret, createBinding, transition, sweepExpired };
}
