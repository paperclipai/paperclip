import { z } from "zod";

export const taskCronIssueModeSchema = z.enum(["create_new", "reuse_existing", "reopen_existing"]);

const cronExpressionSchema = z.string().trim().min(1).max(120);
const timezoneSchema = z.string().trim().min(1).max(120);

export const createTaskCronScheduleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  expression: cronExpressionSchema,
  timezone: timezoneSchema.optional().default("UTC"),
  enabled: z.boolean().optional().default(true),
  issueMode: taskCronIssueModeSchema.optional().default("create_new"),
  issueId: z.string().uuid().optional().nullable(),
  issueTemplate: z.record(z.unknown()).optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
});

export const updateTaskCronScheduleSchema = createTaskCronScheduleSchema.partial();

export const attachTaskCronIssueSchema = z.object({
  issueId: z.string().uuid(),
});

export type CreateTaskCronSchedule = z.infer<typeof createTaskCronScheduleSchema>;
export type UpdateTaskCronSchedule = z.infer<typeof updateTaskCronScheduleSchema>;
export type AttachTaskCronIssue = z.infer<typeof attachTaskCronIssueSchema>;
