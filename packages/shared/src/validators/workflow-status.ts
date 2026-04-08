import { z } from "zod";

export const WORKFLOW_STATUS_CATEGORIES = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;

export type WorkflowStatusCategory = (typeof WORKFLOW_STATUS_CATEGORIES)[number];

export const createWorkflowStatusSchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "slug must be lowercase letters, digits, underscore")
    .optional(),
  category: z.enum(WORKFLOW_STATUS_CATEGORIES),
  color: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  position: z.number().int().optional(),
  isDefault: z.boolean().optional(),
});

export type CreateWorkflowStatus = z.infer<typeof createWorkflowStatusSchema>;

// slug is immutable - omit from update
export const updateWorkflowStatusSchema = createWorkflowStatusSchema
  .partial()
  .omit({ slug: true });

export type UpdateWorkflowStatus = z.infer<typeof updateWorkflowStatusSchema>;

/**
 * Convert a display name into an immutable slug.
 * e.g., "In Progress" → "in_progress"
 */
export function slugifyWorkflowStatusName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "s_$1")
    .slice(0, 64);
}

/**
 * Default workflow statuses seeded when a team is created.
 */
export const DEFAULT_WORKFLOW_STATUSES: Array<{
  name: string;
  slug: string;
  category: WorkflowStatusCategory;
  color: string;
  position: number;
  isDefault: boolean;
}> = [
  { name: "Backlog", slug: "backlog", category: "backlog", color: "#94A3B8", position: 0, isDefault: false },
  { name: "Todo", slug: "todo", category: "unstarted", color: "#64748B", position: 1, isDefault: true },
  { name: "In Progress", slug: "in_progress", category: "started", color: "#3B82F6", position: 2, isDefault: false },
  { name: "Done", slug: "done", category: "completed", color: "#10B981", position: 3, isDefault: false },
  { name: "Canceled", slug: "canceled", category: "canceled", color: "#EF4444", position: 4, isDefault: false },
];
