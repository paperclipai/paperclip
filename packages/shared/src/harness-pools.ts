import { z } from "zod";
import { aiConnectionBindingSchema } from "./ai-connections.js";
import { aiConnectionPoolConfigSchema, type AiConnectionPoolConfig } from "./ai-connection-router.js";

export const HARNESS_POOL_TEMPLATES = ["Smart", "Mid", "Cheap"] as const;
export const harnessPoolBindingSchema = z.object({ poolId: z.string().uuid() }).strict();
export type HarnessPoolBinding = z.infer<typeof harnessPoolBindingSchema>;

export const harnessPoolMemberSchema = z.object({
  id: z.string().uuid(),
  harness: z.object({ type: z.enum(["claude_code", "codex", "grok", "opencode"]) }).strict(),
  connection: aiConnectionBindingSchema.refine(v => v.mode !== "responsible_user", "Select an explicit account grant"),
  model: z.string().trim().min(1).max(256),
  effort: z.string().trim().min(1).max(32).optional(),
}).strict();
export type HarnessPoolMemberV2 = z.infer<typeof harnessPoolMemberSchema>;

export const harnessPoolConfigSchema = z.object({
  schemaVersion: z.literal(2), kind: z.literal("harness_pool"),
  name: z.string().trim().min(1).max(160), enabled: z.boolean(), mode: z.literal("failover"),
  members: z.array(harnessPoolMemberSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>(), configurations = new Set<string>();
  value.members.forEach((member, index) => {
    const key = JSON.stringify([member.harness.type, member.connection, member.model, member.effort ?? null]);
    if (ids.has(member.id) || configurations.has(key)) ctx.addIssue({ code: "custom", path: ["members", index], message: "Duplicate pool member" });
    ids.add(member.id); configurations.add(key);
  });
});
export type HarnessPoolConfigV2 = z.infer<typeof harnessPoolConfigSchema>;
export interface HarnessPool extends HarnessPoolConfigV2 { id: string; companyId: string; revision: number }
export interface HarnessPoolExecutionSelection {
  schemaVersion: 2; poolId: string; poolRevision: number; memberId: string;
  memberSnapshot: HarnessPoolMemberV2; fingerprint: string;
}

export function harnessPoolToRuntimeConfig(input: HarnessPoolConfigV2): AiConnectionPoolConfig {
  const config = harnessPoolConfigSchema.parse(input);
  return aiConnectionPoolConfigSchema.parse({ schemaVersion: 2, kind: "harness_pool", name: config.name,
    enabled: config.enabled, mode: config.mode, thresholdPercent: 90,
    members: config.members.map(member => ({ id: member.id, binding: member.connection,
      profile: { provider: ["claude_code", "grok"].includes(member.harness.type) ? "acpx" : member.harness.type,
        ...(["claude_code", "grok"].includes(member.harness.type) ? { acpxAgent: member.harness.type === "claude_code" ? "claude" : "grok" } : {}),
        model: member.model, ...(member.effort ? { effort: member.effort } : {}) } })) });
}

export function decodeHarnessPoolConfig(raw: unknown):
  { kind: "legacy"; config: AiConnectionPoolConfig } | { kind: "harness_pool"; config: HarnessPoolConfigV2 } {
  const stored = aiConnectionPoolConfigSchema.parse(raw);
  if (stored.kind !== "harness_pool") return { kind: "legacy", config: stored };
  return { kind: "harness_pool", config: harnessPoolConfigSchema.parse({ schemaVersion: 2, kind: "harness_pool",
    name: stored.name, enabled: stored.enabled, mode: stored.mode,
    members: stored.members.map(member => ({ id: member.id, connection: member.binding,
      harness: { type: member.profile.provider === "acpx" ? member.profile.acpxAgent === "claude" ? "claude_code" : "grok" : member.profile.provider },
      model: member.profile.model, ...(member.profile.effort ? { effort: member.profile.effort } : {}) })) }) };
}
