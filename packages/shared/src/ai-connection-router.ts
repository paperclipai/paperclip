import { z } from "zod";
import { aiConnectionBindingSchema, type AiConnectionBinding } from "./ai-connections.js";
import type { AiConnectionUsage } from "./ai-connection-usage.js";

export const aiConnectionRouterBindingSchema = z.object({
  mode: z.literal("router"),
  connectionId: z.string().uuid(),
}).strict();
export const aiRuntimeConnectionBindingSchema = z.union([aiConnectionBindingSchema, aiConnectionRouterBindingSchema]);
export type AiRuntimeConnectionBinding = z.infer<typeof aiRuntimeConnectionBindingSchema>;

export const aiConnectionPoolMemberSchema = z.object({
  id: z.string().uuid(),
  binding: aiConnectionBindingSchema.refine((v) => v.mode !== "responsible_user", "Select an explicit account grant"),
  profile: z.object({
    provider: z.enum(["codex", "acpx", "opencode"]),
    acpxAgent: z.enum(["claude", "grok"]).optional(),
    model: z.string().trim().min(1).max(256),
    effort: z.string().trim().min(1).max(32).optional(),
  }).strict(),
}).strict();
export const aiConnectionPoolConfigSchema = z.object({
  name: z.string().trim().min(1).max(160),
  enabled: z.boolean().default(false),
  mode: z.enum(["round_robin", "usage_aware"]).default("round_robin"),
  thresholdPercent: z.number().int().min(1).max(100).default(90),
  members: z.array(aiConnectionPoolMemberSchema).min(1).max(100),
}).strict().superRefine((v, ctx) => {
  const ids = new Set<string>();
  const grants = new Set<string>();
  const connections = new Set<string>();
  for (const [index, member] of v.members.entries()) {
    const grant = `${member.binding.connectionId}:${member.binding.grantId}`;
    if (ids.has(member.id) || grants.has(grant) || connections.has(member.binding.connectionId)) ctx.addIssue({ code: "custom", path: ["members", index], message: "Duplicate pool member" });
    ids.add(member.id); grants.add(grant); connections.add(member.binding.connectionId);
    if (member.profile.provider === "acpx" && !member.profile.acpxAgent) ctx.addIssue({ code: "custom", path: ["members", index, "profile"], message: "Choose an ACP harness" });
  }
});
export type AiConnectionPoolMember = z.infer<typeof aiConnectionPoolMemberSchema>;
export type AiConnectionPoolConfig = z.infer<typeof aiConnectionPoolConfigSchema>;
export interface AiConnectionPool extends AiConnectionPoolConfig {
  id: string;
  companyId: string;
  pluginKey: string;
  revision: number;
}
/** Host-authorized metadata only. No credentials or raw provider responses. */
export interface AiConnectionRouterRequest {
  companyId: string;
  pool: AiConnectionPool;
  agentId: string;
  taskKey: string;
  lastMemberId: string | null;
  cursorVersion: number;
  /** Opaque IDs preserve order without exposing unauthorized account metadata. */
  memberOrder: string[];
  pinnedMemberId?: string;
  candidates: Array<{ member: AiConnectionPoolMember; runtimeConfig: Record<string, unknown>; notes: string[]; usage?: AiConnectionUsage }>;
  now: string;
}
export type AiConnectionRouterResult =
  | { kind: "selected"; memberId: string; skipped?: Record<string, string> }
  | { kind: "exhausted"; retryAt: string; skipped: Record<string, string> }
  | { kind: "unavailable"; skipped: Record<string, string> };
export interface AiConnectionPoolSaveInput {
  companyId: string;
  id?: string;
  expectedRevision?: number;
  config: AiConnectionPoolConfig;
}
export interface AiConnectionRouterSelection {
  poolId: string;
  memberId: string;
  binding: AiConnectionBinding;
  runtimeConfig: Record<string, unknown>;
  notes: string[];
}

/** Stable, collision-free catalog identity across plugin reinstallations. */
export function aiConnectionRouterSlug(pluginKey: string): string {
  return `ai-router-${Array.from(pluginKey, character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;
}

export function aiConnectionRouterAppDefinition(pluginKey: string, descriptor: { name: string; description: string }, availability = { available: true } as { available: boolean; reason?: string }): import("./types/app-definition.js").AppDefinition {
  return {
    schemaVersion: 1, slug: aiConnectionRouterSlug(pluginKey), ...descriptor,
    categories: ["ai"], branding: { logoUrl: "/brands/apps/connection-pool.svg" }, urlPatterns: [],
    aiConnectionRouter: { pluginKey }, availability,
    methods: [],
  };
}

export function aiConnectionRouterPluginKey(connection: { config?: Record<string, unknown> | null }): string | null {
  const router = connection.config?.aiRouter;
  return router && typeof router === "object" && "pluginKey" in router && typeof router.pluginKey === "string" ? router.pluginKey : null;
}
