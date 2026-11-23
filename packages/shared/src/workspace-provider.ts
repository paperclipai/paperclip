import { z } from "zod";

/** Durable addressing only. Credentials and execution-host paths are never part of this record. */
export const workspaceProviderBindingSchema = z
  .object({
    pluginId: z.string().uuid(),
    projectId: z.string().uuid(),
    executionWorkspaceId: z.string().uuid(),
    projectWorkspaceId: z.string().uuid(),
    sourceRevision: z.string().min(1).max(256),
    workspaceRef: z.string().min(1).max(4096),
  })
  .strict();
export type WorkspaceProviderBinding = z.infer<
  typeof workspaceProviderBindingSchema
>;

export function readWorkspaceProviderBinding(
  metadata: Record<string, unknown> | null | undefined,
): WorkspaceProviderBinding | null {
  const parsed = workspaceProviderBindingSchema.safeParse(
    metadata?.workspaceProvider,
  );
  return parsed.success ? parsed.data : null;
}
