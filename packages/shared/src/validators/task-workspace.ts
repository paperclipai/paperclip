import { z } from "zod";
export const listTaskWorkspacesSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
}).strict();

export const executionWorkspaceSummaryPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(101).default(51),
  cursor: z.string().uuid().optional(),
}).strict();

export const taskWorkspaceSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task_directory") }).strict(),
  z.object({ kind: z.literal("existing"), workspaceId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("configured_source"), projectWorkspaceId: z.string().uuid(), mode: z.enum(["shared", "managed_isolated"]) }).strict(),
]);
export const taskWorkspaceIntentSchema = z.object({
  version: z.literal(1), request: z.object({ key: z.string().min(1).max(200), expectedBindingRevision: z.number().int().nonnegative() }).strict().optional(), selection: taskWorkspaceSelectionSchema,
  source: z.enum(["explicit", "parent", "channel", "project", "operator_cwd", "task_default", "legacy", "recovery"]),
}).strict();
export const selectTaskWorkspaceSchema = z.object({
  selection: taskWorkspaceSelectionSchema,
  expectedBindingRevision: z.number().int().nonnegative(),
  requestKey: z.string().trim().min(1).max(200),
}).strict();
