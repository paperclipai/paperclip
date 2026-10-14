import { z } from "zod";
export const taskWorkspaceSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task_directory") }).strict(),
  z.object({ kind: z.literal("existing"), workspaceId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("configured_source"), projectWorkspaceId: z.string().uuid(), mode: z.enum(["shared", "managed_isolated"]) }).strict(),
]);
export const taskWorkspaceIntentSchema = z.object({
  version: z.literal(1), request: z.object({ key: z.string().min(1).max(200), expectedBindingRevision: z.number().int().nonnegative() }).strict().optional(), selection: taskWorkspaceSelectionSchema,
  source: z.enum(["explicit", "parent", "channel", "project", "operator_cwd", "task_default", "legacy"]),
}).strict();
export const selectTaskWorkspaceSchema = z.object({
  selection: taskWorkspaceSelectionSchema,
  expectedBindingRevision: z.number().int().nonnegative(),
  requestKey: z.string().trim().min(1).max(200),
}).strict();
