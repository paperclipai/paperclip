import { z } from "zod";

const repository = z.object({
  id: z.string().min(1),
  relativePath: z.string().min(1),
  repoUrl: z.string().min(1),
  ref: z.string().nullable(),
  pinnedCommit: z.string().optional(),
  readOnly: z.boolean().optional(),
  projectId: z.string().uuid().nullable().optional(),
  projectWorkspaceId: z.string().uuid().nullable().optional(),
}).strict();

export const remoteWorkspaceSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty"), repositories: z.array(repository).optional() }).strict(),
  z.object({
    kind: z.literal("git"), repoUrl: z.string().min(1), ref: z.string().nullable(),
    branchName: z.string().nullable().optional(),
    // Older recipes create a task branch from ref when branchName is present.
    branchMode: z.enum(["create", "existing"]).optional(),
    repositories: z.array(repository).optional(),
  }).strict(),
]);
export type RemoteWorkspaceSource = z.infer<typeof remoteWorkspaceSourceSchema>;

/** Paths in this record belong to the named remote allocation, never the controller. */
export const remoteWorkspaceAuthoritySchema = z.object({
  schema: z.literal("paperclip.remote-workspace.v1"),
  epoch: z.number().int().positive(),
  snapshotId: z.string().uuid().nullable(),
  source: remoteWorkspaceSourceSchema,
  location: z.object({
    environmentId: z.string().uuid(), leaseId: z.string().uuid(),
    providerLeaseId: z.string().min(1), remoteCwd: z.string().min(1),
  }).strict().nullable(),
  writerRunId: z.string().uuid().nullable(),
  dirty: z.boolean(),
}).strict();
export type RemoteWorkspaceAuthority = z.infer<typeof remoteWorkspaceAuthoritySchema>;

export const remoteWorkspaceRunReferenceSchema = z.object({
  schema: z.literal("paperclip.remote-workspace-run.v1"),
  workspaceId: z.string().uuid(), leaseId: z.string().uuid(), providerLeaseId: z.string().min(1),
  remoteCwd: z.string().min(1), epoch: z.number().int().positive(),
  state: z.enum(["prepared", "saved"]), snapshotId: z.string().uuid().nullable(),
}).strict();
export type RemoteWorkspaceRunReference = z.infer<typeof remoteWorkspaceRunReferenceSchema>;

export function readRemoteWorkspaceRunReference(value: unknown): RemoteWorkspaceRunReference | null {
  if (value === undefined || value === null) return null;
  return remoteWorkspaceRunReferenceSchema.parse(value);
}

export function readRemoteWorkspaceAuthority(metadata: Record<string, unknown> | null | undefined): RemoteWorkspaceAuthority | null {
  const value = metadata?.remoteWorkspace;
  if (value === undefined || value === null) return null;
  return remoteWorkspaceAuthoritySchema.parse(value);
}
