/**
 * Plan 3 v2 organisation — guild skill validators.
 *
 * Guild skills are knowledge notes written by ephemeral workers under a
 * persistent guild identity. Distinct from `companySkillSchema` which
 * describes the upstream skill catalog (skills.sh / github references
 * installed onto agents). These two concepts coexist; do not conflate.
 */
import { z } from "zod";

export const guildSkillProvenanceSchema = z.enum(["provisional", "canonical"]);

export const guildSkillSchema = z.object({
  id: z.string().uuid(),
  guildId: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string(),
  body: z.string(),
  provenance: guildSkillProvenanceSchema,
  createdByRunId: z.string().uuid().nullable(),
  successCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  retiredAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

// Workers write skills via this shape. Provenance is always
// "provisional" on creation; the API ignores any client-supplied
// provenance to prevent a worker from minting canonical skills.
export const guildSkillCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    // Short kebab-case slug, matching what workers are instructed to
    // write in /tmp/learnings.json. Allow lowercase letters, digits,
    // and hyphens; reject everything else so we don't end up with
    // ambiguous variants of the same skill.
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, {
      message: "name must be lowercase kebab-case (letters, digits, hyphens)",
    }),
  body: z.string().min(1).max(8192),
  createdByRunId: z.string().uuid().nullable().optional(),
});

export const guildSkillUpdateSchema = z.object({
  body: z.string().min(1).max(8192).optional(),
});

export const guildSkillRecordUseSchema = z.object({
  success: z.boolean(),
  runId: z.string().uuid(),
});

export const guildSkillListQuerySchema = z.object({
  provenance: guildSkillProvenanceSchema.optional(),
  // Filter out retired skills by default — the operator can still see
  // them by passing includeRetired=true.
  includeRetired: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type GuildSkill = z.infer<typeof guildSkillSchema>;
export type GuildSkillCreate = z.infer<typeof guildSkillCreateSchema>;
export type GuildSkillUpdate = z.infer<typeof guildSkillUpdateSchema>;
export type GuildSkillRecordUse = z.infer<typeof guildSkillRecordUseSchema>;
export type GuildSkillListQuery = z.infer<typeof guildSkillListQuerySchema>;
export type GuildSkillProvenance = z.infer<typeof guildSkillProvenanceSchema>;
