import { z } from "zod";

export const SCOPE_GUARD_TIERS = ["hard", "post-hoc", "advisory"] as const;
export type ScopeGuardTier = (typeof SCOPE_GUARD_TIERS)[number];

const TierSchema = z.enum(SCOPE_GUARD_TIERS);

// ── Git class schemas ────────────────────────────────────────────────────────

const GitNoMergeSchema = z.object({
  class: z.literal("git.no_merge"),
  tier: z.literal("hard"),
  protectedBranches: z.array(z.string()).optional(),
});

const GitNoPushSchema = z.object({
  class: z.literal("git.no_push"),
  tier: z.literal("hard"),
  remotes: z.array(z.string()).optional(),
});

const GitNoForcePushSchema = z.object({
  class: z.literal("git.no_force_push"),
  tier: z.literal("hard"),
  remotes: z.array(z.string()).optional(),
});

const GitProtectedBranchSchema = z.object({
  class: z.literal("git.protected_branch"),
  tier: z.literal("hard"),
  protectedBranches: z.array(z.string()).min(1),
});

const GitNoRemoteChangeSchema = z.object({
  class: z.literal("git.no_remote_change"),
  tier: z.literal("hard"),
});

// ── Filesystem class schemas ─────────────────────────────────────────────────

const FsNoTouchPathSchema = z.object({
  class: z.literal("fs.no_touch_path"),
  tier: z.literal("hard"),
  paths: z.array(z.string()).min(1),
});

const FsRepoIsolationSchema = z.object({
  class: z.literal("fs.repo_isolation"),
  tier: z.literal("hard"),
  allowedPaths: z.array(z.string()).optional(),
});

// ── Protocol class schemas ───────────────────────────────────────────────────

const ProtocolTelegramReplySchema = z.object({
  class: z.literal("protocol.telegram_reply"),
  tier: z.literal("post-hoc"),
});

const ProtocolCommentFormatSchema = z.object({
  class: z.literal("protocol.comment_format"),
  tier: z.literal("post-hoc"),
  requiredReviewerTag: z.string().optional(),
});

// ── Interaction class schemas ────────────────────────────────────────────────

const InteractionNoBlockingToolsSchema = z.object({
  class: z.literal("interaction.no_blocking_tools"),
  tier: z.literal("advisory"),
  tools: z.array(z.string()).optional(),
});

const InteractionNoCrossCompanyCommentSchema = z.object({
  class: z.literal("interaction.no_cross_company_comment"),
  tier: z.literal("hard"),
});

// ── Secrets class schemas ────────────────────────────────────────────────────

const SecretsNoCredentialReadSchema = z.object({
  class: z.literal("secrets.no_credential_read"),
  tier: z.literal("hard"),
  paths: z.array(z.string()).optional(),
});

// ── Time class schemas ───────────────────────────────────────────────────────

const TimeBudgetCapSchema = z.object({
  class: z.literal("time.budget_cap"),
  tier: z.literal("post-hoc"),
  heartbeats: z.number().int().positive(),
});

// ── Discriminated union of all known classes ─────────────────────────────────

export const ScopeGuardRuleSchema = z.discriminatedUnion("class", [
  GitNoMergeSchema,
  GitNoPushSchema,
  GitNoForcePushSchema,
  GitProtectedBranchSchema,
  GitNoRemoteChangeSchema,
  FsNoTouchPathSchema,
  FsRepoIsolationSchema,
  ProtocolTelegramReplySchema,
  ProtocolCommentFormatSchema,
  InteractionNoBlockingToolsSchema,
  InteractionNoCrossCompanyCommentSchema,
  SecretsNoCredentialReadSchema,
  TimeBudgetCapSchema,
]);

export type ScopeGuardRule = z.infer<typeof ScopeGuardRuleSchema>;

export const KNOWN_SCOPE_GUARD_CLASSES = [
  "git.no_merge",
  "git.no_push",
  "git.no_force_push",
  "git.protected_branch",
  "git.no_remote_change",
  "fs.no_touch_path",
  "fs.repo_isolation",
  "protocol.telegram_reply",
  "protocol.comment_format",
  "interaction.no_blocking_tools",
  "interaction.no_cross_company_comment",
  "secrets.no_credential_read",
  "time.budget_cap",
] as const;

export type KnownScopeGuardClass = (typeof KNOWN_SCOPE_GUARD_CLASSES)[number];

export function parseRule(raw: unknown): ScopeGuardRule {
  return ScopeGuardRuleSchema.parse(raw);
}

export function isKnownClass(cls: string): cls is KnownScopeGuardClass {
  return (KNOWN_SCOPE_GUARD_CLASSES as readonly string[]).includes(cls);
}
