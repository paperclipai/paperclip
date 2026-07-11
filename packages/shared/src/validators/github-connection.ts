import { z } from "zod";

const hostnameSchema = z.string().trim().min(1).max(253).refine(
  (value) => !value.includes("://") && !value.includes("/") && !/\s/.test(value),
  "Hostname must not include a protocol, path, or spaces",
);

export const createGithubConnectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  hostname: hostnameSchema.optional().default("github.com"),
  secretId: z.string().uuid(),
  enabled: z.boolean().optional().default(true),
}).strict();

export const updateGithubConnectionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  hostname: hostnameSchema.optional(),
  secretId: z.string().uuid().optional(),
  enabled: z.boolean().optional(),
}).strict();

export type CreateGithubConnection = z.infer<typeof createGithubConnectionSchema>;
export type UpdateGithubConnection = z.infer<typeof updateGithubConnectionSchema>;
