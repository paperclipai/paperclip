import { z } from "zod";

export const SKILL_POLICY_ACTIONS = [
  "skills.create",
  "skills.import",
  "skills.install",
  "skills.edit",
  "skills.update",
  "skills.test",
  "skills.reset",
  "skills.remove",
] as const;

export const SKILL_POLICY_SOURCE_TYPES = [
  "workspace",
  "catalog",
  "git",
  "external_package",
  "generated",
  "unknown",
] as const;

export const skillPolicyActionSchema = z.enum(SKILL_POLICY_ACTIONS);
export const skillPolicySourceTypeSchema = z.enum(SKILL_POLICY_SOURCE_TYPES);
export const skillPolicyEffectSchema = z.enum(["allow", "deny"]);

const nonEmptyUniqueStrings = z.array(z.string().trim().min(1).max(512)).min(1).max(500)
  .refine((values) => new Set(values).size === values.length, "Values must be unique");

function isSafeSourceLocator(value: string) {
  if (/:\/\/[^/@\s]+:[^/@\s]+@/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    const credentialParameter = /token|secret|password|api[-_]?key|authorization/i;
    if ([...url.searchParams.keys()].some((key) => credentialParameter.test(key))) return false;
    const fragment = url.hash.slice(1);
    return !/(?:^|[?&;])(?:token|secret|password|api[-_]?key|authorization)=/i.test(fragment);
  } catch {
    return true;
  }
}

const skillPolicySourceLocatorSchema = z.string().trim().min(1).max(2_048)
  .refine(isSafeSourceLocator, "Source locators must not contain credentials or secret query or fragment parameters");

export const skillPolicySubjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all_agents") }).strict(),
  z.object({
    type: z.literal("agents"),
    agentIds: z.array(z.string().uuid()).min(1).max(500)
      .refine((values) => new Set(values).size === values.length, "Agent IDs must be unique"),
  }).strict(),
  z.object({ type: z.literal("roles"), roles: nonEmptyUniqueStrings }).strict(),
]);

export const skillPolicyResourceSelectorSchema = z.object({
  skillIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  skillKeys: nonEmptyUniqueStrings.optional(),
  sourceTypes: z.array(skillPolicySourceTypeSchema).min(1)
    .refine((values) => new Set(values).size === values.length, "Source types must be unique")
    .optional(),
  sourceLocators: z.array(skillPolicySourceLocatorSchema).min(1).max(500)
    .refine((values) => new Set(values).size === values.length, "Source locators must be unique")
    .optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one resource selector is required");

export const skillPolicyRuleSchema = z.object({
  id: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  effect: skillPolicyEffectSchema,
  subject: skillPolicySubjectSchema,
  actions: z.array(skillPolicyActionSchema).min(1)
    .refine((values) => new Set(values).size === values.length, "Actions must be unique"),
  resources: skillPolicyResourceSelectorSchema.optional(),
}).strict();

export const skillPolicyDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  defaultEffect: skillPolicyEffectSchema,
  rules: z.array(skillPolicyRuleSchema).max(1_000)
    .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, "Rule IDs must be unique"),
}).strict();

export const replaceSkillPolicySchema = skillPolicyDocumentSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const skillPolicyEvaluationResourceSchema = z.object({
  skillId: z.string().uuid().optional(),
  skillKey: z.string().trim().min(1).max(512).optional(),
  sourceType: skillPolicySourceTypeSchema.optional(),
  sourceLocator: skillPolicySourceLocatorSchema.optional(),
}).strict();

export const evaluateSkillPolicySchema = z.object({
  action: skillPolicyActionSchema,
  resource: skillPolicyEvaluationResourceSchema.default({}),
  principal: z.object({ agentId: z.string().uuid() }).strict().optional(),
}).strict();

export type SkillPolicyAction = z.infer<typeof skillPolicyActionSchema>;
export type SkillPolicySourceType = z.infer<typeof skillPolicySourceTypeSchema>;
export type SkillPolicyEffect = z.infer<typeof skillPolicyEffectSchema>;
export type SkillPolicySubject = z.infer<typeof skillPolicySubjectSchema>;
export type SkillPolicyResourceSelector = z.infer<typeof skillPolicyResourceSelectorSchema>;
export type SkillPolicyRule = z.infer<typeof skillPolicyRuleSchema>;
export type SkillPolicyDocument = z.infer<typeof skillPolicyDocumentSchema>;
export type ReplaceSkillPolicy = z.infer<typeof replaceSkillPolicySchema>;
export type SkillPolicyEvaluationResource = z.infer<typeof skillPolicyEvaluationResourceSchema>;
export type EvaluateSkillPolicy = z.infer<typeof evaluateSkillPolicySchema>;

export type EffectiveSkillPolicy = SkillPolicyDocument & { revision: number; materialized: boolean };
export type SkillPolicyDecisionReason =
  | "platform_invariant"
  | "no_policy_default"
  | "explicit_rule"
  | "policy_default"
  | "legacy_compatibility";
export type SkillPolicyDecision = {
  allowed: boolean;
  action: SkillPolicyAction;
  reason: SkillPolicyDecisionReason;
  policyRevision: number;
  matchedRuleId: string | null;
  remediation: string | null;
};
