import { z } from "zod";

export const missionStatusSchema = z.enum(["draft", "active", "paused", "completed", "failed"]);
export const autonomyLevelSchema = z.enum(["assisted", "copilot", "autopilot"]);
export const riskTierSchema = z.enum(["green", "yellow", "red"]);
export const digestScheduleSchema = z.enum(["realtime", "hourly", "daily", "weekly"]);

export const createMissionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  objectives: z.array(z.string().min(1)).min(1).max(10),
  autonomyLevel: autonomyLevelSchema.default("copilot"),
  budgetCapUsd: z.number().positive().optional(),
  digestSchedule: digestScheduleSchema.default("daily"),
  expiresAt: z.string().datetime().optional(),
});

export const updateMissionSchema = createMissionSchema.partial().extend({
  status: missionStatusSchema.optional(),
});

export const createApprovalRuleSchema = z.object({
  actionType: z.string().min(1),
  riskTier: riskTierSchema,
  autoApproveAfterMin: z.number().int().positive().optional(),
});

export const createNotificationChannelSchema = z.object({
  channelType: z.enum(["telegram", "slack", "email", "webpush", "webhook"]),
  config: z.record(z.string()),
  triggers: z.array(z.string()).default(["approval_required", "digest"]),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(1),
});

export type CreateMission = z.infer<typeof createMissionSchema>;
export type UpdateMission = z.infer<typeof updateMissionSchema>;
export type MissionStatus = z.infer<typeof missionStatusSchema>;
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;
export type RiskTier = z.infer<typeof riskTierSchema>;
