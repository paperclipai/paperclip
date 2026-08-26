import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyGovernancePolicies, companyGovernancePolicyRevisions } from "@paperclipai/db";
import {
  governancePolicyDocumentSchema,
  type GovernancePolicyBinding,
  type GovernancePolicyDocument,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";

export type GovernancePolicyTarget = {
  agentId: string;
  role: string | null;
  adapterType: string | null;
};

export type LoadedGovernancePolicy = {
  policyId: string;
  revisionId: string;
  revision: number;
  sha256: string;
  body: string;
  bindingId: string;
  delivery: "required" | "best_effort";
};

/** The delivery contract is fixed by Paperclip, not by editable role prompts.
 * A policy may constrain a run but cannot be weakened by task context or a
 * skill. Adapters map this to their strongest available instruction channel. */
export const GOVERNANCE_POLICY_PRECEDENCE = [
  "company_policy",
  "role_instructions",
  "task_context",
  "skills",
] as const;

export const DEFAULT_COMPANY_GOVERNANCE_POLICY: GovernancePolicyDocument = {
  schemaVersion: 1,
  body: `# Company governance policy

- Keep one machine-visible next path: a live or queued run, assigned todo, real blocker, active review, or done with evidence.
- Route work to the responsible role. Do not assign technical, QA, recovery, or operational work to the founder; use a single explicit interaction only for a non-delegable founder decision.
- After two equivalent scope-mismatch outcomes, do not start a third run for the same executor; route to CTO/QA or create one non-duplicating corrective issue.
- Before validation record original scope, changed surfaces, affected contracts, blocking tests, diagnostic tests, external failures, and dependency decision. Review comments must include validation_scope.
- Every substantive review uses gpt-5.6-luna with fastMode=false and reasoningEffort=medium; reviewer records a machine decision before CTO approval.
- Before reopening a done or blocked issue validate its execution workspace. Clear stale workspace linkage through the API; never recreate a vanished worktree or erase changes to mask a problem.
- Send text JSON from Windows PowerShell as UTF-8 bytes with application/json; charset=utf-8, then read it back and compare it. A mismatch or four question marks is a failed mutation.
- Never set done manually to mask infrastructure, recovery, encoding, sandbox, setup, or cleanup failures.
`,
  bindings: [{
    id: "all-codex-heartbeats",
    priority: 100,
    effect: "include",
    subject: { type: "all_agents" },
    scopes: ["heartbeat"],
    adapterTypes: ["codex_local", "paperclip_runner"],
    delivery: "required",
  }],
};

export type GovernancePolicyReadback = {
  active: (typeof companyGovernancePolicyRevisions.$inferSelect) | null;
  history: Array<typeof companyGovernancePolicyRevisions.$inferSelect>;
  /** Current resolution for every agent. This is intentionally computed at
   * read time so binding changes and newly hired agents are visible without a
   * write-side cache that could drift from the immutable revision. */
  targets: Array<{
    agentId: string;
    name: string;
    role: string | null;
    adapterType: string | null;
    bindingId: string | null;
    delivery: "required" | "best_effort" | null;
    included: boolean;
  }>;
  /** A non-null status is operational evidence that the stored revision has
   * not been altered out-of-band. */
  drift: { detected: boolean; reason: "sha256_mismatch" | null } | null;
};

function roleMatches(candidate: string | null, roles: string[]) {
  const normalized = candidate?.trim().toLocaleLowerCase();
  return Boolean(normalized && roles.some((role) => role.trim().toLocaleLowerCase() === normalized));
}

export function resolveGovernancePolicyBinding(
  bindings: GovernancePolicyBinding[],
  target: GovernancePolicyTarget,
): GovernancePolicyBinding | null {
  return [...bindings]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .find((binding) => {
      if (!binding.scopes.includes("heartbeat")) return false;
      if (binding.adapterTypes && (!target.adapterType || !(binding.adapterTypes as string[]).includes(target.adapterType))) return false;
      if (binding.subject.type === "all_agents") return true;
      if (binding.subject.type === "agents") return binding.subject.agentIds.includes(target.agentId);
      return roleMatches(target.role, binding.subject.roles);
    }) ?? null;
}

function sha256(body: string) {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function policyHash(policy: GovernancePolicyDocument): string {
  return sha256(stableJson({
    schemaVersion: policy.schemaVersion,
    body: policy.body,
    bindings: policy.bindings,
  }));
}

export function companyGovernancePolicyService(db: Db) {
  async function active(companyId: string, database: Db = db) {
    const policy = await database.select().from(companyGovernancePolicies)
      .where(eq(companyGovernancePolicies.companyId, companyId)).then((rows) => rows[0] ?? null);
    if (!policy?.activeRevisionId) return null;
    return database.select().from(companyGovernancePolicyRevisions)
      .where(and(
        eq(companyGovernancePolicyRevisions.companyId, companyId),
        eq(companyGovernancePolicyRevisions.id, policy.activeRevisionId),
      )).then((rows) => rows[0] ?? null);
  }

  async function get(companyId: string): Promise<GovernancePolicyReadback> {
    const revision = await active(companyId);
    if (!revision) return { active: null, history: [], targets: [], drift: null };
    const history = await db.select().from(companyGovernancePolicyRevisions)
      .where(eq(companyGovernancePolicyRevisions.companyId, companyId))
      .orderBy(desc(companyGovernancePolicyRevisions.revision));
    const document = governancePolicyDocumentSchema.parse({
      schemaVersion: revision.schemaVersion,
      body: revision.body,
      bindings: revision.bindings,
    });
    const companyAgents = await db.select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      adapterType: agents.adapterType,
    }).from(agents).where(eq(agents.companyId, companyId));
    const targets = companyAgents.map((agent) => {
      const binding = resolveGovernancePolicyBinding(document.bindings, {
        agentId: agent.id,
        role: agent.role,
        adapterType: agent.adapterType,
      });
      const included = Boolean(binding && binding.effect === "include");
      return {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        adapterType: agent.adapterType,
        bindingId: binding?.id ?? null,
        delivery: included ? binding!.delivery : null,
        included,
      };
    });
    const storedPolicyHash = policyHash(document);
    return {
      active: revision,
      history,
      targets,
      drift: {
        detected: storedPolicyHash !== revision.sha256,
        reason: storedPolicyHash === revision.sha256 ? null : "sha256_mismatch",
      },
    };
  }

  async function resolveForHeartbeat(companyId: string, agentId: string): Promise<LoadedGovernancePolicy | null> {
    const revision = await active(companyId);
    if (!revision) return null;
    const agent = await db.select({ id: agents.id, role: agents.role, adapterType: agents.adapterType })
      .from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    const document = governancePolicyDocumentSchema.parse({
      schemaVersion: revision.schemaVersion,
      body: revision.body,
      bindings: revision.bindings,
    });
    const binding = resolveGovernancePolicyBinding(document.bindings, {
      agentId: agent.id,
      role: agent.role,
      adapterType: agent.adapterType,
    });
    if (!binding || binding.effect === "exclude") return null;
    return {
      policyId: revision.policyId,
      revisionId: revision.id,
      revision: revision.revision,
      sha256: revision.sha256,
      body: revision.body,
      bindingId: binding.id,
      delivery: binding.delivery,
    };
  }

  type ReplaceInput = {
    companyId: string;
    expectedRevision: number;
    policy: GovernancePolicyDocument;
    activity: Omit<LogActivityInput, "companyId" | "action" | "entityType" | "entityId" | "details">;
  };

  /**
   * The policy pointer is the CAS lock.  Locking it before reading the active
   * revision makes two PUTs with the same expected revision serialize: one
   * creates the immutable revision and the other observes a typed 409 instead
   * of losing to the unique revision index with a 500.
   */
  async function replaceInTransaction(tx: Db, input: ReplaceInput) {
      const policy = governancePolicyDocumentSchema.parse(input.policy);
      let existing = await tx.select().from(companyGovernancePolicies)
        .where(eq(companyGovernancePolicies.companyId, input.companyId)).for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        await tx.insert(companyGovernancePolicies)
          .values({ id: randomUUID(), companyId: input.companyId })
          .onConflictDoNothing({ target: companyGovernancePolicies.companyId });
        existing = await tx.select().from(companyGovernancePolicies)
          .where(eq(companyGovernancePolicies.companyId, input.companyId)).for("update")
          .then((rows) => rows[0] ?? null);
      }
      if (!existing) throw new Error("governance_policy_pointer_unavailable");
      const current = existing?.activeRevisionId
        ? await tx.select().from(companyGovernancePolicyRevisions)
          .where(eq(companyGovernancePolicyRevisions.id, existing.activeRevisionId)).then((rows) => rows[0] ?? null)
        : null;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        throw conflict("Governance policy revision is stale", {
          code: "governance_policy_revision_conflict", expectedRevision: input.expectedRevision, currentRevision,
        });
      }
      const policyId = existing.id;
      const [revision] = await tx.insert(companyGovernancePolicyRevisions).values({
        companyId: input.companyId,
        policyId,
        revision: currentRevision + 1,
        schemaVersion: policy.schemaVersion,
        body: policy.body,
        bindings: policy.bindings,
        sha256: policyHash(policy),
        createdByAgentId: input.activity.agentId ?? null,
        createdByUserId: input.activity.actorType === "user" ? input.activity.actorId : null,
      }).returning();
      await tx.update(companyGovernancePolicies).set({ activeRevisionId: revision!.id, updatedAt: new Date() })
        .where(eq(companyGovernancePolicies.id, policyId));
      await logActivity(tx as unknown as Db, {
        ...input.activity,
        companyId: input.companyId,
        action: "company.governance_policy_replaced",
        entityType: "company_governance_policy",
        entityId: policyId,
        details: { revision: revision!.revision, sha256: revision!.sha256, bindingCount: policy.bindings.length },
      });
      return revision!;
  }

  async function replace(input: ReplaceInput) {
    return db.transaction((tx) => replaceInTransaction(tx as unknown as Db, input));
  }

  async function restore(input: {
    companyId: string;
    revisionId: string;
    expectedRevision: number;
    activity: ReplaceInput["activity"];
  }) {
    const source = await db.select().from(companyGovernancePolicyRevisions)
      .where(and(
        eq(companyGovernancePolicyRevisions.companyId, input.companyId),
        eq(companyGovernancePolicyRevisions.id, input.revisionId),
      )).then((rows) => rows[0] ?? null);
    if (!source) throw notFound("Governance policy revision not found");
    // Restore is deliberately a replacement, never a pointer rewind: this
    // writes a new immutable revision and preserves the full audit history.
    return replace({
      companyId: input.companyId,
      expectedRevision: input.expectedRevision,
      policy: governancePolicyDocumentSchema.parse({
        schemaVersion: source.schemaVersion,
        body: source.body,
        bindings: source.bindings,
      }),
      activity: input.activity,
    });
  }

  async function ensureDefaultInTransaction(tx: Db, companyId: string) {
    const current = await active(companyId, tx);
    if (current) return current;
    try {
      return await replaceInTransaction(tx, {
        companyId,
        expectedRevision: 0,
        policy: DEFAULT_COMPANY_GOVERNANCE_POLICY,
        activity: { actorType: "system", actorId: "system", agentId: null, runId: null },
      });
    } catch (error) {
      // A concurrent creator won the revision-0 CAS. Return its immutable
      // revision rather than replacing a board-provided policy.
      if (error && typeof error === "object" && (error as { status?: number }).status === 409) {
        const concurrent = await active(companyId, tx);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  async function ensureDefault(companyId: string) {
    return db.transaction((tx) => ensureDefaultInTransaction(tx as unknown as Db, companyId));
  }

  return { get, replace, restore, ensureDefault, ensureDefaultInTransaction, resolveForHeartbeat };
}
