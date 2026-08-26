import { z } from "zod";

const nonEmptyUniqueStrings = z.array(z.string().trim().min(1).max(256)).min(1).max(500)
  .refine((values) => new Set(values).size === values.length, "Values must be unique");

// Codex is the first adapter with a protected developer-instruction channel.
// Do not accept a binding that looks applicable but would silently omit the
// overlay for another adapter. Additional adapters must add an explicit,
// tested protected delivery implementation before joining this allowlist.
const protectedGovernanceAdapterTypes = z.array(z.enum(["codex_local", "paperclip_runner"]))
  .min(1)
  .max(2)
  .refine((values) => new Set(values).size === values.length, "Adapter types must be unique");

export const governancePolicyBindingSchema = z.object({
  id: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  effect: z.enum(["include", "exclude"]),
  subject: z.discriminatedUnion("type", [
    z.object({ type: z.literal("all_agents") }).strict(),
    z.object({ type: z.literal("agents"), agentIds: z.array(z.string().uuid()).min(1).max(500) }).strict(),
    z.object({ type: z.literal("roles"), roles: nonEmptyUniqueStrings }).strict(),
  ]),
  scopes: z.array(z.literal("heartbeat")).min(1).max(1),
  adapterTypes: protectedGovernanceAdapterTypes,
  delivery: z.literal("required"),
}).strict();

export const governancePolicyDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  body: z.string().min(1).max(200_000),
  bindings: z.array(governancePolicyBindingSchema).min(1).max(1_000)
    .refine((bindings) => new Set(bindings.map((binding) => binding.id)).size === bindings.length, "Binding IDs must be unique"),
}).strict();

export const replaceGovernancePolicySchema = governancePolicyDocumentSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const restoreGovernancePolicyRevisionSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict();

export type GovernancePolicyBinding = z.infer<typeof governancePolicyBindingSchema>;
export type GovernancePolicyDocument = z.infer<typeof governancePolicyDocumentSchema>;
export type ReplaceGovernancePolicy = z.infer<typeof replaceGovernancePolicySchema>;
export type RestoreGovernancePolicyRevision = z.infer<typeof restoreGovernancePolicyRevisionSchema>;
