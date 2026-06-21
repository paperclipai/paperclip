import { eq } from "drizzle-orm";
import { companyModelPolicies } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { ModelPolicyRule } from "./model-policy.js";
import { parseModelPolicyRules } from "./model-policy-schema.js";
import { getCompanyModelPolicy as getEnvCompanyModelPolicy } from "./model-policy-config.js";

const CACHE_TTL_MS = 30_000;

export function companyModelPolicyService(db: Db) {
  const cache = new Map<string, { rules: ModelPolicyRule[]; expiresAt: number }>();

  async function readFromDb(companyId: string): Promise<ModelPolicyRule[] | null> {
    const rows = await db
      .select()
      .from(companyModelPolicies)
      .where(eq(companyModelPolicies.companyId, companyId))
      .limit(1);
    if (rows.length === 0) return null;
    try {
      return parseModelPolicyRules(rows[0]!.rules);
    } catch {
      return []; // a corrupt stored value must not break dispatch
    }
  }

  async function getCompanyPolicy(
    companyId: string,
    now = Date.now(),
  ): Promise<ModelPolicyRule[]> {
    const cached = cache.get(companyId);
    if (cached && cached.expiresAt > now) return cached.rules;
    const fromDb = await readFromDb(companyId);
    const rules = fromDb ?? getEnvCompanyModelPolicy(companyId); // env fallback when no DB row
    cache.set(companyId, { rules, expiresAt: now + CACHE_TTL_MS });
    return rules;
  }

  async function setCompanyPolicy(
    companyId: string,
    rawRules: unknown,
  ): Promise<ModelPolicyRule[]> {
    const rules = parseModelPolicyRules(rawRules); // validates; throws on bad shape
    const existing = await db
      .select({ id: companyModelPolicies.id })
      .from(companyModelPolicies)
      .where(eq(companyModelPolicies.companyId, companyId))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(companyModelPolicies).values({ companyId, rules });
    } else {
      await db
        .update(companyModelPolicies)
        .set({ rules, updatedAt: new Date() })
        .where(eq(companyModelPolicies.companyId, companyId));
    }
    cache.delete(companyId); // invalidate
    return rules;
  }

  return { getCompanyPolicy, setCompanyPolicy };
}

export type CompanyModelPolicyService = ReturnType<typeof companyModelPolicyService>;
