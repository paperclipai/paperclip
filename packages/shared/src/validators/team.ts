import { z } from "zod";

export const TEAM_STATUSES = ["active", "retired", "deleted"] as const;

export const createTeamSchema = z.object({
  name: z.string().min(1),
  identifier: z
    .string()
    .min(2)
    .max(5)
    .regex(/^[A-Z][A-Z0-9]*$/, "Identifier must start with uppercase letter, allow A-Z and 0-9 (2-5 chars)"),
  description: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  leadAgentId: z.string().uuid().optional().nullable(),
  leadUserId: z.string().optional().nullable(),
  settings: z.record(z.unknown()).optional(),
});

export type CreateTeam = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = createTeamSchema.partial().omit({ identifier: true });

export type UpdateTeam = z.infer<typeof updateTeamSchema>;

export const addTeamMemberSchema = z.object({
  agentId: z.string().uuid().optional(),
  userId: z.string().optional(),
  role: z.enum(["lead", "member"]).optional().default("member"),
});

export type AddTeamMember = z.infer<typeof addTeamMemberSchema>;

export const upsertTeamDocumentSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "key must be lowercase slug"),
  title: z.string().max(200).optional().nullable(),
  format: z.string().optional().default("markdown"),
  body: z.string(),
  changeSummary: z.string().max(500).optional().nullable(),
  baseRevisionId: z.string().uuid().optional().nullable(),
});
export type UpsertTeamDocument = z.infer<typeof upsertTeamDocumentSchema>;
