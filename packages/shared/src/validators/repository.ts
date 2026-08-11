import { z } from "zod";
import {
  REPOSITORY_CONNECTION_STATUSES,
  REPOSITORY_PROVIDERS,
  REPOSITORY_STATES,
  REPOSITORY_SYNC_STATUSES,
  REPOSITORY_VISIBILITIES,
} from "../constants.js";

export const repositoryProviderSchema = z.union([
  z.enum(REPOSITORY_PROVIDERS),
  z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
]);
export const repositoryStateSchema = z.enum(REPOSITORY_STATES);
export const repositoryVisibilitySchema = z.enum(REPOSITORY_VISIBILITIES);
export const repositoryConnectionStatusSchema = z.enum(REPOSITORY_CONNECTION_STATUSES);
export const repositorySyncStatusSchema = z.enum(REPOSITORY_SYNC_STATUSES);

export const repositoryLocatorSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => !/\s/.test(value), "Repository URL cannot contain whitespace");

export const createManualRepositorySchema = z.object({
  cloneUrl: repositoryLocatorSchema,
  webUrl: z.string().url().max(2048).optional().nullable(),
  defaultBranch: z.string().trim().min(1).max(255).optional().nullable(),
  visibility: repositoryVisibilitySchema.optional().default("unknown"),
}).strict();

export const updateRepositorySchema = z.object({
  cloneUrl: repositoryLocatorSchema.optional(),
  webUrl: z.string().url().max(2048).optional().nullable(),
  defaultBranch: z.string().trim().min(1).max(255).optional().nullable(),
  visibility: repositoryVisibilitySchema.optional(),
}).strict();

export const createRepositoryConnectionSchema = z.object({
  provider: repositoryProviderSchema,
  host: z.string().trim().min(1).max(255),
  installationId: z.string().trim().min(1).max(512).optional().nullable(),
  accountId: z.string().trim().min(1).max(512).optional().nullable(),
  accountName: z.string().trim().min(1).max(512).optional().nullable(),
}).strict();

export const attachProjectRepositorySchema = z.object({
  displayOrder: z.number().int().min(0).max(1_000_000).optional().default(0),
}).strict();

export const grantAgentRepositorySchema = z.object({}).strict();

const connectionRedirectPathSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => value.startsWith("/") && !value.startsWith("//"), "redirectPath must be an app-relative path");

export const beginRepositoryConnectionSchema = z.object({
  redirectPath: connectionRedirectPathSchema.optional().nullable(),
}).strict();

export const completeRepositoryConnectionSchema = z.object({
  state: z.string().min(1).max(8192),
  installationId: z.string().trim().min(1).max(512),
}).strict();

export const importRepositoriesSchema = z.object({
  providerRepositoryIds: z.array(z.string().trim().min(1).max(512)).min(1).max(200),
}).strict();

export type CreateManualRepository = z.infer<typeof createManualRepositorySchema>;
export type UpdateRepository = z.infer<typeof updateRepositorySchema>;
export type CreateRepositoryConnection = z.infer<typeof createRepositoryConnectionSchema>;
export type AttachProjectRepository = z.infer<typeof attachProjectRepositorySchema>;
export type BeginRepositoryConnection = z.infer<typeof beginRepositoryConnectionSchema>;
export type CompleteRepositoryConnection = z.infer<typeof completeRepositoryConnectionSchema>;
export type ImportRepositories = z.infer<typeof importRepositoriesSchema>;
export type GrantAgentRepository = z.infer<typeof grantAgentRepositorySchema>;
