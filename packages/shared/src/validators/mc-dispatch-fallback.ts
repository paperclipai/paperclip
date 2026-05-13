import { z } from "zod";

/**
 * mc-dispatch-fallback request schema — Jarvis-OS Phase-4 4c.
 *
 * Paperclip received-fallback API; called by a Hermes-Health observer when
 * Hermes is detected down for >= threshold and an issue is fallback-eligible.
 *
 * In Wave 1 (Phase-4 4c-3 stub) the receiver records the decision but does
 * NOT spawn an MC dispatcher process. mc-spawn-integration is gated behind
 * 4c-2 Marco-Decisions + 4c-5 production-smoke.
 */
export const requestMcDispatchFallbackSchema = z.object({
  companyId: z.string().uuid(),
  issueId: z.string().uuid(),
  issueRunId: z.string().uuid().optional().nullable(),
  fallbackFrom: z.literal("hermes"),
  reason: z.string().min(1).max(256),
  hermesHealthSnapshot: z.record(z.unknown()).optional(),
  dryRun: z.boolean().default(true),
});

export type RequestMcDispatchFallback = z.infer<typeof requestMcDispatchFallbackSchema>;

export const mcDispatchFallbackOutcomes = [
  "accepted-dry-run",
  "accepted-spawned",
  "rejected-hold-and-alert",
  "rejected-lock-active",
  "rejected-issue-blocked",
  "rejected-skill-hermes-only",
] as const;
export type McDispatchFallbackOutcome = (typeof mcDispatchFallbackOutcomes)[number];

export const mcDispatchFallbackResponseSchema = z.object({
  accepted: z.boolean(),
  mode: z.literal("mc-dispatch"),
  outcome: z.enum(mcDispatchFallbackOutcomes),
  legacyTaskId: z.string().nullable(),
  issueRunId: z.string().nullable(),
  warnings: z.array(z.string()),
});

export type McDispatchFallbackResponse = z.infer<typeof mcDispatchFallbackResponseSchema>;
