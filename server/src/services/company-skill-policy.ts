import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySkillPolicies, principalPermissionGrants } from "@paperclipai/db";
import {
  skillPolicyDocumentSchema,
  type EffectiveSkillPolicy,
  type SkillPolicyAction,
  type SkillPolicyDecision,
  type SkillPolicyDocument,
  type SkillPolicyEvaluationResource,
  type SkillPolicyRule,
  type SkillPolicySourceType,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";

export type SkillPolicyPrincipal = {
  type: "agent" | "board";
  id: string;
  role: string | null;
};

const OPEN_DEFAULT_POLICY: EffectiveSkillPolicy = {
  schemaVersion: 1,
  revision: 0,
  defaultEffect: "allow",
  rules: [],
  materialized: false,
};

function effectivePolicyFromRow(row: typeof companySkillPolicies.$inferSelect): EffectiveSkillPolicy {
  const document = skillPolicyDocumentSchema.parse({
    schemaVersion: row.schemaVersion,
    defaultEffect: row.defaultEffect,
    rules: row.rules,
  });
  return { ...document, revision: row.revision, materialized: true };
}

function normalizeRole(role: string | null) {
  return role?.trim().toLowerCase() || null;
}

function subjectMatches(rule: SkillPolicyRule, principal: SkillPolicyPrincipal) {
  if (rule.subject.type === "all_agents") return principal.type === "agent";
  if (rule.subject.type === "agents") {
    return principal.type === "agent" && rule.subject.agentIds.includes(principal.id);
  }
  const role = normalizeRole(principal.role);
  return Boolean(role && rule.subject.roles.some((candidate) => normalizeRole(candidate) === role));
}

function resourceMatches(rule: SkillPolicyRule, resource: SkillPolicyEvaluationResource) {
  const selector = rule.resources;
  if (!selector) return true;
  if (selector.skillIds && (!resource.skillId || !selector.skillIds.includes(resource.skillId))) return false;
  if (selector.skillKeys && (!resource.skillKey || !selector.skillKeys.includes(resource.skillKey))) return false;
  if (selector.sourceTypes && (!resource.sourceType || !selector.sourceTypes.includes(resource.sourceType))) return false;
  if (selector.sourceLocators && (!resource.sourceLocator || !selector.sourceLocators.includes(resource.sourceLocator))) return false;
  return true;
}

function decision(
  allowed: boolean,
  action: SkillPolicyAction,
  reason: SkillPolicyDecision["reason"],
  revision: number,
  matchedRuleId: string | null = null,
): SkillPolicyDecision {
  return {
    allowed,
    action,
    reason,
    policyRevision: revision,
    matchedRuleId,
    remediation: allowed ? null : "Contact a company administrator to change the skill policy.",
  };
}

export function normalizeSkillPolicySourceType(sourceType: string | null | undefined): SkillPolicySourceType {
  switch (sourceType?.trim().toLowerCase()) {
    case "local_path":
    case "workspace":
    case "project_scan":
      return "workspace";
    case "catalog":
    case "bundled":
    case "optional":
      return "catalog";
    case "git":
    case "github":
      return "git";
    case "skills_sh":
    case "external_package":
    case "npm":
      return "external_package";
    case "generated":
      return "generated";
    default:
      return "unknown";
  }
}

export function companySkillPolicyService(db: Db) {
  async function get(companyId: string): Promise<EffectiveSkillPolicy> {
    const row = await db
      .select()
      .from(companySkillPolicies)
      .where(eq(companySkillPolicies.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return row ? effectivePolicyFromRow(row) : { ...OPEN_DEFAULT_POLICY };
  }

  async function resolveAgentPrincipal(companyId: string, agentId: string): Promise<SkillPolicyPrincipal> {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, role: agents.role })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    if (agent.companyId !== companyId) {
      throw forbidden("Agent cannot be evaluated for another company", {
        code: "skill_company_boundary_denied",
      });
    }
    return { type: "agent", id: agent.id, role: agent.role };
  }

  async function hasLegacyCompatibilityGrant(companyId: string, principal: SkillPolicyPrincipal) {
    const principalType = principal.type === "agent" ? "agent" : "user";
    const row = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, principalType),
        eq(principalPermissionGrants.principalId, principal.id),
        inArray(principalPermissionGrants.permissionKey, ["skills:create", "skills:suggest-changes"]),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function evaluate(input: {
    companyId: string;
    principal: SkillPolicyPrincipal;
    action: SkillPolicyAction;
    resource?: SkillPolicyEvaluationResource;
  }): Promise<SkillPolicyDecision> {
    const policy = await get(input.companyId);
    if (!policy.materialized) {
      return decision(true, input.action, "no_policy_default", policy.revision);
    }
    const resource = input.resource ?? {};
    const matchingRule = [...policy.rules]
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
      .find((rule) => rule.actions.includes(input.action)
        && subjectMatches(rule, input.principal)
        && resourceMatches(rule, resource));
    if (matchingRule) {
      return decision(
        matchingRule.effect === "allow",
        input.action,
        "explicit_rule",
        policy.revision,
        matchingRule.id,
      );
    }
    if (policy.defaultEffect === "deny" && await hasLegacyCompatibilityGrant(input.companyId, input.principal)) {
      return decision(true, input.action, "legacy_compatibility", policy.revision);
    }
    return decision(policy.defaultEffect === "allow", input.action, "policy_default", policy.revision);
  }

  async function replace(input: {
    companyId: string;
    expectedRevision: number;
    policy: SkillPolicyDocument;
    activity: Omit<LogActivityInput, "companyId" | "action" | "entityType" | "entityId" | "details">;
  }) {
    return db.transaction(async (tx) => {
      const transactionDb = tx as unknown as Db;
      const policy = skillPolicyDocumentSchema.parse(input.policy);
      const existing = await tx
        .select()
        .from(companySkillPolicies)
        .where(eq(companySkillPolicies.companyId, input.companyId))
        .then((rows) => rows[0] ?? null);
      const currentRevision = existing?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        throw conflict("Skill policy revision is stale", {
          code: "skill_policy_revision_conflict",
          expectedRevision: input.expectedRevision,
          currentRevision,
        });
      }
      const nextRevision = currentRevision + 1;
      const values = {
        schemaVersion: policy.schemaVersion,
        revision: nextRevision,
        defaultEffect: policy.defaultEffect,
        rules: policy.rules,
        updatedAt: new Date(),
      };
      if (existing) {
        const updated = await tx
          .update(companySkillPolicies)
          .set(values)
          .where(and(
            eq(companySkillPolicies.companyId, input.companyId),
            eq(companySkillPolicies.revision, currentRevision),
          ))
          .returning({ revision: companySkillPolicies.revision })
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("Skill policy revision is stale", {
            code: "skill_policy_revision_conflict",
            expectedRevision: input.expectedRevision,
          });
        }
      } else {
        const inserted = await tx
          .insert(companySkillPolicies)
          .values({ companyId: input.companyId, ...values })
          .onConflictDoNothing()
          .returning({ revision: companySkillPolicies.revision })
          .then((rows) => rows[0] ?? null);
        if (!inserted) {
          throw conflict("Skill policy revision is stale", {
            code: "skill_policy_revision_conflict",
            expectedRevision: input.expectedRevision,
          });
        }
      }
      await logActivity(transactionDb, {
        ...input.activity,
        companyId: input.companyId,
        action: "company.skill_policy_replaced",
        entityType: "company_skill_policy",
        entityId: input.companyId,
        details: {
          previousRevision: currentRevision,
          newRevision: nextRevision,
          defaultEffect: policy.defaultEffect,
          ruleCount: policy.rules.length,
        },
      });
      return { ...policy, revision: nextRevision, materialized: true } satisfies EffectiveSkillPolicy;
    });
  }

  async function reset(input: {
    companyId: string;
    activity: Omit<LogActivityInput, "companyId" | "action" | "entityType" | "entityId" | "details">;
  }) {
    return db.transaction(async (tx) => {
      const transactionDb = tx as unknown as Db;
      const existing = await tx
        .delete(companySkillPolicies)
        .where(eq(companySkillPolicies.companyId, input.companyId))
        .returning({ revision: companySkillPolicies.revision })
        .then((rows) => rows[0] ?? null);
      if (existing) {
        await logActivity(transactionDb, {
          ...input.activity,
          companyId: input.companyId,
          action: "company.skill_policy_reset",
          entityType: "company_skill_policy",
          entityId: input.companyId,
          details: { previousRevision: existing.revision, newRevision: 0 },
        });
      }
      return { ...OPEN_DEFAULT_POLICY, rules: [] };
    });
  }

  return { get, resolveAgentPrincipal, evaluate, replace, reset };
}
