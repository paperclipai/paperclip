import { z } from "zod";

export const agentSkillStateSchema = z.enum([
  "available",
  "configured",
  "installed",
  "missing",
  "stale",
  "external",
]);

export const agentSkillOriginSchema = z.enum([
  "company_managed",
  "paperclip_required",
  "user_installed",
  "external_unknown",
]);

export const agentSkillSyncModeSchema = z.enum([
  "unsupported",
  "persistent",
  "ephemeral",
]);

export const agentSkillEntrySchema = z.object({
  key: z.string().min(1),
  runtimeName: z.string().min(1).nullable(),
  desired: z.boolean(),
  managed: z.boolean(),
  required: z.boolean().optional(),
  requiredReason: z.string().nullable().optional(),
  state: agentSkillStateSchema,
  origin: agentSkillOriginSchema.optional(),
  originLabel: z.string().nullable().optional(),
  locationLabel: z.string().nullable().optional(),
  readOnly: z.boolean().optional(),
  sourcePath: z.string().nullable().optional(),
  targetPath: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
});

export const agentSkillSnapshotSchema = z.object({
  adapterType: z.string().min(1),
  supported: z.boolean(),
  mode: agentSkillSyncModeSchema,
  desiredSkills: z.array(z.string().min(1)),
  entries: z.array(agentSkillEntrySchema),
  warnings: z.array(z.string()),
});

export const agentSkillSyncSchema = z.object({
  desiredSkills: z.array(z.string().min(1)),
});

export type AgentSkillSync = z.infer<typeof agentSkillSyncSchema>;
