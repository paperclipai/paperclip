import { z } from "zod";
import { aiConnectionBindingSchema, type AiConnectionBinding } from "./ai-connections.js";
import type { AiConnectionUsage } from "./ai-connection-usage.js";

export const BUILTIN_AI_FAILOVER_ROUTER_KEY = "paperclip.builtin.ordered-failover";

export const aiConnectionRouterBindingSchema = z.object({
  mode: z.literal("router"),
  connectionId: z.string().uuid(),
}).strict();
export const aiRuntimeConnectionBindingSchema = z.union([aiConnectionBindingSchema, aiConnectionRouterBindingSchema]);
export type AiRuntimeConnectionBinding = z.infer<typeof aiRuntimeConnectionBindingSchema>;

export const harnessPoolAdapterConfigSchema = z.object({
  engine: z.enum(["auto", "cli", "acp"]).optional(),
  mode: z.enum(["persistent", "oneshot"]).optional(),
  nonInteractivePermissions: z.enum(["deny", "fail"]).optional(),
  warmHandleIdleMs: z.number().int().min(0).max(86_400_000).optional(),
  idleTimeoutMs: z.number().int().min(0).max(86_400_000).optional(),
  timeoutSec: z.number().int().min(0).max(86_400).optional(),
  graceSec: z.number().int().min(0).max(86_400).optional(),
  maxTurnsPerRun: z.number().int().min(0).max(100_000).optional(),
  profileImportMode: z.enum(["off", "copy", "cache"]).optional(),
  profileSourceDir: z.string().trim().max(4096).optional(),
  transcriptRetentionEnabled: z.boolean().optional(),
  transcriptRetentionDays: z.number().int().positive().optional(),
  chrome: z.boolean().optional(), fastMode: z.boolean().optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
  dangerouslyBypassApprovalsAndSandbox: z.boolean().optional(),
  permissionMode: z.enum(["default", "approve-all", "approve-reads", "deny-all"]).optional(),
  codexPermissionMode: z.literal("never").optional(),
  acpxPermissionMode: z.enum(["approve-all", "approve-paperclip", "approve-reads", "deny-all"]).optional(),
  opencodePermissionMode: z.enum(["allow", "ask", "deny"]).optional(),
  lifecycleMode: z.enum(["warm", "per_turn"]).optional(),
}).strict();

export function harnessPoolRuntimeConfigKeys(harness: "claude_code" | "codex" | "grok" | "opencode", runner: "legacy" | "paperclip" = "paperclip"): readonly string[] {
  const common = ["timeoutSec", "graceSec"];
  const native = ["lifecycleMode", "idleTimeoutMs", harness === "codex" ? "codexPermissionMode" : harness === "opencode" ? "opencodePermissionMode" : "acpxPermissionMode"];
  const legacy = harness === "claude_code" ? ["engine", "mode", "nonInteractivePermissions", "warmHandleIdleMs", "permissionMode", "chrome", "maxTurnsPerRun", "dangerouslySkipPermissions", "profileImportMode", "profileSourceDir", "transcriptRetentionEnabled", "transcriptRetentionDays"]
    : harness === "codex" ? ["engine", "mode", "nonInteractivePermissions", "warmHandleIdleMs", "fastMode", "dangerouslyBypassApprovalsAndSandbox"]
    : harness === "opencode" ? ["dangerouslySkipPermissions"] : [];
  return [...common, ...(runner === "legacy" ? legacy : native)];
}

export function invalidHarnessPoolRuntimeSetting(
  member: { runner?: "legacy" | "paperclip"; adapterConfig?: z.infer<typeof harnessPoolAdapterConfigSchema> },
  harness: "claude_code" | "codex" | "grok" | "opencode",
): string | undefined {
  if (member.runner === "legacy" && member.adapterConfig?.engine === "cli" && member.adapterConfig.permissionMode !== undefined) return "permissionMode";
  const allowed = new Set(harnessPoolRuntimeConfigKeys(harness, member.runner));
  return Object.keys(member.adapterConfig ?? {}).find(key => !allowed.has(key));
}

export const aiConnectionPoolMemberSchema = z.object({
  id: z.string().uuid(),
  runner: z.enum(["legacy", "paperclip"]).optional(),
  adapterConfig: harnessPoolAdapterConfigSchema.optional(),
  binding: aiConnectionBindingSchema.refine((v) => v.mode !== "responsible_user", "Select an explicit account grant"),
  profile: z.object({
    provider: z.enum(["codex", "acpx", "opencode"]),
    acpxAgent: z.enum(["claude", "grok"]).optional(),
    model: z.string().trim().min(1).max(256),
    effort: z.string().trim().min(1).max(32).optional(),
  }).strict(),
}).strict().superRefine((member, ctx) => {
  const harness = member.profile.provider === "acpx" ? member.profile.acpxAgent === "claude" ? "claude_code" : "grok" : member.profile.provider;
  const invalid = invalidHarnessPoolRuntimeSetting(member, harness);
  if (invalid) ctx.addIssue({ code: "custom", path: ["adapterConfig", invalid], message: "This setting is unavailable for the selected harness and runner" });
});
export const aiConnectionPoolConfigSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  kind: z.literal("harness_pool").optional(),
  name: z.string().trim().min(1).max(160),
  enabled: z.boolean().default(false),
  mode: z.enum(["round_robin", "usage_aware", "failover"]).default("round_robin"),
  thresholdPercent: z.number().int().min(1).max(100).default(90),
  members: z.array(aiConnectionPoolMemberSchema).min(1).max(100),
}).strict().superRefine((v, ctx) => {
  const ids = new Set<string>();
  const grants = new Set<string>();
  const connections = new Set<string>();
  const configurations = new Set<string>();
  if ((v.schemaVersion === 2) !== (v.kind === "harness_pool") || (v.kind === "harness_pool" && v.mode !== "failover"))
    ctx.addIssue({ code: "custom", message: "Invalid versioned harness pool" });
  for (const [index, member] of v.members.entries()) {
    if (v.kind !== "harness_pool" && (member.runner !== undefined || member.adapterConfig !== undefined)) ctx.addIssue({ code: "custom", path: ["members", index], message: "Runtime settings require a versioned harness pool" });
    const grant = `${member.binding.connectionId}:${member.binding.grantId}`;
    const configuration = JSON.stringify([member.binding, member.profile, member.runner ?? null, member.adapterConfig ?? null]);
    if (ids.has(member.id) || (v.kind === "harness_pool" ? configurations.has(configuration) : grants.has(grant) || connections.has(member.binding.connectionId))) ctx.addIssue({ code: "custom", path: ["members", index], message: "Duplicate pool member" });
    configurations.add(configuration);
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
  runnerScope?: { environmentId: string | null };
  /** Execution harness selected by the host; absent on pre-upgrade allocations. */
  adapterType?: string;
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
